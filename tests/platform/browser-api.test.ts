import {
  createBrowserApiAdapter,
  type BrowserOperationResult,
  type ToolbarState,
} from '@/platform/browser-api';
import {
  detectBrowserCapabilities,
  type BrowserApiLike,
  type BrowserToolbarApiLike,
} from '@/platform/capabilities';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { describe, expect, it, vi } from 'vitest';

const TOOLBAR_STATE: ToolbarState = {
  text: 'ON',
  backgroundColor: '#2563eb',
  title: 'Tab Manipulator is running.',
};

function fakeApi(): BrowserApiLike {
  return fakeBrowser as unknown as BrowserApiLike;
}

function expectError(
  result: BrowserOperationResult<unknown>,
  code: string,
  operation: string,
): void {
  expect(result).toEqual({ ok: false, error: { code, operation } });
}

describe.sequential('browser API adapter', () => {
  it('queries current-window and all-window tabs in deterministic browser order', async () => {
    const firstWindow = await fakeBrowser.windows.create({ focused: true });

    if (firstWindow?.id === undefined) {
      throw new Error('The fake browser did not create the first test window.');
    }

    const firstTab = await fakeBrowser.tabs.create({
      windowId: firstWindow.id,
      url: 'https://first.example/',
      active: true,
    });
    const secondTab = await fakeBrowser.tabs.create({
      windowId: firstWindow.id,
      url: 'https://second.example/',
      pinned: true,
    });
    const secondWindow = await fakeBrowser.windows.create({ focused: false });

    if (secondWindow?.id === undefined) {
      throw new Error('The fake browser did not create the second test window.');
    }

    const otherWindowTab = await fakeBrowser.tabs.create({
      windowId: secondWindow.id,
      url: 'https://other.example/',
    });
    const adapter = createBrowserApiAdapter(fakeApi());

    await expect(adapter.queryCurrentWindowTabs()).resolves.toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          key: `tab:${firstTab.id}`,
          tabId: firstTab.id,
          windowId: firstWindow.id,
          index: 0,
          active: true,
          url: 'https://first.example/',
        }),
        expect.objectContaining({
          key: `tab:${secondTab.id}`,
          tabId: secondTab.id,
          windowId: firstWindow.id,
          index: 1,
          pinned: true,
          url: 'https://second.example/',
        }),
      ],
    });

    const allTabs = await adapter.queryAllWindowTabs();
    expect(allTabs.ok).toBe(true);
    if (allTabs.ok) {
      expect(allTabs.value.map(({ tabId }) => tabId)).toEqual([
        0,
        firstTab.id,
        secondTab.id,
        otherWindowTab.id,
      ]);
    }
  });

  it('normalizes missing optional tab data without crashing', async () => {
    const adapter = createBrowserApiAdapter({
      tabs: {
        query: async () => [{ index: 4, pinned: false, active: false }],
      },
    });

    await expect(adapter.queryCurrentWindowTabs()).resolves.toEqual({
      ok: true,
      value: [
        {
          key: 'tab-without-id:unknown-window:4',
          index: 4,
          pinned: false,
          active: false,
        },
      ],
    });
  });

  it('activates and reloads a tab through the wrapped browser operations', async () => {
    const currentWindow = await fakeBrowser.windows.create({ focused: true });

    if (currentWindow?.id === undefined) {
      throw new Error('The fake browser did not create the test window.');
    }

    const tab = await fakeBrowser.tabs.create({
      windowId: currentWindow.id,
      url: 'https://target.example/',
    });
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload').mockResolvedValue(undefined);
    const adapter = createBrowserApiAdapter(fakeApi());

    await expect(adapter.activateTab(tab.id as number)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(adapter.reloadTab(tab.id as number)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(fakeBrowser.tabs.get(tab.id as number)).resolves.toEqual(
      expect.objectContaining({ active: true }),
    );
    expect(reload).toHaveBeenCalledWith(tab.id);
  });

  it('updates badge text, color, title, and opens the options page', async () => {
    const openOptionsPage = vi
      .spyOn(fakeBrowser.runtime, 'openOptionsPage')
      .mockResolvedValue(undefined);
    const adapter = createBrowserApiAdapter(fakeApi());

    await expect(adapter.updateToolbarState(TOOLBAR_STATE)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(adapter.openOptionsPage()).resolves.toEqual({ ok: true, value: undefined });
    await expect(fakeBrowser.action.getBadgeText({})).resolves.toBe('ON');
    await expect(fakeBrowser.action.getBadgeBackgroundColor({})).resolves.toEqual([
      37, 99, 235, 255,
    ]);
    await expect(fakeBrowser.action.getTitle({})).resolves.toBe('Tab Manipulator is running.');
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it('uses the legacy toolbar namespace only inside the platform compatibility branch', async () => {
    const legacyToolbar: BrowserToolbarApiLike = {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setTitle: vi.fn(),
    };
    const adapter = createBrowserApiAdapter({ browserAction: legacyToolbar });

    expect(adapter.capabilities.toolbarState).toBe('available');
    await expect(adapter.updateToolbarState(TOOLBAR_STATE)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(legacyToolbar.setBadgeText).toHaveBeenCalledWith({ text: 'ON' });
  });

  it('reports granular unavailable capabilities and stable missing-API errors', async () => {
    const adapter = createBrowserApiAdapter({});

    expect(adapter.capabilities).toEqual({
      currentWindowTabQuery: 'unavailable',
      allWindowTabQuery: 'unavailable',
      tabActivation: 'unavailable',
      tabReload: 'unavailable',
      toolbarState: 'unavailable',
      optionsPage: 'unavailable',
    });
    expectError(
      await adapter.queryCurrentWindowTabs(),
      'browser-api-unavailable',
      'query-current-window-tabs',
    );
    expectError(
      await adapter.queryAllWindowTabs(),
      'browser-api-unavailable',
      'query-all-window-tabs',
    );
    expectError(await adapter.activateTab(1), 'browser-api-unavailable', 'activate-tab');
    expectError(await adapter.reloadTab(1), 'browser-api-unavailable', 'reload-tab');
    expectError(
      await adapter.updateToolbarState(TOOLBAR_STATE),
      'browser-api-unavailable',
      'update-toolbar-state',
    );
    expectError(await adapter.openOptionsPage(), 'browser-api-unavailable', 'open-options-page');
  });

  it('requires every toolbar operation before advertising toolbar availability', () => {
    expect(
      detectBrowserCapabilities({
        action: {
          setBadgeText: vi.fn(),
          setBadgeBackgroundColor: vi.fn(),
        },
      }).toolbarState,
    ).toBe('unavailable');
  });

  it('converts rejected browser operations into operation-specific domain error codes', async () => {
    const rejectedApi: BrowserApiLike = {
      tabs: {
        query: vi.fn().mockRejectedValue(new Error('private query details')),
        update: vi.fn().mockRejectedValue(new Error('private activation details')),
        reload: vi.fn().mockRejectedValue(new Error('private reload details')),
      },
      action: {
        setBadgeText: vi.fn().mockRejectedValue(new Error('private toolbar details')),
        setBadgeBackgroundColor: vi.fn(),
        setTitle: vi.fn(),
      },
      runtime: {
        openOptionsPage: vi.fn().mockRejectedValue(new Error('private options details')),
      },
    };
    const adapter = createBrowserApiAdapter(rejectedApi);

    expectError(
      await adapter.queryCurrentWindowTabs(),
      'browser-operation-failed',
      'query-current-window-tabs',
    );
    expectError(
      await adapter.queryAllWindowTabs(),
      'browser-operation-failed',
      'query-all-window-tabs',
    );
    expectError(await adapter.activateTab(1), 'tab-activation-failed', 'activate-tab');
    expectError(await adapter.reloadTab(1), 'tab-reload-failed', 'reload-tab');
    expectError(
      await adapter.updateToolbarState(TOOLBAR_STATE),
      'browser-operation-failed',
      'update-toolbar-state',
    );
    expectError(await adapter.openOptionsPage(), 'browser-operation-failed', 'open-options-page');
  });
});
