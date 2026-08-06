import type { Settings } from '@/core/types';
import type { AutomationSnapshot } from '@/messaging/protocol';
import type { BrowserApiAdapter } from '@/platform/browser-api';
import { commandErrorMessage } from './status-view';
import { createPopupOperationGate, type PopupOperationGate } from './operation-gate';

export interface AdvancedSettingsElements {
  region: HTMLElement;
  summary: HTMLElement;
  button: HTMLButtonElement;
  error: HTMLElement;
}

export interface AdvancedSettingsController {
  setSnapshot(snapshot: AutomationSnapshot): void;
}

export interface AdvancedSettingsOptions {
  elements: AdvancedSettingsElements;
  browser: Pick<BrowserApiAdapter, 'openOptionsPage'>;
  announce(message: string): void;
  operationGate?: PopupOperationGate;
}

function ruleCount(count: number, listName: 'allowlist' | 'blocklist'): string {
  return `${count} ${listName} ${count === 1 ? 'rule' : 'rules'} active`;
}

/** Summarizes the shared settings that currently determine tab eligibility. */
export function activeSettingsSummary(settings: Settings): string {
  const pinned = settings.includePinned ? 'Pinned tabs included' : 'Pinned tabs excluded';
  const allowlist =
    settings.allowlist.length === 0
      ? 'All otherwise eligible URLs allowed'
      : ruleCount(settings.allowlist.length, 'allowlist');
  const blocklist =
    settings.blocklist.length === 0
      ? 'No blocklist rules'
      : ruleCount(settings.blocklist.length, 'blocklist');

  return `${pinned}. ${allowlist}. ${blocklist}.`;
}

export function createAdvancedSettingsController({
  elements,
  browser,
  announce,
  operationGate = createPopupOperationGate(),
}: AdvancedSettingsOptions): AdvancedSettingsController {
  let available = false;

  function renderState(): void {
    const pending = operationGate.isPending();
    elements.region.setAttribute('aria-busy', String(pending));
    elements.button.disabled = pending || !available;
  }

  operationGate.subscribe(renderState);

  elements.button.addEventListener('click', () => {
    const release = operationGate.tryAcquire();

    if (release === null) {
      return;
    }

    void (async () => {
      let restoreFocus = false;

      try {
        elements.error.hidden = true;
        const result = await browser.openOptionsPage();

        if (result.ok) {
          announce('Advanced settings opened.');
          return;
        }

        const message = `Advanced settings could not be opened. ${commandErrorMessage(result.error.code)}`;
        elements.error.textContent = message;
        elements.error.hidden = false;
        announce(message);
        restoreFocus = true;
      } catch {
        const message = `Advanced settings could not be opened. ${commandErrorMessage('browser-operation-failed')}`;
        elements.error.textContent = message;
        elements.error.hidden = false;
        announce(message);
        restoreFocus = true;
      } finally {
        release();

        if (restoreFocus) {
          elements.button.focus();
        }
      }
    })();
  });

  renderState();

  return {
    setSnapshot(snapshot) {
      elements.summary.textContent = activeSettingsSummary(snapshot.settings);
      available = snapshot.capabilities.optionsPage === 'available';

      if (!available) {
        elements.error.textContent = 'Advanced settings are unavailable in this browser.';
        elements.error.hidden = false;
      } else {
        elements.error.hidden = true;
      }

      renderState();
    },
  };
}
