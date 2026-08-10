import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import runWebExtension from '../node_modules/web-ext/lib/cmd/run.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIREFOX_BUILD = resolve(ROOT, '.output/firefox-mv3');
const FIREFOX_BINARY = 'C:/Program Files/Mozilla Firefox/firefox.exe';
const FIREFOX_QA_ID = 't063@tab-manipulator.invalid';
let firefoxTestBuild = FIREFOX_BUILD;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function freePort() {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
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
  const aggregate = createHash('sha256');
  for (const file of (await walk(directory)).sort()) {
    aggregate.update(relative(directory, file).replaceAll('\\', '/'));
    aggregate.update('\0');
    aggregate.update(await readFile(file));
    aggregate.update('\0');
  }
  return aggregate.digest('hex');
}

class MarionetteClient {
  constructor(socket) {
    this.socket = socket;
    this.incoming = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    socket.on('data', (data) => this.onData(data));
  }

  onData(data) {
    this.incoming = Buffer.concat([this.incoming, data]);
    while (true) {
      const separator = this.incoming.indexOf(58);
      if (separator < 1) return;
      const length = Number(this.incoming.subarray(0, separator).toString());
      if (this.incoming.length < separator + 1 + length) return;
      const message = JSON.parse(
        this.incoming.subarray(separator + 1, separator + 1 + length).toString(),
      );
      this.incoming = this.incoming.subarray(separator + 1 + length);
      if (!Array.isArray(message)) continue;
      const [, id, error, result] = message;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (error) pending.reject(new Error(JSON.stringify(error)));
      else pending.resolve(result);
    }
  }

  request(name, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      const message = JSON.stringify([0, id, name, params]);
      this.socket.write(`${Buffer.byteLength(message)}:${message}`);
    });
  }

  async setContext(value) {
    await this.request('Marionette:SetContext', { value });
  }

  async execute(script, args = []) {
    const result = await this.request('WebDriver:ExecuteScript', {
      script,
      args,
      newSandbox: false,
      sandbox: 'default',
      line: 0,
      filename: 't063-firefox-matrix',
    });
    return result.value;
  }

  close() {
    this.socket.destroy();
  }

  async recoverOpenWindow() {
    const result = await this.request('WebDriver:GetWindowHandles');
    const handles = Array.isArray(result) ? result : (result.value ?? result.handles ?? []);
    for (const handle of handles) {
      try {
        await this.request('WebDriver:SwitchToWindow', { handle });
        await this.setContext('chrome');
        await this.execute('return typeof gBrowser !== "undefined";');
        return;
      } catch {
        // Try the next surviving browser window.
      }
    }
    throw new Error('No Firefox browser window survived extension reload.');
  }

  async switchToWindowWithTabs(origin, minimum) {
    const result = await this.request('WebDriver:GetWindowHandles');
    const handles = Array.isArray(result) ? result : (result.value ?? result.handles ?? []);
    for (const handle of handles) {
      try {
        await this.request('WebDriver:SwitchToWindow', { handle });
        await this.setContext('chrome');
        const count = await this.execute(
          'return gBrowser.tabs.filter((tab) => tab.linkedBrowser.currentURI.spec.startsWith(arguments[0])).length;',
          [origin],
        );
        if (count >= minimum) return;
      } catch {
        // Try the next surviving browser window.
      }
    }
    throw new Error(`No Firefox window contains ${minimum} local test tabs.`);
  }
}

async function connectMarionette(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const client = new MarionetteClient(socket);
  await client.request('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
  return client;
}

async function startFirefox(profile, marionettePort, startUrl = ['about:blank']) {
  const runner = await runWebExtension({
    artifactsDir: resolve(ROOT, '.wxt/t063-artifacts'),
    browserConsole: false,
    devtools: false,
    pref: {
      'marionette.port': marionettePort,
      'browser.startup.page': 3,
      'browser.sessionstore.resume_from_crash': true,
    },
    firefox: FIREFOX_BINARY,
    firefoxProfile: profile,
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    ignoreFiles: [],
    noInput: true,
    noReload: true,
    preInstall: false,
    sourceDir: firefoxTestBuild,
    verbose: true,
    watchFile: undefined,
    watchIgnored: [],
    startUrl,
    target: ['firefox-desktop'],
    args: ['-marionette', '-remote-allow-system-access'],
    chromiumPref: {},
  });
  const firefoxRunner = runner.extensionRunners[0];
  const addons = await firefoxRunner.remoteFirefox.client.request('listAddons');
  const addon = addons.addons.find((candidate) => candidate.name === 'Tab Manipulator');
  assert(addon?.manifestURL, 'Firefox did not install the temporary extension.');
  const marionette = await connectMarionette(marionettePort);
  return { runner, firefoxRunner, addon, marionette };
}

async function loadPopup(marionette, manifestUrl) {
  const popupUrl = new URL('popup.html', manifestUrl).href;
  await marionette.setContext('chrome');
  await marionette.execute(
    'gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;',
    [popupUrl],
  );
  await delay(500);
  await marionette.setContext('content');
  await waitFor(
    () =>
      marionette.execute(
        'return document.readyState === "complete" && document.querySelector("#status-region")?.getAttribute("aria-busy") === "false";',
      ),
    'Firefox popup did not initialize',
  );
}

async function evaluate(marionette, script, args = []) {
  await marionette.setContext('content');
  return marionette.execute(`return (${script});`, args);
}

async function evaluateChrome(marionette, script, args = []) {
  await marionette.setContext('chrome');
  return marionette.execute(`return (${script});`, args);
}

async function click(marionette, selector) {
  const clicked = await evaluate(
    marionette,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled || element.hidden) return false; element.click(); return true; })()`,
  );
  assert(clicked, `Could not click ${selector}.`);
}

async function setSelect(marionette, selector, value) {
  const changed = await evaluate(
    marionette,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
  );
  assert(changed, `Could not set ${selector}.`);
}

async function textOf(marionette, selector) {
  return evaluate(
    marionette,
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`,
  );
}

async function waitForText(marionette, selector, text, timeoutMs = 15_000) {
  return waitFor(
    async () => (await textOf(marionette, selector)) === text,
    `${selector} did not become ${text}`,
    timeoutMs,
  );
}

async function pressEnter(marionette, selector) {
  const focused = await evaluate(
    marionette,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled || element.hidden) return false; element.focus(); return document.activeElement === element; })()`,
  );
  assert(focused, `Could not focus ${selector}.`);
  await marionette.request('WebDriver:PerformActions', {
    actions: [
      {
        type: 'key',
        id: 't063-keyboard',
        actions: [
          { type: 'keyDown', value: '\uE007' },
          { type: 'keyUp', value: '\uE007' },
        ],
      },
    ],
  });
  await marionette.request('WebDriver:ReleaseActions');
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
  return { server, hits, origin: `http://127.0.0.1:${server.address().port}` };
}

async function exerciseLifecycle(marionette, direction) {
  await setSelect(marionette, '#rotation-direction', direction);
  await setSelect(marionette, '#rotation-interval', '30000');
  await click(marionette, '#rotation-primary-button');
  try {
    await waitForText(marionette, '#status-label', 'Rotating');
  } catch (error) {
    const state = await evaluate(
      marionette,
      `({ status: document.querySelector('#status-label')?.textContent, selection: document.querySelector('#selection-summary')?.textContent, validation: document.querySelector('#rotation-validation')?.textContent, tabRows: document.querySelectorAll('#tab-list input:not(:disabled)').length })`,
    );
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  await click(marionette, '#rotation-primary-button');
  await waitForText(marionette, '#status-label', 'Rotation paused');
  await click(marionette, '#rotation-primary-button');
  await waitForText(marionette, '#status-label', 'Rotating');
  await click(marionette, '#rotation-stop-button');
  await waitForText(marionette, '#status-label', 'Idle');
}

const profile = await mkdtemp(join(tmpdir(), 'tab-manipulator-t063-firefox-'));
const qaBuild = await mkdtemp(join(tmpdir(), 'tab-manipulator-t063-firefox-build-'));
await mkdir(profile, { recursive: true });
await cp(FIREFOX_BUILD, qaBuild, { recursive: true });
const qaManifestPath = join(qaBuild, 'manifest.json');
const qaManifest = JSON.parse(await readFile(qaManifestPath, 'utf8'));
qaManifest.browser_specific_settings = { gecko: { id: FIREFOX_QA_ID } };
await writeFile(qaManifestPath, `${JSON.stringify(qaManifest, null, 2)}\n`);
firefoxTestBuild = qaBuild;
const local = await startLocalPages();
let browserRun;
const checks = [];

try {
  const marionettePort = await freePort();
  browserRun = await startFirefox(profile, marionettePort);
  let { marionette, addon, firefoxRunner } = browserRun;
  await loadPopup(marionette, addon.manifestURL);

  const timingCopy = await textOf(marionette, '#rotation-timing-note');
  assert(
    timingCopy.includes('below 30 seconds is best effort') &&
      timingCopy.includes('30 seconds or longer for reliable timing'),
    'Sub-30-second timing copy is missing or misleading.',
  );
  checks.push('timing-copy');

  await evaluateChrome(
    marionette,
    `(() => { const principal = Services.scriptSecurityManager.getSystemPrincipal(); for (const url of arguments[0]) gBrowser.addTab(url, { triggeringPrincipal: principal, inBackground: true }); return true; })()`,
    [['/alpha', '/beta', '/gamma', '/delta'].map((path) => `${local.origin}${path}`)],
  );
  await waitFor(
    () =>
      evaluateChrome(
        marionette,
        'gBrowser.tabs.filter((tab) => tab.linkedBrowser.currentURI.spec.startsWith(arguments[0])).length === 4',
        [local.origin],
      ),
    'Firefox local test tabs did not finish loading',
  );
  await click(marionette, '#refresh-tabs-button');
  await waitFor(
    () =>
      evaluate(
        marionette,
        'document.querySelectorAll("#tab-list input:not(:disabled)").length === 4',
      ),
    'Firefox popup did not list four eligible local tabs',
  );
  await click(marionette, '#select-all-tabs-button');
  await waitForText(marionette, '#selection-summary', '4 of 4 eligible tabs selected');
  checks.push('fresh-profile-install-and-selection');

  await pressEnter(marionette, '#refresh-tabs-button');
  await waitFor(
    async () => (await textOf(marionette, '#status-announcement')).includes('Tab list updated'),
    'Firefox keyboard activation did not refresh the tab list',
  );
  const zoom = await evaluateChrome(
    marionette,
    `(() => { ZoomManager.setZoomForBrowser(gBrowser.selectedBrowser, 2); return gBrowser.selectedBrowser.fullZoom; })()`,
  );
  assert(zoom === 2, 'Firefox popup did not reach 200% browser zoom.');
  const noHorizontalOverflow = await evaluate(
    marionette,
    'document.documentElement.scrollWidth <= document.documentElement.clientWidth',
  );
  assert(noHorizontalOverflow, 'Firefox popup overflowed horizontally at 200% zoom.');
  await evaluateChrome(
    marionette,
    '(() => { ZoomManager.setZoomForBrowser(gBrowser.selectedBrowser, 1); return true; })()',
  );
  checks.push('keyboard-and-200-percent-zoom');

  for (const direction of ['forward', 'backward', 'random']) {
    await exerciseLifecycle(marionette, direction);
  }
  checks.push('rotation-lifecycle-all-directions');

  await setSelect(marionette, '#rotation-direction', 'forward');
  await setSelect(marionette, '#rotation-interval', '10000');
  const activeBefore10 = await evaluateChrome(
    marionette,
    'gBrowser.selectedBrowser.currentURI.spec',
  );
  await click(marionette, '#rotation-primary-button');
  await delay(11_500);
  const activeAfter10 = await evaluateChrome(
    marionette,
    'gBrowser.selectedBrowser.currentURI.spec',
  );
  assert(activeAfter10 !== activeBefore10, 'Firefox 10-second rotation did not activate a target.');
  await click(marionette, '#rotation-stop-button');
  await waitForText(marionette, '#status-label', 'Idle');
  checks.push('rotation-10-second-tick');

  await setSelect(marionette, '#rotation-interval', '30000');
  const activeBefore30 = await evaluateChrome(
    marionette,
    'gBrowser.selectedBrowser.currentURI.spec',
  );
  await click(marionette, '#rotation-primary-button');
  await delay(31_500);
  const activeAfter30 = await evaluateChrome(
    marionette,
    'gBrowser.selectedBrowser.currentURI.spec',
  );
  assert(activeAfter30 !== activeBefore30, 'Firefox 30-second rotation did not activate a target.');
  await click(marionette, '#rotation-stop-button');
  await waitForText(marionette, '#status-label', 'Idle');
  checks.push('rotation-30-second-tick');

  const hitsBeforeNow = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
  await click(marionette, '#refresh-now-button');
  await waitFor(
    async () => (await textOf(marionette, '#refresh-result')).includes('4 succeeded'),
    'Firefox Refresh now did not report success',
  );
  const hitsAfterNow = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
  assert(hitsAfterNow >= hitsBeforeNow + 4, 'Firefox Refresh now did not reload every target.');
  await setSelect(marionette, '#refresh-interval', '30000');
  await click(marionette, '#refresh-start-button');
  await waitForText(marionette, '#status-label', 'Refreshing');
  const hitsBeforeSchedule = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
  await delay(31_500);
  const hitsAfterSchedule = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
  assert(hitsAfterSchedule >= hitsBeforeSchedule + 4, 'Firefox scheduled refresh missed targets.');
  await click(marionette, '#refresh-stop-button');
  await waitForText(marionette, '#status-label', 'Idle');
  checks.push('refresh-now-and-scheduled-refresh');

  const mutation = await evaluateChrome(
    marionette,
    `(() => { const tabs = gBrowser.tabs.filter((tab) => tab.linkedBrowser.currentURI.spec.startsWith(arguments[0])); gBrowser.moveTabTo(tabs[0], 1); gBrowser.pinTab(tabs[1]); gBrowser.removeTab(tabs[2]); return tabs.length; })()`,
    [local.origin],
  );
  assert(mutation === 4, 'Firefox tab mutation setup failed.');
  await click(marionette, '#refresh-tabs-button');
  checks.push('close-reorder-and-pin-target');

  await evaluateChrome(
    marionette,
    `(() => { const principal = Services.scriptSecurityManager.getSystemPrincipal(); gBrowser.addTab(arguments[0], { triggeringPrincipal: principal, inBackground: true }); return true; })()`,
    [`${local.origin}/epsilon`],
  );
  await delay(500);
  await click(marionette, '#refresh-tabs-button');
  if (await evaluate(marionette, '!document.querySelector("#select-all-tabs-button").disabled')) {
    await click(marionette, '#select-all-tabs-button');
  }
  await setSelect(marionette, '#rotation-interval', '30000');
  await click(marionette, '#rotation-primary-button');
  await waitForText(marionette, '#status-label', 'Rotating');
  const moved = await evaluateChrome(
    marionette,
    `(() => { const tab = gBrowser.tabs.find((candidate) => candidate.linkedBrowser.currentURI.spec === arguments[0]); if (!tab) return false; gBrowser.replaceTabWithWindow(tab); return true; })()`,
    [`${local.origin}/epsilon`],
  );
  assert(moved, 'Firefox could not move a target to another window.');
  checks.push('move-target-to-another-window');

  const addonId = addon.id;
  await firefoxRunner.reloadExtensionBySourceDir(firefoxTestBuild);
  const reloadedAddon = await firefoxRunner.remoteFirefox.getInstalledAddon(addonId);
  addon = reloadedAddon;
  await marionette.recoverOpenWindow();
  await loadPopup(marionette, addon.manifestURL);
  await waitFor(async () => {
    const status = await textOf(marionette, '#status-label');
    return status === 'Rotating' || status === 'Needs attention';
  }, 'Firefox did not recover conservatively after background reload');
  checks.push('background-suspension-recovery');

  await click(marionette, '#rotation-stop-button');
  await waitForText(marionette, '#status-label', 'Idle');
  await marionette.switchToWindowWithTabs(local.origin, 2);
  await evaluateChrome(
    marionette,
    `(() => { const principal = Services.scriptSecurityManager.getSystemPrincipal(); gBrowser.addTab(arguments[0], { triggeringPrincipal: principal, inBackground: true }); return true; })()`,
    [`${local.origin}/zeta`],
  );
  await waitFor(
    () =>
      evaluateChrome(
        marionette,
        'gBrowser.tabs.some((tab) => tab.linkedBrowser.currentURI.spec === arguments[0])',
        [`${local.origin}/zeta`],
      ),
    'Firefox restart target did not load',
  );
  await loadPopup(marionette, addon.manifestURL);
  await click(marionette, '#refresh-tabs-button');
  if (await evaluate(marionette, '!document.querySelector("#select-all-tabs-button").disabled')) {
    await click(marionette, '#select-all-tabs-button');
  }
  await setSelect(marionette, '#rotation-interval', '30000');
  await click(marionette, '#rotation-primary-button');
  try {
    await waitForText(marionette, '#status-label', 'Rotating');
  } catch (error) {
    const state = await evaluate(
      marionette,
      `({ status: document.querySelector('#status-label')?.textContent, selection: document.querySelector('#selection-summary')?.textContent, validation: document.querySelector('#rotation-validation')?.textContent, tabRows: document.querySelectorAll('#tab-list input:not(:disabled)').length })`,
    );
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  const rotationBeforeDelayedRecovery = await evaluate(
    marionette,
    `(() => { const api = window.wrappedJSObject?.browser ?? window.browser; return api.storage.local.get(null).then((items) => Object.values(items).find((value) => value && typeof value === 'object' && value.direction && value.state === 'running')); })()`,
  );
  assert(rotationBeforeDelayedRecovery?.nextRunAt, 'Firefox restart state was not persisted.');

  const oldFirefoxProcess = firefoxRunner.runningInfo.firefox;
  const firefoxExit =
    oldFirefoxProcess.exitCode === null ? once(oldFirefoxProcess, 'exit') : Promise.resolve();
  marionette.close();
  await browserRun.runner.exit();
  await Promise.race([firefoxExit, delay(5_000)]);
  const wakeDelayMs = Math.max(1_000, rotationBeforeDelayedRecovery.nextRunAt - Date.now() + 1_000);
  await delay(wakeDelayMs);

  const restartPort = await freePort();
  browserRun = await startFirefox(profile, restartPort, null);
  ({ marionette, addon, firefoxRunner } = browserRun);
  assert(addon.id === addonId, 'Firefox temporary add-on identity changed in the same profile.');
  await loadPopup(marionette, addon.manifestURL);
  const restartStatus = await waitFor(async () => {
    const status = await textOf(marionette, '#status-label');
    return status === 'Rotating' || status === 'Needs attention' ? status : null;
  }, 'Firefox restart did not reach a conservative recovery state');
  const rotationAfterDelayedRecovery = await evaluate(
    marionette,
    `(() => { const api = window.wrappedJSObject?.browser ?? window.browser; return api.storage.local.get(null).then((items) => Object.values(items).find((value) => value && typeof value === 'object' && value.direction)); })()`,
  );
  if (restartStatus === 'Rotating') {
    assert(
      rotationAfterDelayedRecovery?.updatedAt > rotationBeforeDelayedRecovery?.updatedAt &&
        rotationAfterDelayedRecovery?.lastResult?.action === 'rotation' &&
        rotationAfterDelayedRecovery?.nextRunAt > Date.now(),
      'Firefox delayed restart did not perform one catch-up and schedule from now.',
    );
  } else {
    assert(
      rotationAfterDelayedRecovery?.state === 'needs-attention' &&
        rotationAfterDelayedRecovery?.attentionReason === 'ambiguous-recovery' &&
        rotationAfterDelayedRecovery?.lastRunAt === rotationBeforeDelayedRecovery?.lastRunAt,
      'Firefox ambiguous restart recovery acted or did not persist needs-attention.',
    );
  }
  checks.push('browser-restart-and-delayed-wake-recovery');

  await click(marionette, '#rotation-stop-button');
  await waitForText(marionette, '#status-label', 'Idle');

  const badgeAndA11y = await evaluate(
    marionette,
    `(() => { const api = window.wrappedJSObject?.browser ?? window.browser; const toolbar = api.action ?? api.browserAction; return Promise.all([toolbar.getBadgeText({}), toolbar.getTitle({})]).then(([badge, title]) => ({ badge, title, labels: [...document.querySelectorAll('button, select, input')].every((element) => element.getAttribute('aria-label') || element.labels?.length || element.textContent?.trim()) })); })()`,
  );
  assert(badgeAndA11y.badge === '', 'Firefox badge did not clear after stop.');
  assert(badgeAndA11y.title.includes('Idle'), 'Firefox toolbar title did not expose idle state.');
  assert(badgeAndA11y.labels, 'A Firefox popup control lacks an accessible name.');
  checks.push('badge-and-accessible-names');

  console.log(
    JSON.stringify(
      {
        browser: 'firefox',
        binary: 'firefox.exe',
        build: 'firefox-mv3',
        buildHash: await hashDirectory(FIREFOX_BUILD),
        qaFirefoxId: FIREFOX_QA_ID,
        temporaryAddonId: addonId,
        profile: 'fresh-temporary',
        checks,
        failures: [],
        retestOutcomes: [],
      },
      null,
      2,
    ),
  );
} finally {
  browserRun?.marionette.close();
  await browserRun?.runner.exit().catch(() => undefined);
  await delay(750);
  local.server.close();
  await rm(profile, { recursive: true, force: true });
  await rm(qaBuild, { recursive: true, force: true });
}
