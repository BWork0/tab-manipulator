import type { DomainErrorCode } from '@/core/types';
import type { CommandResponse, GetSnapshotCommand, AutomationSnapshot } from '@/messaging/protocol';
import { browser } from 'wxt/browser';
import './style.css';
import { commandErrorMessage, formatNextRun, popupSnapshotModel } from './status-view';

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
  workspaceDescription: HTMLElement;
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
    workspaceDescription: requiredElement('workspace-description'),
    announcement: requiredElement('status-announcement'),
  };
}

function renderLoading(elements: PopupElements): void {
  elements.statusRegion.setAttribute('aria-busy', 'true');
  elements.statusIndicator.dataset.tone = 'neutral';
  elements.statusLabel.textContent = 'Loading';
  elements.statusDescription.textContent = 'Checking your automation state…';
  elements.nextAction.hidden = true;
  elements.lastResult.hidden = true;
  elements.unsupportedState.hidden = true;
  elements.commandError.hidden = true;
  elements.retryButton.disabled = true;
  elements.workspaceDescription.textContent = 'Loading automation controls…';
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

  elements.workspaceDescription.textContent =
    snapshot.status === 'idle'
      ? 'No automation is running. Tab selection and controls will appear here.'
      : 'Automation controls will appear here for the active schedule.';
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
  elements.workspaceDescription.textContent = 'Controls are unavailable until status loads.';
  elements.announcement.textContent = `Status unavailable. ${message}`;
}

async function requestSnapshot(elements: PopupElements): Promise<void> {
  renderLoading(elements);
  const command = { type: 'get-snapshot' } satisfies GetSnapshotCommand;

  try {
    const response = (await browser.runtime.sendMessage(command)) as
      CommandResponse<GetSnapshotCommand> | undefined;

    if (response?.command !== command.type) {
      renderCommandError(elements, 'unexpected-error');
      return;
    }

    if (response.ok) {
      renderSnapshot(elements, response.data);
    } else {
      renderCommandError(elements, response.error.code);
    }
  } catch {
    renderCommandError(elements, 'browser-operation-failed');
  }
}

function main(): void {
  const elements = getElements();
  elements.retryButton.addEventListener('click', () => void requestSnapshot(elements));
  void requestSnapshot(elements);
}

main();
