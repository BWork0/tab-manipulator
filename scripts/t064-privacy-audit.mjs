import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROMIUM_BUILD = resolve(ROOT, '.output/chrome-mv3');
const COMMAND_TIMEOUT_MS = 15_000;
const BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    path: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  },
  edge: {
    label: 'Microsoft Edge',
    path: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  },
};
const browserName = process.argv[2] ?? 'edge';
const selectedBrowser = BROWSERS[browserName];
assert(
  selectedBrowser,
  `Usage: node scripts/t064-privacy-audit.mjs <${Object.keys(BROWSERS).join('|')}>`,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(check, message, timeoutMs = COMMAND_TIMEOUT_MS) {
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
        rejectRequest(new Error(`${method} did not respond within ${COMMAND_TIMEOUT_MS} ms.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

function startBrowser(profile) {
  return spawn(
    selectedBrowser.path,
    [
      '--headless=new',
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
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
}

async function connect(profile) {
  const activePortFile = join(profile, 'DevToolsActivePort');
  const activePort = await waitFor(async () => {
    try {
      return await readFile(activePortFile, 'utf8');
    } catch {
      return null;
    }
  }, 'Chrome did not expose a debugging endpoint.');
  const [port, socketPath] = activePort.trim().split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
  await once(socket, 'open');
  return new CdpClient(socket);
}

async function attach(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Page.navigate', { url }, sessionId);
  await waitFor(
    () => evaluate(client, sessionId, `document.readyState === 'complete'`),
    `${url} did not finish loading.`,
  );
  return { targetId, sessionId };
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

async function click(client, sessionId, selector) {
  const clicked = await evaluate(
    client,
    sessionId,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled || element.hidden) return false; element.click(); return true; })()`,
  );
  assert(clicked, `Could not click ${selector}.`);
}

async function textOf(client, sessionId, selector) {
  return evaluate(
    client,
    sessionId,
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`,
  );
}

async function waitForText(client, sessionId, selector, expected) {
  await waitFor(
    async () => (await textOf(client, sessionId, selector)) === expected,
    `${selector} did not become ${expected}.`,
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
  return { server, hits, origin: `http://127.0.0.1:${server.address().port}` };
}

const profile = await mkdtemp(join(tmpdir(), `tab-manipulator-t064-${browserName}-`));
const local = await startLocalPages();
let child;
let client;

try {
  child = startBrowser(profile);
  client = await connect(profile);
  const loaded = await client.send('Extensions.loadUnpacked', { path: CHROMIUM_BUILD });
  const extensionId = loaded.id;
  const popup = await attach(client, `chrome-extension://${extensionId}/popup.html`);
  await waitFor(
    () =>
      evaluate(
        client,
        popup.sessionId,
        `document.querySelector('#status-region')?.getAttribute('aria-busy') === 'false'`,
      ),
    'Popup did not initialize.',
  );

  await evaluate(
    client,
    popup.sessionId,
    `Promise.all(['/alpha', '/beta'].map((page) => chrome.tabs.create({ url: ${JSON.stringify(local.origin)} + page, active: false })))`,
  );
  await waitFor(
    () =>
      evaluate(
        client,
        popup.sessionId,
        `chrome.tabs.query({ currentWindow: true }).then((tabs) => tabs.filter((tab) => tab.url?.startsWith(${JSON.stringify(local.origin)}) && tab.status === 'complete').length === 2)`,
      ),
    'Local representative tabs did not finish loading.',
  );
  await click(client, popup.sessionId, '#refresh-tabs-button');
  await waitFor(
    () =>
      evaluate(
        client,
        popup.sessionId,
        `document.querySelectorAll('#tab-list input[type="checkbox"]:not(:disabled)').length === 2`,
      ),
    'Representative tabs did not appear in the popup.',
  );
  await click(client, popup.sessionId, '#select-all-tabs-button');

  await click(client, popup.sessionId, '#rotation-primary-button');
  await waitForText(client, popup.sessionId, '#status-label', 'Rotating');
  await click(client, popup.sessionId, '#rotation-stop-button');
  await waitForText(client, popup.sessionId, '#status-label', 'Idle');

  const hitsBeforeRefreshNow = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
  await click(client, popup.sessionId, '#refresh-now-button');
  await waitFor(
    async () => (await textOf(client, popup.sessionId, '#refresh-result')).includes('2 succeeded'),
    'Refresh now did not complete.',
  );
  const hitsAfterRefreshNow = [...local.hits.values()].reduce((sum, count) => sum + count, 0);
  assert(
    hitsAfterRefreshNow >= hitsBeforeRefreshNow + 2,
    'Refresh now did not reload both representative tabs.',
  );

  await click(client, popup.sessionId, '#refresh-start-button');
  await waitForText(client, popup.sessionId, '#status-label', 'Refreshing');
  await click(client, popup.sessionId, '#refresh-stop-button');
  await waitForText(client, popup.sessionId, '#status-label', 'Idle');

  const retainedRuntimeDescriptors = await evaluate(
    client,
    popup.sessionId,
    `chrome.storage.local.get(null).then((items) => Object.entries(items).filter(([, value]) => value && typeof value === 'object' && Array.isArray(value.targets) && value.targets.some((target) => typeof target?.url === 'string' || typeof target?.title === 'string')).map(([key]) => key))`,
  );
  assert(
    retainedRuntimeDescriptors.length === 0,
    `Stopping schedules retained runtime URL/title descriptors in ${retainedRuntimeDescriptors.join(', ')}.`,
  );

  const options = await attach(client, `chrome-extension://${extensionId}/options.html`);
  const resourceUrls = [
    ...(await evaluate(
      client,
      popup.sessionId,
      `performance.getEntriesByType('resource').map((entry) => entry.name)`,
    )),
    ...(await evaluate(
      client,
      options.sessionId,
      `performance.getEntriesByType('resource').map((entry) => entry.name)`,
    )),
  ];
  const unexpectedResourceUrls = resourceUrls.filter(
    (url) => !url.startsWith(`chrome-extension://${extensionId}/`),
  );
  assert(
    unexpectedResourceUrls.length === 0,
    `Extension pages loaded non-local resources: ${unexpectedResourceUrls.join(', ')}.`,
  );

  console.log(
    JSON.stringify(
      {
        browser: selectedBrowser.label,
        profile: 'fresh-temporary',
        representativeActions: [
          'tab-discovery',
          'rotation-start-stop',
          'refresh-now',
          'refresh-start-stop',
          'options-load',
        ],
        extensionResourceUrls: [...new Set(resourceUrls)].sort(),
        unexpectedResourceUrls,
        retainedRuntimeDescriptors,
      },
      null,
      2,
    ),
  );
} finally {
  const browserExit = child?.exitCode === null ? once(child, 'exit') : Promise.resolve();
  try {
    await client?.send('Browser.close');
  } catch {
    child?.kill();
  }
  await Promise.race([browserExit, delay(3_000)]);
  child?.kill();
  client?.close();
  local.server.close();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== 'EBUSY' || attempt === 4) throw error;
      await delay(500);
    }
  }
}
