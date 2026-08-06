import { MIN_REFRESH_INTERVAL_MS } from '@/core/defaults';
import type { ActionResultSummary, DomainErrorCode } from '@/core/types';
import type {
  AutomationSnapshot,
  RefreshNowCommand,
  StartRefreshCommand,
  StopRefreshCommand,
} from '@/messaging/protocol';
import { createPopupOperationGate, type PopupOperationGate } from './operation-gate';
import { commandErrorMessage } from './status-view';

export type RefreshControlCommand = StartRefreshCommand | StopRefreshCommand | RefreshNowCommand;

export type RefreshCommandRequestResult =
  | { ok: true; snapshot: AutomationSnapshot; result?: ActionResultSummary }
  | { ok: false; code: DomainErrorCode };

export interface RefreshControlElements {
  region: HTMLElement;
  settingsFieldset: HTMLFieldSetElement;
  interval: HTMLSelectElement;
  customIntervalGroup: HTMLElement;
  customInterval: HTMLInputElement;
  validation: HTMLElement;
  result: HTMLElement;
  startButton: HTMLButtonElement;
  replaceButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  refreshNowButton: HTMLButtonElement;
  confirmation: HTMLElement;
  confirmReplaceButton: HTMLButtonElement;
  cancelReplaceButton: HTMLButtonElement;
}

export interface RefreshControlsController {
  setSnapshot(snapshot: AutomationSnapshot): void;
}

export interface RefreshControlsOptions {
  elements: RefreshControlElements;
  revalidateSelectedTargets(): Promise<readonly string[]>;
  sendCommand(command: RefreshControlCommand): Promise<RefreshCommandRequestResult>;
  refreshSnapshot(): Promise<AutomationSnapshot | null>;
  applySnapshot(snapshot: AutomationSnapshot): void;
  announce(message: string): void;
  operationGate?: PopupOperationGate;
}

const REFRESH_PRESETS = new Set([30_000, 60_000, 300_000]);

function selectedIntervalMs(elements: RefreshControlElements): number | null {
  if (elements.interval.value !== 'custom') {
    const intervalMs = Number(elements.interval.value);
    return Number.isSafeInteger(intervalMs) && intervalMs >= MIN_REFRESH_INTERVAL_MS
      ? intervalMs
      : null;
  }

  const seconds = Number(elements.customInterval.value);
  const intervalMs = seconds * 1_000;
  return Number.isFinite(seconds) &&
    Number.isSafeInteger(intervalMs) &&
    intervalMs >= MIN_REFRESH_INTERVAL_MS
    ? intervalMs
    : null;
}

function selectOption(select: HTMLSelectElement, value: string): boolean {
  const matched = Array.from(select.options).find((option) => option.value === value);

  for (const option of select.options) {
    option.selected = false;
  }

  if (matched === undefined) {
    return false;
  }

  matched.selected = true;
  return true;
}

function syncIntervalControls(elements: RefreshControlElements, intervalMs: number): void {
  if (REFRESH_PRESETS.has(intervalMs)) {
    selectOption(elements.interval, String(intervalMs));
  } else {
    selectOption(elements.interval, 'custom');
    elements.customInterval.value = String(intervalMs / 1_000);
  }
}

function resultMessage(result: ActionResultSummary): string {
  const { succeeded, skipped, failed } = result.counts;
  return `Refresh now complete: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed.`;
}

function commandSuccessMessage(command: StartRefreshCommand | StopRefreshCommand): string {
  return command.type === 'stop-refresh'
    ? 'Refresh schedule stopped.'
    : command.replaceExisting
      ? 'Refresh schedule replaced and started.'
      : 'Refresh schedule started.';
}

export function createRefreshControlsController({
  elements,
  revalidateSelectedTargets,
  sendCommand,
  refreshSnapshot,
  applySnapshot,
  announce,
  operationGate = createPopupOperationGate(),
}: RefreshControlsOptions): RefreshControlsController {
  let snapshot: AutomationSnapshot | null = null;

  function hideConfirmation(): void {
    elements.confirmation.hidden = true;
  }

  function renderIntervalControls(): void {
    elements.customIntervalGroup.hidden = elements.interval.value !== 'custom';
  }

  function renderState(): void {
    const schedule = snapshot?.refresh ?? null;
    const available = snapshot?.capabilities.tabReload === 'available';
    const pending = operationGate.isPending();
    const controlsDisabled = pending || !available;

    elements.region.setAttribute('aria-busy', String(pending));
    elements.settingsFieldset.disabled = controlsDisabled;
    elements.startButton.disabled = controlsDisabled;
    elements.replaceButton.disabled = controlsDisabled;
    elements.stopButton.disabled = controlsDisabled;
    elements.refreshNowButton.disabled = controlsDisabled;
    elements.confirmReplaceButton.disabled = controlsDisabled;
    elements.cancelReplaceButton.disabled = pending;

    elements.startButton.hidden = schedule !== null;
    elements.replaceButton.hidden = schedule === null;
    elements.stopButton.hidden = schedule === null;

    if (schedule === null) {
      hideConfirmation();
    }
  }

  function showValidation(message: string, invalidInterval = false): void {
    elements.validation.textContent = message;
    elements.validation.hidden = false;
    elements.customInterval.setAttribute('aria-invalid', String(invalidInterval));
    announce(message);
  }

  function clearValidation(): void {
    elements.validation.textContent = '';
    elements.validation.hidden = true;
    elements.customInterval.removeAttribute('aria-invalid');
  }

  function showResult(result: ActionResultSummary): string {
    const message = resultMessage(result);
    elements.result.textContent = message;
    elements.result.dataset.tone = result.counts.failed > 0 ? 'attention' : 'neutral';
    elements.result.hidden = false;
    return message;
  }

  async function refreshAfterError(): Promise<void> {
    const refreshed = await refreshSnapshot();

    if (refreshed !== null) {
      snapshot = refreshed;
      applySnapshot(refreshed);
      renderState();
    }
  }

  async function performCommand(
    command: RefreshControlCommand,
    errorFocusTarget: HTMLElement,
  ): Promise<HTMLElement | null> {
    try {
      const response = await sendCommand(command);

      if (response.ok) {
        snapshot = response.snapshot;
        applySnapshot(response.snapshot);
        clearValidation();
        hideConfirmation();

        if (command.type === 'refresh-now') {
          if (response.result === undefined) {
            throw new Error('Refresh-now response did not include an aggregate result.');
          }

          announce(showResult(response.result));
        } else {
          announce(commandSuccessMessage(command));
        }
        return command.type === 'start-refresh' && command.replaceExisting
          ? elements.replaceButton
          : null;
      }

      await refreshAfterError();

      if (response.code === 'replacement-confirmation-required') {
        elements.confirmation.hidden = false;
      }

      showValidation(`Refresh command failed. ${commandErrorMessage(response.code)}`);
      return response.code === 'replacement-confirmation-required'
        ? elements.confirmReplaceButton
        : errorFocusTarget;
    } catch {
      await refreshAfterError();
      showValidation(`Refresh command failed. ${commandErrorMessage('browser-operation-failed')}`);
      return errorFocusTarget;
    }
  }

  async function runCommand(
    command: RefreshControlCommand,
    errorFocusTarget: HTMLElement,
  ): Promise<void> {
    const release = operationGate.tryAcquire();

    if (release === null) {
      return;
    }

    let focusTarget: HTMLElement | null = null;

    try {
      focusTarget = await performCommand(command, errorFocusTarget);
    } finally {
      release();
      focusTarget?.focus();
    }
  }

  async function startRefresh(replaceExisting: boolean): Promise<void> {
    if (operationGate.isPending()) {
      return;
    }

    clearValidation();
    const intervalMs = selectedIntervalMs(elements);

    if (intervalMs === null) {
      showValidation('Enter a refresh interval of at least 30 seconds.', true);
      elements.customInterval.focus();
      return;
    }

    const release = operationGate.tryAcquire();

    if (release === null) {
      return;
    }

    const errorFocusTarget = replaceExisting ? elements.confirmReplaceButton : elements.startButton;
    let focusTarget: HTMLElement | null = null;

    try {
      let targetKeys: readonly string[];

      try {
        targetKeys = await revalidateSelectedTargets();
      } catch {
        targetKeys = [];
      }

      if (targetKeys.length < 1) {
        showValidation('Select at least one eligible tab to start refresh.');
        focusTarget = errorFocusTarget;
        return;
      }

      focusTarget = await performCommand(
        {
          type: 'start-refresh',
          targetKeys,
          intervalMs,
          replaceExisting,
        },
        errorFocusTarget,
      );
    } finally {
      release();
      focusTarget?.focus();
    }
  }

  async function refreshNow(): Promise<void> {
    if (operationGate.isPending()) {
      return;
    }

    clearValidation();
    const release = operationGate.tryAcquire();

    if (release === null) {
      return;
    }

    let focusTarget: HTMLElement | null = null;

    try {
      let targetKeys: readonly string[];

      try {
        targetKeys = await revalidateSelectedTargets();
      } catch {
        targetKeys = [];
      }

      if (targetKeys.length < 1) {
        showValidation('Select at least one eligible tab to refresh now.');
        focusTarget = elements.refreshNowButton;
        return;
      }

      focusTarget = await performCommand(
        { type: 'refresh-now', targetKeys },
        elements.refreshNowButton,
      );
    } finally {
      release();
      focusTarget?.focus();
    }
  }

  elements.interval.addEventListener('change', () => {
    clearValidation();
    hideConfirmation();
    renderIntervalControls();
  });
  elements.customInterval.addEventListener('input', () => {
    clearValidation();
    hideConfirmation();
  });
  elements.startButton.addEventListener('click', () => void startRefresh(false));
  elements.replaceButton.addEventListener('click', () => {
    clearValidation();
    elements.confirmation.hidden = false;
    announce('Confirm whether to replace the current refresh schedule.');
    elements.confirmReplaceButton.focus();
  });
  elements.stopButton.addEventListener(
    'click',
    () => void runCommand({ type: 'stop-refresh' }, elements.stopButton),
  );
  elements.refreshNowButton.addEventListener('click', () => void refreshNow());
  elements.confirmReplaceButton.addEventListener('click', () => void startRefresh(true));
  elements.cancelReplaceButton.addEventListener('click', () => {
    hideConfirmation();
    announce('Refresh replacement cancelled.');
    elements.replaceButton.focus();
  });

  operationGate.subscribe(renderState);
  renderIntervalControls();
  renderState();

  return {
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
      syncIntervalControls(
        elements,
        nextSnapshot.refresh?.intervalMs ?? nextSnapshot.settings.refreshIntervalMs,
      );
      clearValidation();
      hideConfirmation();
      renderIntervalControls();
      renderState();
    },
  };
}
