import type { DomainErrorCode } from '@/core/types';
import type {
  AutomationSnapshot,
  CommandResponse,
  GetSnapshotCommand,
  GetTabListCommand,
} from '@/messaging/protocol';
import { browser } from 'wxt/browser';
import './style.css';
import { commandErrorMessage, formatNextRun, popupSnapshotModel } from './status-view';
import {
  createTabSelectionController,
  type TabListRequestResult,
  type TabSelectionElements,
} from './tab-list';
import {
  createRotationControlsController,
  type RotationCommandRequestResult,
  type RotationControlCommand,
  type RotationControlElements,
} from './rotation-controls';

interface PopupElements {
  statusRegion: HTMLElement;
  statusIndicator: HTMLElement;
  statusLabel: HTMLElement;
  statusDescription: HTMLElement;
  nextAction: HTMLElement;
  nextActionLabel: HTMLElement;
  nextActionTime: HTMLTimeElement;
  lastResult: HTMLElement;
  unsupportedState: HTMLElement;
  unsupportedDescription: HTMLElement;
  commandError: HTMLElement;
  errorDescription: HTMLElement;
  retryButton: HTMLButtonElement;
  announcement: HTMLElement;
}

function requiredElement<TElement extends HTMLElement>(id: string): TElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);

  if (element === null) {
    throw new Error(`Missing popup element: ${id}.`);
  }

  return element as TElement;
}

function getElements(): PopupElements {
  return {
    statusRegion: requiredElement('status-region'),
    statusIndicator: requiredElement('status-indicator'),
    statusLabel: requiredElement('status-label'),
    statusDescription: requiredElement('status-description'),
    nextAction: requiredElement('next-action'),
    nextActionLabel: requiredElement('next-action-label'),
    nextActionTime: requiredElement<HTMLTimeElement>('next-action-time'),
    lastResult: requiredElement('last-result'),
    unsupportedState: requiredElement('unsupported-state'),
    unsupportedDescription: requiredElement('unsupported-description'),
    commandError: requiredElement('command-error'),
    errorDescription: requiredElement('error-description'),
    retryButton: requiredElement<HTMLButtonElement>('retry-button'),
    announcement: requiredElement('status-announcement'),
  };
}

function getTabSelectionElements(): TabSelectionElements {
  return {
    region: requiredElement('tab-selection-region'),
    list: requiredElement<HTMLUListElement>('tab-list'),
    loadingState: requiredElement('tab-list-loading'),
    emptyState: requiredElement('tab-list-empty'),
    errorState: requiredElement('tab-list-error'),
    errorDescription: requiredElement('tab-list-error-description'),
    selectionSummary: requiredElement('selection-summary'),
    selectAllButton: requiredElement<HTMLButtonElement>('select-all-tabs-button'),
    clearButton: requiredElement<HTMLButtonElement>('clear-tabs-button'),
    refreshButton: requiredElement<HTMLButtonElement>('refresh-tabs-button'),
  };
}

function getRotationControlElements(): RotationControlElements {
  return {
    region: requiredElement('rotation-region'),
    settingsFieldset: requiredElement<HTMLFieldSetElement>('rotation-settings'),
    interval: requiredElement<HTMLSelectElement>('rotation-interval'),
    customIntervalGroup: requiredElement('rotation-custom-interval-group'),
    customInterval: requiredElement<HTMLInputElement>('rotation-custom-interval'),
    direction: requiredElement<HTMLSelectElement>('rotation-direction'),
    bestEffortNote: requiredElement('rotation-timing-note'),
    validation: requiredElement('rotation-validation'),
    primaryButton: requiredElement<HTMLButtonElement>('rotation-primary-button'),
    replaceButton: requiredElement<HTMLButtonElement>('rotation-replace-button'),
    stopButton: requiredElement<HTMLButtonElement>('rotation-stop-button'),
    confirmation: requiredElement('rotation-replacement-confirmation'),
    confirmReplaceButton: requiredElement<HTMLButtonElement>('rotation-confirm-replace-button'),
    cancelReplaceButton: requiredElement<HTMLButtonElement>('rotation-cancel-replace-button'),
  };
}

function renderLoading(elements: PopupElements): void {
  elements.statusRegion.setAttribute('aria-busy', 'true');
  elements.statusIndicator.dataset.tone = 'neutral';
  elements.statusLabel.textContent = 'Loading';
  elements.statusDescription.textContent = 'Checking your automation state\u2026';
  elements.nextAction.hidden = true;
  elements.lastResult.hidden = true;
  elements.unsupportedState.hidden = true;
  elements.commandError.hidden = true;
  elements.retryButton.disabled = true;
}

function renderSnapshot(elements: PopupElements, snapshot: AutomationSnapshot): void {
  const model = popupSnapshotModel(snapshot);

  elements.statusRegion.setAttribute('aria-busy', 'false');
  elements.statusIndicator.dataset.tone = model.status.tone;
  elements.statusLabel.textContent = model.status.label;
  elements.statusDescription.textContent = model.status.description;
  elements.commandError.hidden = true;
  elements.retryButton.disabled = false;

  if (model.nextAction === undefined) {
    elements.nextAction.hidden = true;
  } else {
    elements.nextActionLabel.textContent = model.nextAction.label;
    elements.nextActionTime.dateTime = new Date(model.nextAction.at).toISOString();
    elements.nextActionTime.textContent = formatNextRun(model.nextAction.at);
    elements.nextAction.hidden = false;
  }

  if (model.lastResult === undefined) {
    elements.lastResult.hidden = true;
  } else {
    elements.lastResult.dataset.tone = model.lastResult.tone;
    elements.lastResult.textContent = model.lastResult.text;
    elements.lastResult.hidden = false;
  }

  if (model.unavailableFeatures.length === 0) {
    elements.unsupportedState.hidden = true;
  } else {
    elements.unsupportedDescription.textContent = `Unavailable: ${model.unavailableFeatures.join(', ')}.`;
    elements.unsupportedState.hidden = false;
  }

  elements.announcement.textContent = `Automation status: ${model.status.label}. ${model.status.description}`;
}

function renderCommandError(elements: PopupElements, code: DomainErrorCode): void {
  const message = commandErrorMessage(code);

  elements.statusRegion.setAttribute('aria-busy', 'false');
  elements.statusIndicator.dataset.tone = 'attention';
  elements.statusLabel.textContent = 'Status unavailable';
  elements.statusDescription.textContent = 'Automation state could not be loaded.';
  elements.nextAction.hidden = true;
  elements.lastResult.hidden = true;
  elements.unsupportedState.hidden = true;
  elements.errorDescription.textContent = message;
  elements.commandError.hidden = false;
  elements.retryButton.disabled = false;
  elements.announcement.textContent = `Status unavailable. ${message}`;
}

async function requestSnapshot(
  elements: PopupElements,
  applySnapshot?: (snapshot: AutomationSnapshot) => void,
): Promise<AutomationSnapshot | null> {
  renderLoading(elements);
  const command = { type: 'get-snapshot' } satisfies GetSnapshotCommand;

  try {
    const response = (await browser.runtime.sendMessage(command)) as
      CommandResponse<GetSnapshotCommand> | undefined;

    if (response?.command !== command.type) {
      renderCommandError(elements, 'unexpected-error');
      return null;
    }

    if (response.ok) {
      renderSnapshot(elements, response.data);
      applySnapshot?.(response.data);
      return response.data;
    } else {
      renderCommandError(elements, response.error.code);
      return null;
    }
  } catch {
    renderCommandError(elements, 'browser-operation-failed');
    return null;
  }
}

async function requestTabList(): Promise<TabListRequestResult> {
  const command = { type: 'get-tab-list' } satisfies GetTabListCommand;

  try {
    const response = (await browser.runtime.sendMessage(command)) as
      CommandResponse<GetTabListCommand> | undefined;

    if (response?.command !== command.type) {
      return { ok: false, code: 'unexpected-error' };
    }

    return response.ok
      ? { ok: true, tabs: response.data }
      : { ok: false, code: response.error.code };
  } catch {
    return { ok: false, code: 'browser-operation-failed' };
  }
}

async function sendRotationCommand(
  command: RotationControlCommand,
): Promise<RotationCommandRequestResult> {
  try {
    const response = (await browser.runtime.sendMessage(command)) as
      CommandResponse<RotationControlCommand> | undefined;

    if (response?.command !== command.type) {
      return { ok: false, code: 'unexpected-error' };
    }

    return response.ok
      ? { ok: true, snapshot: response.data }
      : { ok: false, code: response.error.code };
  } catch {
    return { ok: false, code: 'browser-operation-failed' };
  }
}

function main(): void {
  const elements = getElements();
  const tabSelection = createTabSelectionController({
    elements: getTabSelectionElements(),
    requestTabList,
    announce(message) {
      elements.announcement.textContent = message;
    },
  });
  const rotationControls = createRotationControlsController({
    elements: getRotationControlElements(),
    revalidateSelectedTargets: () => tabSelection.revalidateForCommand(),
    sendCommand: sendRotationCommand,
    refreshSnapshot: () => requestSnapshot(elements),
    applySnapshot(snapshot) {
      renderSnapshot(elements, snapshot);
      rotationControls.setSnapshot(snapshot);
    },
    announce(message) {
      elements.announcement.textContent = message;
    },
  });

  elements.retryButton.addEventListener(
    'click',
    () => void requestSnapshot(elements, (snapshot) => rotationControls.setSnapshot(snapshot)),
  );
  void requestSnapshot(elements, (snapshot) => rotationControls.setSnapshot(snapshot));
  void tabSelection.load();
}

main();
