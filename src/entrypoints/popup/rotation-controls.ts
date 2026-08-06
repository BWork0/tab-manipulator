import { MIN_ROTATION_INTERVAL_MS } from '@/core/defaults';
import type { DomainErrorCode, RotationDirection } from '@/core/types';
import type {
  AutomationSnapshot,
  PauseRotationCommand,
  ResumeRotationCommand,
  StartRotationCommand,
  StopRotationCommand,
} from '@/messaging/protocol';
import { createPopupOperationGate, type PopupOperationGate } from './operation-gate';
import { commandErrorMessage } from './status-view';

export type RotationControlCommand =
  StartRotationCommand | PauseRotationCommand | ResumeRotationCommand | StopRotationCommand;

export type RotationCommandRequestResult =
  { ok: true; snapshot: AutomationSnapshot } | { ok: false; code: DomainErrorCode };

export interface RotationControlElements {
  region: HTMLElement;
  settingsFieldset: HTMLFieldSetElement;
  interval: HTMLSelectElement;
  customIntervalGroup: HTMLElement;
  customInterval: HTMLInputElement;
  direction: HTMLSelectElement;
  bestEffortNote: HTMLElement;
  validation: HTMLElement;
  primaryButton: HTMLButtonElement;
  replaceButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  confirmation: HTMLElement;
  confirmReplaceButton: HTMLButtonElement;
  cancelReplaceButton: HTMLButtonElement;
}

export interface RotationControlsController {
  setSnapshot(snapshot: AutomationSnapshot): void;
}

export interface RotationControlsOptions {
  elements: RotationControlElements;
  revalidateSelectedTargets(): Promise<readonly string[]>;
  sendCommand(command: RotationControlCommand): Promise<RotationCommandRequestResult>;
  refreshSnapshot(): Promise<AutomationSnapshot | null>;
  applySnapshot(snapshot: AutomationSnapshot): void;
  announce(message: string): void;
  operationGate?: PopupOperationGate;
}

const ROTATION_PRESETS = new Set([10_000, 30_000, 60_000]);

function isDirection(value: string): value is RotationDirection {
  return value === 'forward' || value === 'backward' || value === 'random';
}

function selectedIntervalMs(elements: RotationControlElements): number | null {
  if (elements.interval.value !== 'custom') {
    const intervalMs = Number(elements.interval.value);
    return Number.isSafeInteger(intervalMs) && intervalMs >= MIN_ROTATION_INTERVAL_MS
      ? intervalMs
      : null;
  }

  const seconds = Number(elements.customInterval.value);
  const intervalMs = seconds * 1_000;
  return Number.isFinite(seconds) && Number.isSafeInteger(intervalMs) && intervalMs >= 10_000
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

function syncIntervalControls(elements: RotationControlElements, intervalMs: number): void {
  if (ROTATION_PRESETS.has(intervalMs)) {
    selectOption(elements.interval, String(intervalMs));
  } else {
    selectOption(elements.interval, 'custom');
    elements.customInterval.value = String(intervalMs / 1_000);
  }
}

function commandSuccessMessage(command: RotationControlCommand): string {
  switch (command.type) {
    case 'start-rotation':
      return command.replaceExisting ? 'Rotation replaced and started.' : 'Rotation started.';
    case 'pause-rotation':
      return 'Rotation paused.';
    case 'resume-rotation':
      return 'Rotation resumed.';
    case 'stop-rotation':
      return 'Rotation stopped.';
  }
}

export function createRotationControlsController({
  elements,
  revalidateSelectedTargets,
  sendCommand,
  refreshSnapshot,
  applySnapshot,
  announce,
  operationGate = createPopupOperationGate(),
}: RotationControlsOptions): RotationControlsController {
  let snapshot: AutomationSnapshot | null = null;

  function hideConfirmation(): void {
    elements.confirmation.hidden = true;
  }

  function renderTimingNote(): void {
    const intervalMs = selectedIntervalMs(elements);
    elements.customIntervalGroup.hidden = elements.interval.value !== 'custom';
    elements.bestEffortNote.hidden = intervalMs === null || intervalMs >= 30_000;
  }

  function renderState(): void {
    const session = snapshot?.rotation ?? null;
    const available = snapshot?.capabilities.tabActivation === 'available';
    const pending = operationGate.isPending();
    const controlsDisabled = pending || !available;

    elements.region.setAttribute('aria-busy', String(pending));
    elements.settingsFieldset.disabled = controlsDisabled;
    elements.primaryButton.disabled = controlsDisabled;
    elements.replaceButton.disabled = controlsDisabled;
    elements.stopButton.disabled = controlsDisabled;
    elements.confirmReplaceButton.disabled = controlsDisabled;
    elements.cancelReplaceButton.disabled = pending;

    if (session === null) {
      elements.primaryButton.textContent = 'Start rotation';
      elements.primaryButton.hidden = false;
      elements.replaceButton.hidden = true;
      elements.stopButton.hidden = true;
      hideConfirmation();
      return;
    }

    elements.stopButton.hidden = false;
    elements.replaceButton.hidden = false;

    if (session.state === 'running') {
      elements.primaryButton.textContent = 'Pause rotation';
      elements.primaryButton.hidden = false;
    } else if (session.state === 'paused') {
      elements.primaryButton.textContent = 'Resume rotation';
      elements.primaryButton.hidden = false;
    } else {
      elements.primaryButton.hidden = true;
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

  async function refreshAfterError(): Promise<void> {
    const refreshed = await refreshSnapshot();

    if (refreshed !== null) {
      snapshot = refreshed;
      renderState();
    }
  }

  async function performCommand(
    command: RotationControlCommand,
    errorFocusTarget: HTMLElement,
  ): Promise<HTMLElement | null> {
    try {
      const result = await sendCommand(command);

      if (result.ok) {
        snapshot = result.snapshot;
        applySnapshot(result.snapshot);
        clearValidation();
        hideConfirmation();
        announce(commandSuccessMessage(command));
        return command.type === 'start-rotation' && command.replaceExisting
          ? elements.replaceButton
          : null;
      }

      if (result.code === 'replacement-confirmation-required') {
        elements.confirmation.hidden = false;
      }

      await refreshAfterError();
      showValidation(`Rotation command failed. ${commandErrorMessage(result.code)}`);
      return result.code === 'replacement-confirmation-required'
        ? elements.confirmReplaceButton
        : errorFocusTarget;
    } catch {
      await refreshAfterError();
      showValidation(`Rotation command failed. ${commandErrorMessage('browser-operation-failed')}`);
      return errorFocusTarget;
    }
  }

  async function runCommand(
    command: RotationControlCommand,
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

  async function startRotation(replaceExisting: boolean): Promise<void> {
    if (operationGate.isPending()) {
      return;
    }

    clearValidation();
    const intervalMs = selectedIntervalMs(elements);

    if (intervalMs === null) {
      showValidation('Enter a rotation interval of at least 10 seconds.', true);
      elements.customInterval.focus();
      return;
    }

    const direction = elements.direction.value;

    if (!isDirection(direction)) {
      showValidation('Choose a valid rotation direction.');
      elements.direction.focus();
      return;
    }

    const release = operationGate.tryAcquire();

    if (release === null) {
      return;
    }

    const errorFocusTarget = replaceExisting
      ? elements.confirmReplaceButton
      : elements.primaryButton;
    let focusTarget: HTMLElement | null = null;

    try {
      let targetKeys: readonly string[];

      try {
        targetKeys = await revalidateSelectedTargets();
      } catch {
        targetKeys = [];
      }

      if (targetKeys.length < 2) {
        showValidation('Select at least two eligible tabs to start rotation.');
        focusTarget = errorFocusTarget;
        return;
      }

      focusTarget = await performCommand(
        {
          type: 'start-rotation',
          targetKeys,
          intervalMs,
          direction,
          replaceExisting,
        },
        errorFocusTarget,
      );
    } finally {
      release();
      focusTarget?.focus();
    }
  }

  elements.interval.addEventListener('change', () => {
    clearValidation();
    hideConfirmation();
    renderTimingNote();
  });
  elements.customInterval.addEventListener('input', () => {
    clearValidation();
    hideConfirmation();
    renderTimingNote();
  });
  elements.direction.addEventListener('change', () => {
    clearValidation();
    hideConfirmation();
  });

  elements.primaryButton.addEventListener('click', () => {
    const state = snapshot?.rotation?.state;

    if (state === 'running') {
      void runCommand({ type: 'pause-rotation' }, elements.primaryButton);
    } else if (state === 'paused') {
      void runCommand({ type: 'resume-rotation' }, elements.primaryButton);
    } else if (snapshot?.rotation === null) {
      void startRotation(false);
    }
  });
  elements.replaceButton.addEventListener('click', () => {
    clearValidation();
    elements.confirmation.hidden = false;
    announce('Confirm whether to replace the current rotation.');
    elements.confirmReplaceButton.focus();
  });
  elements.stopButton.addEventListener(
    'click',
    () => void runCommand({ type: 'stop-rotation' }, elements.stopButton),
  );
  elements.confirmReplaceButton.addEventListener('click', () => void startRotation(true));
  elements.cancelReplaceButton.addEventListener('click', () => {
    hideConfirmation();
    announce('Rotation replacement cancelled.');
    elements.replaceButton.focus();
  });

  operationGate.subscribe(renderState);
  renderTimingNote();
  renderState();

  return {
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
      const persistedRotation = nextSnapshot.rotation;
      syncIntervalControls(
        elements,
        persistedRotation?.intervalMs ?? nextSnapshot.settings.rotationIntervalMs,
      );
      selectOption(
        elements.direction,
        persistedRotation?.direction ?? nextSnapshot.settings.rotationDirection,
      );
      clearValidation();
      hideConfirmation();
      renderTimingNote();
      renderState();
    },
  };
}
