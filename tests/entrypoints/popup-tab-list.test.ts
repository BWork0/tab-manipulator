import {
  createTabSelectionController,
  renderTabList,
  type TabSelectionElements,
} from '@/entrypoints/popup/tab-list';
import type { TabListItem } from '@/messaging/protocol';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

function createDocument() {
  const { document, window } = parseHTML(`
    <section id="region" aria-busy="true">
      <button id="refresh" type="button">Refresh tabs</button>
      <button id="select-all" type="button">Select all eligible</button>
      <button id="clear" type="button">Clear</button>
      <p id="summary"></p>
      <p id="loading"></p>
      <p id="empty" hidden></p>
      <div id="error" hidden><p id="error-description"></p></div>
      <ul id="list"></ul>
    </section>
  `);

  return { document, window };
}

function required<TElement extends Element>(document: Document, selector: string): TElement {
  const element = document.querySelector(selector);

  if (element === null) {
    throw new Error(`Missing test element: ${selector}.`);
  }

  return element as TElement;
}

function elements(document: Document): TabSelectionElements {
  return {
    region: required(document, '#region'),
    list: required(document, '#list'),
    loadingState: required(document, '#loading'),
    emptyState: required(document, '#empty'),
    errorState: required(document, '#error'),
    errorDescription: required(document, '#error-description'),
    selectionSummary: required(document, '#summary'),
    selectAllButton: required(document, '#select-all'),
    clearButton: required(document, '#clear'),
    refreshButton: required(document, '#refresh'),
  };
}

function tab(overrides: Partial<TabListItem> = {}): TabListItem {
  return {
    key: 'tab:1',
    tabId: 1,
    windowId: 1,
    url: 'https://one.example/dashboard',
    title: 'Dashboard',
    index: 0,
    pinned: false,
    active: false,
    eligibility: { eligible: true },
    ...overrides,
  };
}

describe('popup tab selection', () => {
  it('renders safe fallbacks, domains, pinned state, and visible disabled reasons', () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const tabs = [
      tab({ title: '<img src=x onerror=alert(1)>', pinned: true }),
      tab({
        key: 'tab:2',
        tabId: undefined,
        url: undefined,
        title: undefined,
        index: 1,
        eligibility: { eligible: false, reason: 'missing-url' },
      }),
    ];

    renderTabList(elements(document), tabs, new Set());

    expect(page.document.querySelectorAll('.tab-item')).toHaveLength(2);
    expect(page.document.querySelector('.tab-item__title')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
    expect(page.document.querySelector('img[src="x"]')).toBeNull();
    expect(page.document.querySelector('.tab-item__metadata')?.textContent).toContain(
      'one.example',
    );
    expect(page.document.querySelector('.tab-item__pinned')?.textContent).toBe('Pinned');
    expect(page.document.querySelectorAll('input[type="checkbox"]')[1]).toMatchObject({
      disabled: true,
    });
    expect(page.document.querySelector('.tab-item__reason')?.textContent).toContain(
      'Address unavailable',
    );
    expect(page.document.querySelectorAll('.tab-item__title')[1]?.textContent).toBe('Untitled tab');
  });

  it('uses native controls for individual, select-all, and clear interaction', async () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const requestTabList = vi.fn().mockResolvedValue({
      ok: true,
      tabs: [
        tab(),
        tab({ key: 'tab:2', tabId: 2, index: 1, url: 'https://two.example/' }),
        tab({
          key: 'tab:3',
          tabId: 3,
          index: 2,
          url: 'chrome://settings/',
          eligibility: { eligible: false, reason: 'browser-internal-url' },
        }),
      ],
    });
    const controller = createTabSelectionController({
      elements: elements(document),
      requestTabList,
      scheduleFaviconLoad: (callback) => callback(),
    });

    await controller.load();
    const checkboxes = page.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]?.type).toBe('checkbox');
    expect(required<HTMLButtonElement>(document, '#select-all').type).toBe('button');

    checkboxes[0]!.checked = true;
    checkboxes[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    expect(controller.selectedTargetKeys()).toEqual(['tab:1']);

    required<HTMLButtonElement>(document, '#select-all').click();
    expect(controller.selectedTargetKeys()).toEqual(['tab:1', 'tab:2']);

    required<HTMLButtonElement>(document, '#clear').click();
    expect(controller.selectedTargetKeys()).toEqual([]);
  });

  it('re-queries and removes missing or newly ineligible selections before a command', async () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const requestTabList = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        tabs: [tab(), tab({ key: 'tab:2', tabId: 2, index: 1 })],
      })
      .mockResolvedValueOnce({
        ok: true,
        tabs: [tab({ eligibility: { eligible: false, reason: 'extension-url' } })],
      });
    const controller = createTabSelectionController({
      elements: elements(document),
      requestTabList,
    });

    await controller.load();
    required<HTMLButtonElement>(document, '#select-all').click();

    await expect(controller.revalidateForCommand()).resolves.toEqual([]);
    expect(requestTabList).toHaveBeenCalledTimes(2);
  });

  it('renders a readable error without exposing stale targets when tab discovery fails', async () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const announce = vi.fn();
    const controller = createTabSelectionController({
      elements: elements(document),
      requestTabList: vi.fn().mockResolvedValue({
        ok: false,
        code: 'browser-operation-failed',
      }),
      announce,
    });

    await expect(controller.load()).resolves.toBe(false);
    expect(required<HTMLElement>(document, '#error').hidden).toBe(false);
    expect(required<HTMLElement>(document, '#error-description').textContent).toContain(
      'could not return',
    );
    expect(controller.selectedTargetKeys()).toEqual([]);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('Tabs unavailable'));
  });

  it('defers favicon URLs until after rows and controls are interactive', () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const scheduled: Array<() => void> = [];
    const viewElements = elements(document);

    renderTabList(
      viewElements,
      [tab({ favIconUrl: 'https://one.example/favicon.ico' })],
      new Set(),
      (callback) => scheduled.push(callback),
    );

    const favicon = required<HTMLImageElement>(document, 'img');
    expect(favicon.getAttribute('src')).toBeNull();
    expect(viewElements.selectAllButton.disabled).toBe(false);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!();
    expect(favicon.src).toBe('https://one.example/favicon.ico');
  });

  it('renders 100 synthetic rows in under 500 ms', () => {
    const page = createDocument();
    const syntheticTabs = Array.from({ length: 100 }, (_, index) =>
      tab({
        key: `tab:${index + 1}`,
        tabId: index + 1,
        index,
        url: `https://dashboard-${index}.example/`,
        title: `Dashboard ${index + 1}`,
        favIconUrl: `https://dashboard-${index}.example/favicon.ico`,
      }),
    );
    const startedAt = performance.now();

    renderTabList(
      elements(page.document as unknown as Document),
      syntheticTabs,
      new Set(),
      () => undefined,
    );

    const durationMs = performance.now() - startedAt;
    console.info(`T041 synthetic 100-row render: ${durationMs.toFixed(2)} ms.`);
    expect(page.document.querySelectorAll('.tab-item')).toHaveLength(100);
    expect(durationMs).toBeLessThan(500);
  });
});
