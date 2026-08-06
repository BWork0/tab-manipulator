import type { TabIneligibilityReason } from '@/core/tab-eligibility';
import type { DomainErrorCode } from '@/core/types';
import type { TabListItem } from '@/messaging/protocol';
import { commandErrorMessage } from './status-view';

export interface TabSelectionElements {
  region: HTMLElement;
  list: HTMLUListElement;
  loadingState: HTMLElement;
  emptyState: HTMLElement;
  errorState: HTMLElement;
  errorDescription: HTMLElement;
  selectionSummary: HTMLElement;
  selectAllButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
  refreshButton: HTMLButtonElement;
}

export type TabListRequestResult =
  { ok: true; tabs: readonly TabListItem[] } | { ok: false; code: DomainErrorCode };

export interface TabSelectionController {
  load(): Promise<boolean>;
  selectedTargetKeys(): readonly string[];
  /** Refreshes browser state and returns only keys that remain present and eligible. */
  revalidateForCommand(): Promise<readonly string[]>;
}

export interface TabSelectionControllerOptions {
  elements: TabSelectionElements;
  requestTabList(): Promise<TabListRequestResult>;
  announce?(message: string): void;
  scheduleFaviconLoad?(callback: () => void): void;
}

const INELIGIBILITY_MESSAGES: Readonly<Record<TabIneligibilityReason, string>> = {
  'missing-url': 'Address unavailable; this tab cannot be automated.',
  'malformed-url': 'The tab address is invalid and cannot be automated.',
  'browser-internal-url': 'Browser pages cannot be automated.',
  'extension-url': 'Extension pages cannot be automated.',
  'unsupported-scheme': 'This page type cannot be automated.',
};

function defaultScheduleFaviconLoad(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => callback());
    return;
  }

  globalThis.setTimeout(callback, 0);
}

function displayTitle(tab: TabListItem): string {
  const title = tab.title?.trim();
  return title === undefined || title === '' ? 'Untitled tab' : title;
}

export function displayDomain(url: string | undefined): string {
  if (url === undefined || url.trim() === '') {
    return 'Address unavailable';
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.slice(0, -1) || 'Address unavailable';
  } catch {
    return 'Address unavailable';
  }
}

function eligibleTabs(tabs: readonly TabListItem[]): readonly TabListItem[] {
  return tabs.filter((tab) => tab.eligibility.eligible);
}

export function revalidateSelectedKeys(
  selectedKeys: ReadonlySet<string>,
  tabs: readonly TabListItem[],
): Set<string> {
  return new Set(
    tabs
      .filter((tab) => tab.eligibility.eligible && selectedKeys.has(tab.key))
      .map((tab) => tab.key),
  );
}

function selectionSummary(selectedCount: number, eligibleCount: number): string {
  if (eligibleCount === 0) {
    return 'No eligible tabs';
  }

  return `${selectedCount} of ${eligibleCount} eligible ${eligibleCount === 1 ? 'tab' : 'tabs'} selected`;
}

function faviconElement(document: Document): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'tab-item__favicon';
  image.alt = '';
  image.width = 20;
  image.height = 20;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.hidden = true;
  return image;
}

function hashKey(key: string): number {
  let hash = 0;

  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }

  return hash;
}

function createTabRow(
  document: Document,
  tab: TabListItem,
  selectedKeys: ReadonlySet<string>,
  deferredFavicons: Array<() => void>,
): HTMLLIElement {
  const eligible = tab.eligibility.eligible;
  const item = document.createElement('li');
  item.className = 'tab-item';
  item.dataset.eligible = String(eligible);

  const label = document.createElement('label');
  label.className = 'tab-item__label';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tab-item__checkbox';
  checkbox.dataset.tabKey = tab.key;
  checkbox.checked = eligible && selectedKeys.has(tab.key);
  checkbox.disabled = !eligible;

  const faviconSlot = document.createElement('span');
  faviconSlot.className = 'tab-item__favicon-slot';
  faviconSlot.setAttribute('aria-hidden', 'true');
  const favicon = faviconElement(document);
  faviconSlot.append(favicon);
  const content = document.createElement('span');
  content.className = 'tab-item__content';

  const title = document.createElement('span');
  title.className = 'tab-item__title';
  title.textContent = displayTitle(tab);

  const metadata = document.createElement('span');
  metadata.className = 'tab-item__metadata';

  const domain = document.createElement('span');
  domain.textContent = displayDomain(tab.url);
  metadata.append(domain);

  if (tab.pinned) {
    const pinned = document.createElement('span');
    pinned.className = 'tab-item__pinned';
    pinned.textContent = 'Pinned';
    metadata.append(pinned);
  }

  if (tab.active) {
    const active = document.createElement('span');
    active.className = 'visually-hidden';
    active.textContent = 'Current tab';
    metadata.append(active);
  }

  content.append(title, metadata);
  label.append(checkbox, faviconSlot, content);
  item.append(label);

  if (!tab.eligibility.eligible) {
    const reason = document.createElement('p');
    reason.className = 'tab-item__reason';
    reason.id = `tab-disabled-${tab.index}-${Math.abs(hashKey(tab.key))}`;
    reason.textContent = INELIGIBILITY_MESSAGES[tab.eligibility.reason];
    checkbox.setAttribute('aria-describedby', reason.id);
    item.append(reason);
  }

  const favIconUrl = tab.favIconUrl?.trim();

  if (favIconUrl) {
    deferredFavicons.push(() => {
      favicon.addEventListener('load', () => {
        favicon.hidden = false;
      });
      favicon.addEventListener('error', () => {
        favicon.remove();
      });
      favicon.src = favIconUrl;
    });
  } else {
    favicon.remove();
  }

  return item;
}

export function renderTabList(
  elements: TabSelectionElements,
  tabs: readonly TabListItem[],
  selectedKeys: ReadonlySet<string>,
  scheduleFaviconLoad: (callback: () => void) => void = defaultScheduleFaviconLoad,
): void {
  const document = elements.list.ownerDocument;
  const fragment = document.createDocumentFragment();
  const deferredFavicons: Array<() => void> = [];

  for (const tab of tabs) {
    fragment.append(createTabRow(document, tab, selectedKeys, deferredFavicons));
  }

  elements.list.replaceChildren(fragment);
  const eligibleCount = eligibleTabs(tabs).length;
  elements.region.setAttribute('aria-busy', 'false');
  elements.loadingState.hidden = true;
  elements.errorState.hidden = true;
  elements.emptyState.hidden = tabs.length !== 0;
  elements.list.hidden = tabs.length === 0;
  elements.selectionSummary.textContent = selectionSummary(selectedKeys.size, eligibleCount);
  elements.selectAllButton.disabled = eligibleCount === 0 || selectedKeys.size === eligibleCount;
  elements.clearButton.disabled = selectedKeys.size === 0;
  elements.refreshButton.disabled = false;

  if (deferredFavicons.length > 0) {
    scheduleFaviconLoad(() => {
      for (const loadFavicon of deferredFavicons) {
        loadFavicon();
      }
    });
  }
}

export function createTabSelectionController({
  elements,
  requestTabList,
  announce = () => undefined,
  scheduleFaviconLoad = defaultScheduleFaviconLoad,
}: TabSelectionControllerOptions): TabSelectionController {
  let tabs: readonly TabListItem[] = [];
  let selectedKeys = new Set<string>();

  function render(): void {
    renderTabList(elements, tabs, selectedKeys, scheduleFaviconLoad);
  }

  function renderLoading(): void {
    elements.region.setAttribute('aria-busy', 'true');
    elements.loadingState.hidden = false;
    elements.errorState.hidden = true;
    elements.refreshButton.disabled = true;
  }

  function renderError(code: DomainErrorCode): void {
    const message = commandErrorMessage(code);
    elements.region.setAttribute('aria-busy', 'false');
    elements.loadingState.hidden = true;
    elements.emptyState.hidden = true;
    elements.errorDescription.textContent = message;
    elements.errorState.hidden = false;
    elements.refreshButton.disabled = false;
    announce(`Tabs unavailable. ${message}`);
  }

  async function load(shouldAnnounce = false): Promise<boolean> {
    renderLoading();
    const result = await requestTabList();

    if (!result.ok) {
      renderError(result.code);
      return false;
    }

    tabs = [...result.tabs].sort((left, right) => left.index - right.index);
    selectedKeys = revalidateSelectedKeys(selectedKeys, tabs);
    render();

    if (shouldAnnounce) {
      announce(`Tab list updated. ${elements.selectionSummary.textContent}.`);
    }

    return true;
  }

  elements.list.addEventListener('change', (event) => {
    const target = event.target;
    const inputConstructor = elements.list.ownerDocument.defaultView?.HTMLInputElement;

    if (inputConstructor === undefined || !(target instanceof inputConstructor)) {
      return;
    }

    const key = target.dataset.tabKey;
    const tab = tabs.find((candidate) => candidate.key === key);

    if (key === undefined || tab === undefined || !tab.eligibility.eligible || target.disabled) {
      target.checked = false;
      return;
    }

    if (target.checked) {
      selectedKeys.add(tab.key);
    } else {
      selectedKeys.delete(tab.key);
    }

    render();
  });

  elements.selectAllButton.addEventListener('click', () => {
    selectedKeys = new Set(eligibleTabs(tabs).map((tab) => tab.key));
    render();
    announce(elements.selectionSummary.textContent ?? 'Tab selection updated.');
  });

  elements.clearButton.addEventListener('click', () => {
    selectedKeys.clear();
    render();
    announce('Tab selection cleared.');
  });

  elements.refreshButton.addEventListener('click', () => void load(true));

  return {
    load: () => load(false),
    selectedTargetKeys: () => [...selectedKeys],
    async revalidateForCommand() {
      return (await load(false)) ? [...selectedKeys] : [];
    },
  };
}
