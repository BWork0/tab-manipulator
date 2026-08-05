import type { CapabilityState } from '../core/types';

export interface BrowserTabLike {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  index?: number;
  pinned?: boolean;
  active?: boolean;
}

export interface BrowserTabsApiLike {
  query?: (
    queryInfo: Readonly<Record<string, unknown>>,
  ) => Promise<readonly BrowserTabLike[]> | readonly BrowserTabLike[];
  update?: (
    tabId: number,
    updateProperties: { active: true },
  ) => Promise<BrowserTabLike | undefined> | BrowserTabLike | undefined;
  reload?: (tabId: number) => Promise<void> | void;
}

export interface BrowserToolbarApiLike {
  setBadgeText?: (details: { text: string }) => Promise<void> | void;
  setBadgeBackgroundColor?: (details: { color: string }) => Promise<void> | void;
  setTitle?: (details: { title: string }) => Promise<void> | void;
}

export interface BrowserRuntimeApiLike {
  openOptionsPage?: () => Promise<void> | void;
}

export interface BrowserApiLike {
  tabs?: BrowserTabsApiLike;
  action?: BrowserToolbarApiLike;
  /** Firefox MV2 and older Chromium targets expose the toolbar as browserAction. */
  browserAction?: BrowserToolbarApiLike;
  runtime?: BrowserRuntimeApiLike;
}

export interface BrowserCapabilities {
  currentWindowTabQuery: CapabilityState;
  allWindowTabQuery: CapabilityState;
  tabActivation: CapabilityState;
  tabReload: CapabilityState;
  toolbarState: CapabilityState;
  optionsPage: CapabilityState;
}

function capability(value: unknown): CapabilityState {
  return typeof value === 'function' ? 'available' : 'unavailable';
}

/** Keeps the toolbar namespace compatibility branch out of core and application services. */
export function resolveToolbarApi(api: BrowserApiLike): BrowserToolbarApiLike | undefined {
  if (api.action) {
    return api.action;
  }

  return api.browserAction;
}

/** Detects every browser operation required by the MVP without invoking an API. */
export function detectBrowserCapabilities(api: BrowserApiLike): BrowserCapabilities {
  const tabQuery = capability(api.tabs?.query);
  const toolbar = resolveToolbarApi(api);
  const toolbarState =
    capability(toolbar?.setBadgeText) === 'available' &&
    capability(toolbar?.setBadgeBackgroundColor) === 'available' &&
    capability(toolbar?.setTitle) === 'available'
      ? 'available'
      : 'unavailable';

  return Object.freeze({
    currentWindowTabQuery: tabQuery,
    allWindowTabQuery: tabQuery,
    tabActivation: capability(api.tabs?.update),
    tabReload: capability(api.tabs?.reload),
    toolbarState,
    optionsPage: capability(api.runtime?.openOptionsPage),
  });
}
