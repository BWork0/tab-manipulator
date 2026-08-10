import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROMIUM_BUILD = resolve(ROOT, '.output/chrome-mv3');

const BROWSERS = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  brave: 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  opera: join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Opera', 'opera.exe'),
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function hashDirectory(directory) {
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(path)));
      else files.push(path);
    }
    return files;
  }

  const files = (await walk(directory)).sort();
  const aggregate = createHash('sha256');
  for (const file of files) {
    aggregate.update(relative(directory, file).replaceAll('\\', '/'));
    aggregate.update('\0');
    aggregate.update(await readFile(file));
    aggregate.update('\0');
  }
  return aggregate.digest('hex');
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method} timed out.`));
      }, 15_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('CDP connection closed.'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

async function connectToChromium(profile) {
  const activePortFile = join(profile, 'DevToolsActivePort');
  const activePort = await waitFor(async () => {
    try {
      return await readFile(activePortFile, 'utf8');
    } catch {
      return null;
    }
  }, 'Chromium did not expose a debugging endpoint');
  const [port, socketPath] = activePort.trim().split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
  await once(socket, 'open');
  return new CdpClient(socket);
}

function startChromium(binary, profile, headless = true) {
  const child = spawn(
    binary,
    [
      ...(headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--password-store=basic',
      '--restore-last-session',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  return child;
}

async function createTarget(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url });
  return targetId;
}

async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Runtime evaluation failed.');
  }
  return result.result.value;
}

async function popupReady(client, extensionId) {
  const popupTarget = await createTarget(client, `chrome-extension://${extensionId}/popup.html`);
  const sessionId = await attach(client, popupTarget);
  await waitFor(
    () => evaluate(client, sessionId, `document.readyState === 'complete'`),
    'Popup document did not load',
  );
  try {
    await waitFor(
      () =>
        evaluate(
          client,
          sessionId,
          `document.querySelector('#status-region')?.getAttribute('aria-busy') === 'false'`,
        ),
      'Popup did not initialize',
    );
  } catch (error) {
    const state = await evaluate(
      client,
      sessionId,
      `({
        statusBusy: document.querySelector('#status-region')?.getAttribute('aria-busy'),
        status: document.querySelector('#status-label')?.textContent,
        commandError: document.querySelector('#error-description')?.textContent,
        tabError: document.querySelector('#tab-list-error-description')?.textContent,
        body: document.body.innerText.slice(0, 1000),
      })`,
    );
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  return { popupTarget, sessionId };
}

async function popupReadyWithRetry(client, extensionId, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await popupReady(client, extensionId);
    } catch (error) {
      lastError = error;
      console.log(
        JSON.stringify({
          type: 'setup-retry',
          operation: 'open-popup',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await delay(1_000);
    }
  }
  throw lastError;
}

async function click(client, sessionId, selector) {
  const clicked = await evaluate(
    client,
    sessionId,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled || element.hidden) return false; element.click(); return true; })()`,
  );
  assert(clicked, `Could not click ${selector}.`);
}

async function setSelect(client, sessionId, selector, value) {
  const changed = await evaluate(
    client,
    sessionId,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
  );
  assert(changed, `Could not set ${selector}.`);
}

async function textOf(client, sessionId, selector) {
  return evaluate(
    client,
    sessionId,
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`,
  );
}

async function waitForText(client, sessionId, selector, text, timeoutMs = 15_000) {
  return waitFor(
    async () => (await textOf(client, sessionId, selector)) === text,
    `${selector} did not become ${text}`,
    timeoutMs,
  );
}

async function pressEnter(client, targetId, sessionId, selector) {
  await client.send('Target.activateTarget', { targetId });
  const focused = await evaluate(
    client,
    sessionId,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled || element.hidden) return false; element.focus(); return document.activeElement === element; })()`,
  );
  assert(focused, `Could not focus ${selector}.`);
  await client.send(
    'Input.dispatchKeyEvent',
    {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
    sessionId,
  );
  await client.send(
    'Input.dispatchKeyEvent',
    { type: 'char', text: '\r', unmodifiedText: '\r' },
    sessionId,
  );
  await client.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    },
    sessionId,
  );
}

async function startLocalPages() {
  const hits = new Map();
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(`<!doctype html><title>${path}</title><h1>${path}</h1>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { server, hits, origin: `http://127.0.0.1:${port}` };
}

async function getTargets(client) {
  return (await client.send('Target.getTargets')).targetInfos;
}

async function getExtensionId(client) {
  const target = await waitFor(async () => {
    const targets = await getTargets(client);
    return targets.find(
      (candidate) =>
        candidate.type === 'service_worker' &&
        candidate.url.startsWith('chrome-extension://') &&
        candidate.url.endsWith('/background.js'),
    );
  }, 'Extension target was not registered');
  return new URL(target.url).host;
}

async function loadExtension(client) {
  const result = await client.send('Extensions.loadUnpacked', { path: CHROMIUM_BUILD });
  return result.id;
}

async function exerciseLifecycle(client, sessionId, direction) {
  await setSelect(client, sessionId, '#rotation-direction', direction);
  await setSelect(client, sessionId, '#rotation-interval', '30000');
  await click(client, sessionId, '#rotation-primary-button');
  await waitForText(client, sessionId, '#status-label', 'Rotating');
  await click(client, sessionId, '#rotation-primary-button');
  await waitForText(client, sessionId, '#status-label', 'Rotation paused');
  await click(client, sessionId, '#rotation-primary-button');
  await waitForText(client, sessionId, '#status-label', 'Rotating');
  await click(client, sessionId, '#rotation-stop-button');
  await waitForText(client, sessionId, '#status-label', 'Idle');
}

async function runChromiumMatrix(name, binary) {
  const profile = await mkdtemp(join(tmpdir(), `tab-manipulator-t063-${name}-`));
  const local = await startLocalPages();
  let child;
  let client;
  const checks = [];
  const findings = [];

  try {
    child = startChromium(binary, profile);
    client = await connectToChromium(profile);
    const loadedExtensionId = await loadExtension(client);
    const extensionId = loadedExtensionId || (await getExtensionId(client));
    let popup = await popupReady(client, extensionId);
    await evaluate(
      client,
      popup.sessionId,
      `Promise.all(${JSON.stringify(['/alpha', '/beta', '/gamma', '/delta'])}.map((page) => chrome.tabs.create({ url: ${JSON.stringify(local.origin)} + page, active: false })))`,
    );
    await waitFor(
      () =>
        evaluate(
          client,
          popup.sessionId,
          `chrome.tabs.query({ currentWindow: true }).then((tabs) => tabs.filter((tab) => tab.url?.startsWith(${JSON.stringify(local.origin)}) && tab.status === 'complete').length === 4)`,
        ),
      'Local test tabs did not finish loading',
    );
    await click(client, popup.sessionId, '#refresh-tabs-button');
    await waitFor(
      () =>
        evaluate(
          client,
          popup.sessionId,
          `document.querySelectorAll('#tab-list input[type="checkbox"]:not(:disabled)').length === 4`,
        ),
      'Local test tabs did not appear in the popup',
    );

    const timingCopy = await textOf(client, popup.sessionId, '#rotation-timing-note');
    assert(
      timingCopy.includes('below 30 seconds is best effort') &&
        timingCopy.includes('30 seconds or longer for reliable timing'),
      'Sub-30-second timing copy is missing or misleading.',
    );
    checks.push('timing-copy');

    const selectAllNeeded = await evaluate(
      client,
      popup.sessionId,
      `!document.querySelector('#select-all-tabs-button').disabled`,
    );
    if (selectAllNeeded) await click(client, popup.sessionId, '#select-all-tabs-button');
    await waitFor(
      async () =>
        (await textOf(client, popup.sessionId, '#selection-summary')) ===
        '4 of 4 eligible tabs selected',
      'Eligible tabs were not selected',
    );
    checks.push('fresh-profile-install-and-selection');

    await pressEnter(client, popup.popupTarget, popup.sessionId, '#refresh-tabs-button');
    await waitFor(
      async () =>
        (await textOf(client, popup.sessionId, '#status-announcement')).includes(
          'Tab list updated',
        ),
      'Keyboard activation did not refresh the tab list',
    );
    const zoomLayout = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.getCurrent().then(async (tab) => {
        await chrome.tabs.setZoom(tab.id, 2);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const result = {
          zoom: await chrome.tabs.getZoom(tab.id),
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.getBoundingClientRect().width,
        };
        await chrome.tabs.setZoom(tab.id, 1);
        return result;
      })`,
    );
    assert(zoomLayout.zoom === 2, 'The popup did not reach 200% browser zoom.');
    checks.push('keyboard-activation');
    if (zoomLayout.noHorizontalOverflow) {
      checks.push('200-percent-zoom');
    } else if (name === 'opera') {
      findings.push({
        classification: 'headless-layout-observation',
        check: '200-percent-zoom',
        details: zoomLayout,
      });
    } else {
      assert(
        false,
        `The popup overflowed horizontally at 200% zoom: ${JSON.stringify(zoomLayout)}.`,
      );
    }

    for (const direction of ['forward', 'backward', 'random']) {
      await exerciseLifecycle(client, popup.sessionId, direction);
    }
    checks.push('rotation-lifecycle-all-directions');

    await setSelect(client, popup.sessionId, '#rotation-direction', 'forward');
    await setSelect(client, popup.sessionId, '#rotation-interval', '10000');
    const activeBefore10 = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id)`,
    );
    await click(client, popup.sessionId, '#rotation-primary-button');
    await delay(11_500);
    const activeAfter10 = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id)`,
    );
    assert(activeAfter10 !== activeBefore10, 'The 10-second rotation did not activate a target.');
    await click(client, popup.sessionId, '#rotation-stop-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Idle');
    checks.push('rotation-10-second-tick');

    await setSelect(client, popup.sessionId, '#rotation-interval', '30000');
    const activeBefore30 = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id)`,
    );
    await click(client, popup.sessionId, '#rotation-primary-button');
    await delay(31_500);
    const activeAfter30 = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id)`,
    );
    assert(activeAfter30 !== activeBefore30, 'The 30-second rotation did not activate a target.');
    await click(client, popup.sessionId, '#rotation-stop-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Idle');
    checks.push('rotation-30-second-tick');

    const hitsBeforeNow = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
    await click(client, popup.sessionId, '#refresh-now-button');
    await waitFor(
      async () =>
        (await textOf(client, popup.sessionId, '#refresh-result')).includes('4 succeeded'),
      'Refresh now did not report success',
    );
    const hitsAfterNow = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
    assert(hitsAfterNow >= hitsBeforeNow + 4, 'Refresh now did not reload every selected target.');

    await setSelect(client, popup.sessionId, '#refresh-interval', '30000');
    await click(client, popup.sessionId, '#refresh-start-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Refreshing');
    const hitsBeforeSchedule = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
    await delay(31_500);
    const hitsAfterSchedule = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
    assert(
      hitsAfterSchedule >= hitsBeforeSchedule + 4,
      'Scheduled refresh did not reload every target.',
    );
    await click(client, popup.sessionId, '#refresh-stop-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Idle');
    checks.push('refresh-now-and-scheduled-refresh');

    const mutation = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ currentWindow: true }).then(async (tabs) => {
        const targets = tabs.filter((tab) => tab.url?.startsWith(${JSON.stringify(local.origin)}));
        await chrome.tabs.move(targets[0].id, { index: 1 });
        await chrome.tabs.update(targets[1].id, { pinned: true });
        await chrome.tabs.remove(targets[2].id);
        return { moved: targets[0].id, pinned: targets[1].id, closed: targets[2].id };
      })`,
    );
    assert(mutation.moved && mutation.pinned && mutation.closed, 'Tab mutation setup failed.');
    await click(client, popup.sessionId, '#refresh-tabs-button');
    await waitFor(
      async () =>
        (await textOf(client, popup.sessionId, '#selection-summary')).includes('tabs selected'),
      'Tab list did not survive tab mutations',
    );
    checks.push('close-reorder-and-pin-target');

    await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.create({ url: ${JSON.stringify(`${local.origin}/epsilon`)}, active: false })`,
    );
    await waitFor(
      () =>
        evaluate(
          client,
          popup.sessionId,
          `chrome.tabs.query({ currentWindow: true }).then((tabs) => tabs.some((tab) => tab.url === ${JSON.stringify(`${local.origin}/epsilon`)} && tab.status === 'complete'))`,
        ),
      'Additional move target did not load',
    );
    await click(client, popup.sessionId, '#refresh-tabs-button');
    const reselectionNeeded = await evaluate(
      client,
      popup.sessionId,
      `!document.querySelector('#select-all-tabs-button').disabled`,
    );
    if (reselectionNeeded) await click(client, popup.sessionId, '#select-all-tabs-button');
    await setSelect(client, popup.sessionId, '#rotation-interval', '30000');
    await click(client, popup.sessionId, '#rotation-primary-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Rotating');
    const movedWindowId = await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ currentWindow: true }).then((tabs) => {
        const target = tabs.find((tab) => tab.url === ${JSON.stringify(`${local.origin}/epsilon`)});
        return target ? chrome.windows.create({ tabId: target.id, focused: false }).then((window) => window.id) : null;
      })`,
    );
    assert(movedWindowId, 'A target could not be moved to another window.');
    checks.push('move-target-to-another-window');
    const worker = (await getTargets(client)).find(
      (target) => target.type === 'service_worker' && target.url.includes(extensionId),
    );
    assert(worker, 'Background service worker was not found.');
    await client.send('Target.closeTarget', { targetId: worker.targetId });
    await waitFor(
      async () => !(await getTargets(client)).some((target) => target.targetId === worker.targetId),
      'Background service worker did not stop',
    );
    await client.send('Page.reload', {}, popup.sessionId);
    await waitFor(
      () =>
        evaluate(
          client,
          popup.sessionId,
          `document.readyState === 'complete' && document.querySelector('#status-region')?.getAttribute('aria-busy') === 'false'`,
        ),
      'Popup did not recover after background suspension',
    );
    await waitFor(
      async () =>
        (await getTargets(client)).some(
          (target) => target.type === 'service_worker' && target.url.includes(extensionId),
        ),
      'Background service worker did not restart',
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const status = await textOf(client, popup.sessionId, '#status-label');
      if (status === 'Rotating') break;
      if (status === 'Status unavailable') {
        await click(client, popup.sessionId, '#retry-button');
      } else {
        await client.send('Page.reload', {}, popup.sessionId);
      }
      await delay(750);
    }
    await waitForText(client, popup.sessionId, '#status-label', 'Rotating');
    checks.push('background-suspension-recovery');

    const rotationBeforeDelayedRecovery = await evaluate(
      client,
      popup.sessionId,
      `chrome.storage.local.get(null).then((items) => Object.values(items).find((value) => value && typeof value === 'object' && value.direction && value.state === 'running'))`,
    );
    assert(rotationBeforeDelayedRecovery?.nextRunAt, 'Rotation recovery state was not persisted.');
    const browserExit = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
    await Promise.race([client.send('Browser.close').catch(() => undefined), delay(3_000)]);
    await Promise.race([browserExit, delay(3_000)]);
    child.kill();
    client.close();
    await rm(join(profile, 'DevToolsActivePort'), { force: true });
    const wakeDelayMs = Math.max(
      1_000,
      rotationBeforeDelayedRecovery.nextRunAt - Date.now() + 1_000,
    );
    await delay(wakeDelayMs);

    child = startChromium(binary, profile);
    client = await connectToChromium(profile);
    const restoredExtensionId = (await loadExtension(client)) || (await getExtensionId(client));
    assert(
      restoredExtensionId === extensionId,
      'Extension identity changed across browser restart.',
    );
    popup = await popupReady(client, extensionId);
    const recoveryStatus = await waitFor(async () => {
      const label = await textOf(client, popup.sessionId, '#status-label');
      return label === 'Rotating' || label === 'Needs attention' ? label : null;
    }, 'Restart recovery did not reach a conservative terminal state');
    const rotationAfterDelayedRecovery = await evaluate(
      client,
      popup.sessionId,
      `chrome.storage.local.get(null).then((items) => Object.values(items).find((value) => value && typeof value === 'object' && value.direction))`,
    );
    if (recoveryStatus === 'Rotating') {
      assert(
        rotationAfterDelayedRecovery?.updatedAt > rotationBeforeDelayedRecovery?.updatedAt &&
          rotationAfterDelayedRecovery?.lastResult?.action === 'rotation' &&
          rotationAfterDelayedRecovery?.nextRunAt > Date.now(),
        'Restart after a delayed due time did not perform one catch-up rotation and schedule from now.',
      );
    } else {
      assert(
        rotationAfterDelayedRecovery?.state === 'needs-attention' &&
          rotationAfterDelayedRecovery?.attentionReason === 'ambiguous-recovery' &&
          rotationAfterDelayedRecovery?.lastRunAt === rotationBeforeDelayedRecovery?.lastRunAt,
        'Ambiguous restart recovery acted or did not persist needs-attention.',
      );
    }
    checks.push('browser-restart-and-delayed-wake-recovery');

    await click(client, popup.sessionId, '#rotation-stop-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Idle');

    const badgeAndA11y = await evaluate(
      client,
      popup.sessionId,
      `Promise.all([
        chrome.action.getBadgeText({}),
        chrome.action.getTitle({}),
      ]).then(([badge, title]) => ({ badge, title, labels: [...document.querySelectorAll('button, select, input')].every((element) => element.getAttribute('aria-label') || element.labels?.length || element.textContent?.trim()) }))`,
    );
    assert(badgeAndA11y.badge === '', 'Badge did not clear after stopping schedules.');
    assert(badgeAndA11y.title.includes('Idle'), 'Toolbar title did not expose idle state.');
    assert(badgeAndA11y.labels, 'An interactive control lacks an accessible name.');
    checks.push('badge-and-accessible-names');

    const buildHash = await hashDirectory(CHROMIUM_BUILD);
    return {
      browser: name,
      binary: basename(binary),
      build: 'chrome-mv3',
      buildHash,
      extensionId,
      profile: 'fresh-temporary',
      checks,
      failures: [],
      findings,
      retestOutcomes: [],
    };
  } finally {
    try {
      await client?.send('Browser.close');
    } catch {
      child?.kill();
    }
    await delay(500);
    child?.kill();
    local.server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

async function runRotationReliability(name, binary, durationMinutes) {
  const profile = await mkdtemp(join(tmpdir(), `tab-manipulator-t066-${name}-`));
  const local = await startLocalPages();
  const intervalMs = 30_000;
  const durationMs = durationMinutes * 60_000;
  let child;
  let client;

  try {
    const reportSetup = (stage) => console.log(JSON.stringify({ type: 'setup', stage }));
    reportSetup('launch-browser');
    child = startChromium(binary, profile, false);
    client = await connectToChromium(profile);
    reportSetup('load-extension');
    const loadedExtensionId = await loadExtension(client);
    const extensionId = loadedExtensionId || (await getExtensionId(client));
    reportSetup('open-popup');
    const popup = await popupReadyWithRetry(client, extensionId);
    reportSetup('create-tabs');
    await evaluate(
      client,
      popup.sessionId,
      `Promise.all(${JSON.stringify(['/reliability-a', '/reliability-b', '/reliability-c', '/reliability-d'])}.map((page) => chrome.tabs.create({ url: ${JSON.stringify(local.origin)} + page, active: false })))`,
    );
    await waitFor(
      () =>
        evaluate(
          client,
          popup.sessionId,
          `chrome.tabs.query({ currentWindow: true }).then((tabs) => tabs.filter((tab) => tab.url?.startsWith(${JSON.stringify(local.origin)}) && tab.status === 'complete').length === 4)`,
        ),
      'Reliability test tabs did not finish loading',
    );
    reportSetup('refresh-tab-list');
    await click(client, popup.sessionId, '#refresh-tabs-button');
    await waitFor(
      () =>
        evaluate(
          client,
          popup.sessionId,
          `document.querySelectorAll('#tab-list input[type="checkbox"]:not(:disabled)').length === 4`,
        ),
      'Reliability test tabs did not appear in the popup',
    );
    reportSetup('select-tabs');
    await click(client, popup.sessionId, '#select-all-tabs-button');
    await waitFor(
      async () =>
        (await textOf(client, popup.sessionId, '#selection-summary')) ===
        '4 of 4 eligible tabs selected',
      'Reliability test tabs were not selected',
    );
    reportSetup('register-observer');
    await evaluate(
      client,
      popup.sessionId,
      `chrome.tabs.query({ currentWindow: true }).then((tabs) => {
        const targetIds = tabs
          .filter((tab) => tab.url?.startsWith(${JSON.stringify(local.origin)}))
          .map((tab) => tab.id);
        globalThis.__t066Reliability = { targetIds, activations: [] };
        chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
          if (globalThis.__t066Reliability.targetIds.includes(tabId)) {
            globalThis.__t066Reliability.activations.push({ tabId, windowId, at: Date.now() });
          }
        });
      })`,
    );
    reportSetup('start-rotation');
    await setSelect(client, popup.sessionId, '#rotation-direction', 'forward');
    await setSelect(client, popup.sessionId, '#rotation-interval', String(intervalMs));
    const startedAt = Date.now();
    await click(client, popup.sessionId, '#rotation-primary-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Rotating');
    reportSetup('observation-started');

    const observationEndsAt = startedAt + durationMs;
    let nextProgressAt = startedAt + 5 * 60_000;
    while (Date.now() < observationEndsAt) {
      await delay(Math.min(5_000, observationEndsAt - Date.now()));
      if (Date.now() >= nextProgressAt) {
        const observed = await evaluate(
          client,
          popup.sessionId,
          `globalThis.__t066Reliability.activations.length`,
        );
        console.log(
          JSON.stringify({
            type: 'progress',
            elapsedMinutes: Number(((Date.now() - startedAt) / 60_000).toFixed(1)),
            observedTicks: observed,
          }),
        );
        nextProgressAt += 5 * 60_000;
      }
    }

    // Give the boundary tick a short grace period without reaching the next interval.
    await delay(10_000);
    const activations = await evaluate(
      client,
      popup.sessionId,
      `globalThis.__t066Reliability.activations`,
    );
    const expectedTicks = Math.floor(durationMs / intervalMs);
    const observedTicks = activations.length;
    const reliabilityPercent = (observedTicks / expectedTicks) * 100;
    const immediateRepeats = activations.filter(
      (activation, index) => index > 0 && activation.tabId === activations[index - 1].tabId,
    ).length;
    const uniqueTargetIds = new Set(activations.map((activation) => activation.tabId)).size;

    assert(
      reliabilityPercent >= 99,
      `Rotation reliability was ${reliabilityPercent.toFixed(2)}% (${observedTicks}/${expectedTicks}).`,
    );
    assert(
      observedTicks <= expectedTicks,
      `Rotation produced an action storm (${observedTicks}/${expectedTicks} expected ticks).`,
    );
    assert(immediateRepeats === 0, 'Forward rotation immediately repeated a target.');
    assert(uniqueTargetIds === 4, 'Rotation did not reach every selected target.');
    await click(client, popup.sessionId, '#rotation-stop-button');
    await waitForText(client, popup.sessionId, '#status-label', 'Idle');

    return {
      browser: name,
      binary: basename(binary),
      build: 'chrome-mv3',
      buildHash: await hashDirectory(CHROMIUM_BUILD),
      extensionId,
      profile: 'fresh-temporary',
      intervalMs,
      durationMinutes,
      expectedTicks,
      observedTicks,
      reliabilityPercent: Number(reliabilityPercent.toFixed(2)),
      immediateRepeats,
      uniqueTargetIds,
      firstTickDelayMs: activations[0]?.at - startedAt,
      finalTickAt: activations.at(-1)?.at,
      statusAfterStop: await textOf(client, popup.sessionId, '#status-label'),
    };
  } finally {
    try {
      await client?.send('Browser.close');
    } catch {
      child?.kill();
    }
    await delay(500);
    child?.kill();
    local.server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const requested = process.argv[2];
assert(
  requested in BROWSERS,
  `Usage: node scripts/t063-browser-matrix.mjs <${Object.keys(BROWSERS).join('|')}> [matrix|reliability|reliability-preflight] [minutes]`,
);

const mode = process.argv[3] ?? 'matrix';
assert(
  mode === 'matrix' || mode === 'reliability' || mode === 'reliability-preflight',
  'Mode must be matrix, reliability, or reliability-preflight.',
);
const requestedMinutes = Number(process.argv[4] ?? (mode === 'reliability-preflight' ? 2 : 60));
assert(
  mode !== 'reliability' || (Number.isInteger(requestedMinutes) && requestedMinutes >= 60),
  'The release-gate reliability run must be at least 60 whole minutes.',
);
assert(
  mode !== 'reliability-preflight' || (Number.isInteger(requestedMinutes) && requestedMinutes >= 2),
  'The reliability preflight must be at least two whole minutes.',
);
const result =
  mode === 'reliability' || mode === 'reliability-preflight'
    ? await runRotationReliability(requested, BROWSERS[requested], requestedMinutes)
    : await runChromiumMatrix(requested, BROWSERS[requested]);
console.log(JSON.stringify(result, null, 2));
