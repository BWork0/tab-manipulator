import type { DomainErrorCode } from '../core/types';
import {
  detectBrowserCapabilities,
  resolveToolbarApi,
  type BrowserApiLike,
  type BrowserCapabilities,
  type BrowserTabLike,
} from './capabilities';
import { browser } from 'wxt/browser';

export const BROWSER_OPERATIONS = [
  'query-current-window-tabs',
  'query-all-window-tabs',
  'activate-tab',
  'reload-tab',
  'update-toolbar-state',
  'open-options-page',
] as const;

export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

export interface BrowserOperationError {
  code: DomainErrorCode;
  operation: BrowserOperation;
}

export type BrowserOperationResult<T> =
  { ok: true; value: T } | { ok: false; error: BrowserOperationError };

export interface BrowserTabSnapshot {
  /** Stable for tabs with a browser session ID and opaque for missing-ID fallback entries. */
  key: string;
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  index: number;
  pinned: boolean;
  active: boolean;
}

export interface ToolbarState {
  text: string;
  backgroundColor: string;
  title: string;
}

export interface BrowserApiAdapter {
  readonly capabilities: BrowserCapabilities;
  queryCurrentWindowTabs(): Promise<BrowserOperationResult<readonly BrowserTabSnapshot[]>>;
  queryAllWindowTabs(): Promise<BrowserOperationResult<readonly BrowserTabSnapshot[]>>;
  activateTab(tabId: number): Promise<BrowserOperationResult<void>>;
  reloadTab(tabId: number): Promise<BrowserOperationResult<void>>;
  updateToolbarState(state: ToolbarState): Promise<BrowserOperationResult<void>>;
  openOptionsPage(): Promise<BrowserOperationResult<void>>;
}

function success<T>(value: T): BrowserOperationResult<T> {
  return { ok: true, value };
}

function failure<T>(operation: BrowserOperation, code: DomainErrorCode): BrowserOperationResult<T> {
  return { ok: false, error: { code, operation } };
}

function operationFailureCode(operation: BrowserOperation): DomainErrorCode {
  if (operation === 'activate-tab') {
    return 'tab-activation-failed';
  }

  if (operation === 'reload-tab') {
    return 'tab-reload-failed';
  }

  return 'browser-operation-failed';
}

function sessionKey(tab: BrowserTabLike, fallbackIndex: number): string {
  if (Number.isInteger(tab.id)) {
    return `tab:${tab.id}`;
  }

  const windowPart = Number.isInteger(tab.windowId) ? tab.windowId : 'unknown-window';
  const indexPart = Number.isInteger(tab.index) ? tab.index : fallbackIndex;
  return `tab-without-id:${windowPart}:${indexPart}`;
}

function tabSnapshot(tab: BrowserTabLike, fallbackIndex: number): BrowserTabSnapshot {
  return {
    key: sessionKey(tab, fallbackIndex),
    ...(Number.isInteger(tab.id) ? { tabId: tab.id } : {}),
    ...(Number.isInteger(tab.windowId) ? { windowId: tab.windowId } : {}),
    ...(typeof tab.url === 'string' ? { url: tab.url } : {}),
    ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
    ...(typeof tab.favIconUrl === 'string' ? { favIconUrl: tab.favIconUrl } : {}),
    index: Number.isInteger(tab.index) ? (tab.index as number) : fallbackIndex,
    pinned: tab.pinned === true,
    active: tab.active === true,
  };
}

function sortCurrentWindowTabs(tabs: BrowserTabSnapshot[]): void {
  tabs.sort((left, right) => left.index - right.index || left.key.localeCompare(right.key));
}

function sortAllWindowTabs(tabs: BrowserTabSnapshot[]): void {
  tabs.sort(
    (left, right) =>
      (left.windowId ?? Number.MAX_SAFE_INTEGER) - (right.windowId ?? Number.MAX_SAFE_INTEGER) ||
      left.index - right.index ||
      left.key.localeCompare(right.key),
  );
}

/** Creates a side-effect-free wrapper; browser operations run only when a method is called. */
export function createBrowserApiAdapter(
  api: BrowserApiLike = browser as unknown as BrowserApiLike,
): BrowserApiAdapter {
  const capabilities = detectBrowserCapabilities(api);

  async function queryTabs(
    operation: Extract<BrowserOperation, 'query-current-window-tabs' | 'query-all-window-tabs'>,
    queryInfo: Readonly<Record<string, unknown>>,
  ): Promise<BrowserOperationResult<readonly BrowserTabSnapshot[]>> {
    if (typeof api.tabs?.query !== 'function') {
      return failure(operation, 'browser-api-unavailable');
    }

    try {
      const rawTabs = await api.tabs.query(queryInfo);
      const snapshots = rawTabs.map(tabSnapshot);

      if (operation === 'query-current-window-tabs') {
        sortCurrentWindowTabs(snapshots);
      } else {
        sortAllWindowTabs(snapshots);
      }

      return success(snapshots);
    } catch {
      return failure(operation, operationFailureCode(operation));
    }
  }

  return {
    capabilities,

    queryCurrentWindowTabs() {
      return queryTabs('query-current-window-tabs', { currentWindow: true });
    },

    queryAllWindowTabs() {
      return queryTabs('query-all-window-tabs', {});
    },

    async activateTab(tabId) {
      const operation = 'activate-tab';

      if (typeof api.tabs?.update !== 'function') {
        return failure(operation, 'browser-api-unavailable');
      }

      try {
        await api.tabs.update(tabId, { active: true });
        return success(undefined);
      } catch {
        return failure(operation, operationFailureCode(operation));
      }
    },

    async reloadTab(tabId) {
      const operation = 'reload-tab';

      if (typeof api.tabs?.reload !== 'function') {
        return failure(operation, 'browser-api-unavailable');
      }

      try {
        await api.tabs.reload(tabId);
        return success(undefined);
      } catch {
        return failure(operation, operationFailureCode(operation));
      }
    },

    async updateToolbarState(state) {
      const operation = 'update-toolbar-state';
      const toolbar = resolveToolbarApi(api);

      if (capabilities.toolbarState === 'unavailable' || !toolbar) {
        return failure(operation, 'browser-api-unavailable');
      }

      try {
        await toolbar.setBadgeText?.({ text: state.text });
        await toolbar.setBadgeBackgroundColor?.({ color: state.backgroundColor });
        await toolbar.setTitle?.({ title: state.title });
        return success(undefined);
      } catch {
        return failure(operation, operationFailureCode(operation));
      }
    },

    async openOptionsPage() {
      const operation = 'open-options-page';

      if (typeof api.runtime?.openOptionsPage !== 'function') {
        return failure(operation, 'browser-api-unavailable');
      }

      try {
        await api.runtime.openOptionsPage();
        return success(undefined);
      } catch {
        return failure(operation, operationFailureCode(operation));
      }
    },
  };
}
