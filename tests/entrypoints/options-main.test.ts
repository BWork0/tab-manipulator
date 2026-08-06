import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { AutomationSnapshot } from '@/messaging/protocol';
import { createRuntimeMessageListener } from '@/messaging/protocol';
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

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('options entrypoint', () => {
  it('loads and renders the current typed settings through the background protocol', async () => {
    const { document, window } = parseHTML(`
      <main id="settings-region" aria-busy="true">
        <form id="settings-form">
          <dl id="settings-summary">
            <dd id="rotation-interval-summary"></dd>
            <dd id="rotation-direction-summary"></dd>
            <dd id="refresh-interval-summary"></dd>
            <dd id="pinned-tabs-summary"></dd>
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
    expect(document.querySelector('#rotation-interval-summary')?.textContent).toBe('1 minute');
    expect(document.querySelector('#rotation-direction-summary')?.textContent).toBe(
      'Backward (right to left)',
    );
    expect(document.querySelector('#refresh-interval-summary')?.textContent).toBe('5 minutes');
    expect(document.querySelector('#pinned-tabs-summary')?.textContent).toBe('Included');
    expect(document.querySelector('#allowlist-summary')?.textContent).toBe('1 rule');
    expect(document.querySelector('#blocklist-summary')?.textContent).toBe('2 rules');
    expect(document.querySelector('#settings-region')?.getAttribute('aria-busy')).toBe('false');
  });
});
