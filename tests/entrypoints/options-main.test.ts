import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Settings } from '@/core/types';
import type { AutomationSnapshot, Command } from '@/messaging/protocol';
import { createRuntimeMessageListener } from '@/messaging/protocol';
import optionsHtml from '@/entrypoints/options/index.html?raw';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const SNAPSHOT: AutomationSnapshot = {
  status: 'idle',
  settings: {
    ...DEFAULT_SETTINGS,
    rotationIntervalMs: 60_000,
    rotationDirection: 'backward',
    refreshIntervalMs: 300_000,
    includePinned: true,
    allowlist: ['example.com'],
    blocklist: ['private.example', 'https://*.blocked.example/*'],
  },
  rotation: null,
  refresh: null,
  capabilities: {
    currentWindowTabQuery: 'available',
    allWindowTabQuery: 'available',
    tabActivation: 'available',
    tabReload: 'available',
    toolbarState: 'available',
    optionsPage: 'available',
  },
};

function createDocument() {
  return parseHTML(`
    <main id="settings-region" aria-busy="true">
      <form id="settings-form">
        <fieldset id="automation-defaults">
          <select id="default-rotation-interval">
            <option value="10000">10 seconds</option>
            <option value="30000">30 seconds</option>
            <option value="60000">1 minute</option>
            <option value="custom">Custom</option>
          </select>
          <div id="default-rotation-custom-group" hidden>
            <input id="default-rotation-custom" value="10" />
          </div>
          <p id="default-rotation-validation" hidden></p>
          <select id="default-rotation-direction">
            <option value="forward">Forward</option>
            <option value="backward">Backward</option>
            <option value="random">Random</option>
          </select>
          <p id="default-direction-validation" hidden></p>
          <select id="default-refresh-interval">
            <option value="30000">30 seconds</option>
            <option value="60000">1 minute</option>
            <option value="300000">5 minutes</option>
            <option value="custom">Custom</option>
          </select>
          <div id="default-refresh-custom-group" hidden>
            <input id="default-refresh-custom" value="300" />
          </div>
          <p id="default-refresh-validation" hidden></p>
          <input id="include-pinned-tabs" type="checkbox" />
          <textarea id="allowlist-rules"></textarea>
          <ul id="allowlist-validation" hidden></ul>
          <textarea id="blocklist-rules"></textarea>
          <ul id="blocklist-validation" hidden></ul>
          <input id="rule-preview-url" />
          <output id="rule-preview-result"></output>
        </fieldset>
        <dl id="settings-summary">
          <dd id="allowlist-summary"></dd>
          <dd id="blocklist-summary"></dd>
        </dl>
        <p id="save-status"></p>
        <button id="save-settings-button" type="submit"></button>
        <button id="discard-settings-button" type="button"></button>
        <button id="retry-settings-button" type="button"></button>
      </form>
    </main>
  `);
}

function required<TElement extends Element>(document: Document, selector: string): TElement {
  const element = document.querySelector(selector);

  if (element === null) {
    throw new Error(`Missing test element: ${selector}.`);
  }

  return element as TElement;
}

function selectValue(select: HTMLSelectElement, value: string): void {
  for (const option of select.options) {
    option.selected = option.value === value;
  }
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('options entrypoint', () => {
  it('provides labelled multiline rule inputs with syntax and precedence guidance', () => {
    const { document } = parseHTML(optionsHtml);
    const allowlist = required<HTMLTextAreaElement>(document, '#allowlist-rules');
    const blocklist = required<HTMLTextAreaElement>(document, '#blocklist-rules');

    expect(document.querySelector('label[for="allowlist-rules"]')?.textContent).toBe('Allowlist');
    expect(document.querySelector('label[for="blocklist-rules"]')?.textContent).toBe('Blocklist');
    expect(allowlist.getAttribute('aria-describedby')).toContain('allowlist-help');
    expect(blocklist.getAttribute('aria-describedby')).toContain('blocklist-help');
    expect(document.querySelector('#allowlist-help')?.textContent).toContain('example.com');
    expect(document.querySelector('#blocklist-help')?.textContent.replace(/\s+/g, ' ')).toContain(
      'Blocklist matches override allowlist matches',
    );
    expect(
      document
        .querySelector('#url-filters-heading')
        ?.parentElement?.textContent.replace(/\s+/g, ' '),
    ).toContain('An empty allowlist allows every otherwise eligible URL');
  });

  it('loads and renders editable defaults through the background protocol', async () => {
    const { document, window } = createDocument();
    const handler = vi.fn(async () => ({
      ok: true as const,
      command: 'get-snapshot' as const,
      data: SNAPSHOT,
    }));
    const listener = createRuntimeMessageListener(handler);
    const sendMessage = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    fakeBrowser.runtime.onMessage.addListener(listener as never);
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);

    await import('@/entrypoints/options/main');

    await vi.waitFor(() =>
      expect(document.querySelector('#save-status')?.textContent).toBe('All changes saved.'),
    );
    expect(sendMessage).toHaveBeenCalledWith({ type: 'get-snapshot' });
    expect(required<HTMLSelectElement>(document, '#default-rotation-interval').value).toBe('60000');
    expect(required<HTMLSelectElement>(document, '#default-rotation-direction').value).toBe(
      'backward',
    );
    expect(required<HTMLSelectElement>(document, '#default-refresh-interval').value).toBe('300000');
    expect(required<HTMLInputElement>(document, '#include-pinned-tabs').checked).toBe(true);
    expect(required<HTMLTextAreaElement>(document, '#allowlist-rules').value).toBe('example.com');
    expect(required<HTMLTextAreaElement>(document, '#blocklist-rules').value).toBe(
      'private.example\nhttps://*.blocked.example/*',
    );
    expect(document.querySelector('#allowlist-summary')?.textContent).toBe('1 rule');
    expect(document.querySelector('#blocklist-summary')?.textContent).toBe('2 rules');
    expect(document.querySelector('#settings-region')?.getAttribute('aria-busy')).toBe('false');
  });

  it('preserves saved settings when any rule is invalid and reports every offending line', async () => {
    const { document, window } = createDocument();
    const handler = vi.fn(async (command: Command) => {
      if (command.type === 'get-snapshot') {
        return { ok: true as const, command: command.type, data: SNAPSHOT };
      }

      throw new Error('Invalid rules must not reach the background.');
    });
    fakeBrowser.runtime.onMessage.addListener(createRuntimeMessageListener(handler) as never);
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    await import('@/entrypoints/options/main');
    await vi.waitFor(() =>
      expect(document.querySelector('#save-status')?.textContent).toBe('All changes saved.'),
    );

    const allowlist = required<HTMLTextAreaElement>(document, '#allowlist-rules');
    const blocklist = required<HTMLTextAreaElement>(document, '#blocklist-rules');
    allowlist.value = 'example.com\ninvalid domain\nftp://bad.example/*';
    blocklist.value = 'blocked.example\nhttps://example.com:70000/*';
    allowlist.dispatchEvent(new window.Event('input', { bubbles: true }));
    required<HTMLFormElement>(document, '#settings-form').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() =>
      expect(document.querySelector('#save-status')?.textContent).toContain('need attention'),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(document.querySelector('#allowlist-validation')?.textContent).toContain(
      'Line 2 (invalid domain)',
    );
    expect(document.querySelector('#allowlist-validation')?.textContent).toContain(
      'Line 3 (ftp://bad.example/*)',
    );
    expect(document.querySelector('#blocklist-validation')?.textContent).toContain(
      'Line 2 (https://example.com:70000/*)',
    );
    expect(allowlist.value).toContain('invalid domain');
    expect(SNAPSHOT.settings.allowlist).toEqual(['example.com']);
    expect(SNAPSHOT.settings.blocklist).toEqual(['private.example', 'https://*.blocked.example/*']);
  });

  it('blocks invalid defaults and saves one complete validated settings update', async () => {
    const { document, window } = createDocument();
    const handler = vi.fn(async (command: Command) => {
      if (command.type === 'get-snapshot') {
        return { ok: true as const, command: command.type, data: SNAPSHOT };
      }

      if (command.type === 'update-settings') {
        return {
          ok: true as const,
          command: command.type,
          data: {
            settings: command.settings,
            snapshot: { ...SNAPSHOT, settings: command.settings },
          },
        };
      }

      throw new Error('Unexpected test command.');
    });
    fakeBrowser.runtime.onMessage.addListener(createRuntimeMessageListener(handler) as never);
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    await import('@/entrypoints/options/main');
    await vi.waitFor(() =>
      expect(document.querySelector('#save-status')?.textContent).toBe('All changes saved.'),
    );

    const form = required<HTMLFormElement>(document, '#settings-form');
    const rotationInterval = required<HTMLSelectElement>(document, '#default-rotation-interval');
    const rotationCustom = required<HTMLInputElement>(document, '#default-rotation-custom');
    selectValue(rotationInterval, 'custom');
    rotationCustom.value = '9';
    rotationCustom.dispatchEvent(new window.Event('input', { bubbles: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(document.querySelector('#save-status')?.textContent).toContain('need attention'),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#default-rotation-validation')?.textContent).toBe(
      'Enter at least 10 seconds.',
    );

    const refreshInterval = required<HTMLSelectElement>(document, '#default-refresh-interval');
    const refreshCustom = required<HTMLInputElement>(document, '#default-refresh-custom');
    const direction = required<HTMLSelectElement>(document, '#default-rotation-direction');
    const includePinned = required<HTMLInputElement>(document, '#include-pinned-tabs');
    const allowlist = required<HTMLTextAreaElement>(document, '#allowlist-rules');
    const blocklist = required<HTMLTextAreaElement>(document, '#blocklist-rules');
    rotationCustom.value = '45';
    selectValue(refreshInterval, 'custom');
    refreshCustom.value = '90';
    selectValue(direction, 'random');
    includePinned.checked = false;
    allowlist.value = ' Example.COM \nexample.com.\nHTTPS://*.Example.COM/*';
    blocklist.value = ' Blocked.Example \nblocked.example';
    refreshCustom.dispatchEvent(new window.Event('input', { bubbles: true }));
    direction.dispatchEvent(new window.Event('change', { bubbles: true }));
    includePinned.dispatchEvent(new window.Event('change', { bubbles: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    const savedSettings: Settings = {
      ...SNAPSHOT.settings,
      rotationIntervalMs: 45_000,
      rotationDirection: 'random',
      refreshIntervalMs: 90_000,
      includePinned: false,
      allowlist: ['example.com', 'https://*.example.com/*'],
      blocklist: ['blocked.example'],
    };
    expect(handler).toHaveBeenLastCalledWith(
      { type: 'update-settings', settings: savedSettings },
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('#save-status')?.textContent).toBe('Changes saved.'),
    );
    expect(allowlist.value).toBe('example.com\nhttps://*.example.com/*');
    expect(blocklist.value).toBe('blocked.example');
  });
});
