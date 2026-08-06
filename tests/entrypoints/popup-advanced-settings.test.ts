import { DEFAULT_SETTINGS } from '@/core/defaults';
import {
  activeSettingsSummary,
  createAdvancedSettingsController,
  type AdvancedSettingsElements,
} from '@/entrypoints/popup/advanced-settings';
import { createPopupOperationGate } from '@/entrypoints/popup/operation-gate';
import type { AutomationSnapshot } from '@/messaging/protocol';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

function createDocument() {
  const { document, window } = parseHTML(`
    <section id="region" aria-busy="false">
      <p id="summary"></p>
      <button id="button" type="button">Advanced settings</button>
      <p id="error" hidden></p>
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

function elements(document: Document): AdvancedSettingsElements {
  return {
    region: required(document, '#region'),
    summary: required(document, '#summary'),
    button: required(document, '#button'),
    error: required(document, '#error'),
  };
}

function snapshot(optionsPage: 'available' | 'unavailable' = 'available'): AutomationSnapshot {
  return {
    status: 'idle',
    settings: {
      ...DEFAULT_SETTINGS,
      includePinned: true,
      allowlist: ['example.com'],
      blocklist: ['https://private.example/*', 'blocked.example'],
    },
    rotation: null,
    refresh: null,
    capabilities: {
      currentWindowTabQuery: 'available',
      allWindowTabQuery: 'available',
      tabActivation: 'available',
      tabReload: 'available',
      toolbarState: 'available',
      optionsPage,
    },
  };
}

describe('popup advanced settings', () => {
  it('summarizes the active pinned and URL-filter settings', () => {
    expect(activeSettingsSummary(DEFAULT_SETTINGS)).toBe(
      'Pinned tabs excluded. All otherwise eligible URLs allowed. No blocklist rules.',
    );
    expect(activeSettingsSummary(snapshot().settings)).toBe(
      'Pinned tabs included. 1 allowlist rule active. 2 blocklist rules active.',
    );
  });

  it('opens the options page through the adapter and suppresses duplicate submission', async () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const viewElements = elements(document);
    const operationGate = createPopupOperationGate();
    let resolveOpen: (() => void) | undefined;
    const openOptionsPage = vi.fn().mockReturnValue(
      new Promise<{ ok: true; value: undefined }>((resolve) => {
        resolveOpen = () => resolve({ ok: true, value: undefined });
      }),
    );
    const announce = vi.fn();
    const controller = createAdvancedSettingsController({
      elements: viewElements,
      browser: { openOptionsPage },
      announce,
      operationGate,
    });
    controller.setSnapshot(snapshot());

    viewElements.button.click();
    viewElements.button.click();

    expect(openOptionsPage).toHaveBeenCalledOnce();
    expect(operationGate.isPending()).toBe(true);
    expect(viewElements.button.disabled).toBe(true);
    expect(viewElements.region.getAttribute('aria-busy')).toBe('true');

    resolveOpen?.();
    await vi.waitFor(() => expect(operationGate.isPending()).toBe(false));
    expect(viewElements.button.disabled).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('Advanced settings opened.');
  });

  it('shows adapter failures, restores focus, and disables unavailable navigation', async () => {
    const page = createDocument();
    const document = page.document as unknown as Document;
    const viewElements = elements(document);
    const focus = vi.spyOn(viewElements.button, 'focus');
    const announce = vi.fn();
    const controller = createAdvancedSettingsController({
      elements: viewElements,
      browser: {
        openOptionsPage: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'browser-operation-failed', operation: 'open-options-page' },
        }),
      },
      announce,
    });
    controller.setSnapshot(snapshot());
    viewElements.button.click();

    await vi.waitFor(() => expect(viewElements.error.hidden).toBe(false));
    expect(viewElements.error.textContent).toContain('could not be opened');
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('could not be opened'));
    expect(focus).toHaveBeenCalledOnce();

    controller.setSnapshot(snapshot('unavailable'));
    expect(viewElements.button.disabled).toBe(true);
    expect(viewElements.error.textContent).toBe(
      'Advanced settings are unavailable in this browser.',
    );
  });
});
