import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { RotationSession, Timestamp } from '@/core/types';
import {
  createRotationControlsController,
  type RotationControlElements,
  type RotationControlsOptions,
} from '@/entrypoints/popup/rotation-controls';
import { createPopupOperationGate } from '@/entrypoints/popup/operation-gate';
import type { AutomationSnapshot } from '@/messaging/protocol';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000 as Timestamp;

function createDocument() {
  const { document, window } = parseHTML(`
    <section id="region" aria-busy="false">
      <fieldset id="settings">
        <select id="interval">
          <option value="10000">10 seconds</option>
          <option value="30000">30 seconds</option>
          <option value="60000">1 minute</option>
          <option value="custom">Custom</option>
        </select>
        <div id="custom-group" hidden>
          <input id="custom" type="number" value="10" />
        </div>
        <select id="direction">
          <option value="forward">Forward</option>
          <option value="backward">Backward</option>
          <option value="random">Random</option>
        </select>
      </fieldset>
      <p id="timing"></p>
      <p id="validation" hidden></p>
      <button id="primary" type="button">Start rotation</button>
      <button id="replace" type="button" hidden>Replace rotation</button>
      <button id="stop" type="button" hidden>Stop rotation</button>
      <div id="confirmation" hidden>
        <button id="confirm" type="button">Replace and start</button>
        <button id="cancel" type="button">Cancel</button>
      </div>
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

function selectValue(select: HTMLSelectElement, value: string): void {
  const selected = Array.from(select.options).find((option) => option.value === value);

  for (const option of select.options) {
    option.selected = false;
  }

  selected!.selected = true;
}

function elements(document: Document): RotationControlElements {
  return {
    region: required(document, '#region'),
    settingsFieldset: required(document, '#settings'),
    interval: required(document, '#interval'),
    customIntervalGroup: required(document, '#custom-group'),
    customInterval: required(document, '#custom'),
    direction: required(document, '#direction'),
    bestEffortNote: required(document, '#timing'),
    validation: required(document, '#validation'),
    primaryButton: required(document, '#primary'),
    replaceButton: required(document, '#replace'),
    stopButton: required(document, '#stop'),
    confirmation: required(document, '#confirmation'),
    confirmReplaceButton: required(document, '#confirm'),
    cancelReplaceButton: required(document, '#cancel'),
  };
}

function rotation(
  state: 'running' | 'paused' | 'needs-attention',
  overrides: Partial<RotationSession> = {},
): RotationSession {
  const base = {
    schemaVersion: 1 as const,
    id: 'rotation-1',
    targets: [],
    sourceWindowId: 1,
    intervalMs: 30_000,
    direction: 'forward' as const,
    cursor: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };

  if (state === 'running') {
    return { ...base, state, nextRunAt: (NOW + base.intervalMs) as Timestamp } as RotationSession;
  }

  if (state === 'paused') {
    return { ...base, state } as RotationSession;
  }

  return {
    ...base,
    state,
    attentionReason: 'ambiguous-recovery',
  } as RotationSession;
}

function snapshot(session: RotationSession | null = null): AutomationSnapshot {
  return {
    status:
      session === null
        ? 'idle'
        : session.state === 'running'
          ? 'rotating'
          : session.state === 'paused'
            ? 'rotation-paused'
            : 'needs-attention',
    settings: DEFAULT_SETTINGS,
    rotation: session,
    refresh: null,
    capabilities: {
      currentWindowTabQuery: 'available',
      allWindowTabQuery: 'available',
      tabActivation: 'available',
      tabReload: 'available',
      toolbarState: 'available',
      optionsPage: 'available',
    },
    ...(session?.state === 'running' ? { nextRunAt: session.nextRunAt } : {}),
  };
}

function createHarness(overrides: Partial<RotationControlsOptions> = {}) {
  const page = createDocument();
  const document = page.document as unknown as Document;
  const viewElements = elements(document);
  const revalidateSelectedTargets = vi.fn().mockResolvedValue(['tab:1', 'tab:2']);
  const sendCommand = vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot() });
  const refreshSnapshot = vi.fn().mockResolvedValue(snapshot());
  const applySnapshot = vi.fn();
  const announce = vi.fn();
  const controller = createRotationControlsController({
    elements: viewElements,
    revalidateSelectedTargets,
    sendCommand,
    refreshSnapshot,
    applySnapshot,
    announce,
    ...overrides,
  });

  return {
    page,
    document,
    elements: viewElements,
    controller,
    revalidateSelectedTargets,
    sendCommand,
    refreshSnapshot,
    applySnapshot,
    announce,
  };
}

describe('popup rotation controls', () => {
  it('reflects persisted settings and active session state', () => {
    const harness = createHarness();
    harness.controller.setSnapshot(
      snapshot(rotation('paused', { intervalMs: 45_000, direction: 'backward' })),
    );

    expect(harness.elements.interval.value).toBe('custom');
    expect(harness.elements.customInterval.value).toBe('45');
    expect(harness.elements.direction.value).toBe('backward');
    expect(harness.elements.primaryButton.textContent).toBe('Resume rotation');
    expect(harness.elements.stopButton.hidden).toBe(false);
    expect(harness.elements.replaceButton.hidden).toBe(false);
    expect(harness.elements.bestEffortNote.hidden).toBe(true);

    selectValue(harness.elements.interval, '10000');
    harness.elements.interval.dispatchEvent(new harness.page.window.Event('change'));
    expect(harness.elements.bestEffortNote.hidden).toBe(false);
  });

  it('validates the 10-second minimum and at least two revalidated targets', async () => {
    const harness = createHarness();
    harness.controller.setSnapshot(snapshot());
    selectValue(harness.elements.interval, 'custom');
    harness.elements.customInterval.value = '9';
    harness.elements.primaryButton.click();

    expect(harness.sendCommand).not.toHaveBeenCalled();
    expect(harness.elements.validation.textContent).toContain('at least 10 seconds');
    expect(harness.elements.customInterval.getAttribute('aria-invalid')).toBe('true');

    harness.elements.customInterval.value = '10';
    harness.revalidateSelectedTargets.mockResolvedValueOnce(['tab:1']);
    harness.elements.primaryButton.click();
    await vi.waitFor(() => expect(harness.revalidateSelectedTargets).toHaveBeenCalledOnce());

    expect(harness.sendCommand).not.toHaveBeenCalled();
    expect(harness.elements.validation.textContent).toContain('at least two eligible tabs');
  });

  it('starts from the current selection and applies the returned persisted snapshot', async () => {
    const started = snapshot(rotation('running', { intervalMs: 60_000, direction: 'random' }));
    const harness = createHarness();
    harness.sendCommand.mockResolvedValueOnce({ ok: true, snapshot: started });
    harness.controller.setSnapshot(snapshot());
    selectValue(harness.elements.interval, '60000');
    selectValue(harness.elements.direction, 'random');
    harness.elements.primaryButton.click();

    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledOnce());
    expect(harness.sendCommand).toHaveBeenCalledWith({
      type: 'start-rotation',
      targetKeys: ['tab:1', 'tab:2'],
      intervalMs: 60_000,
      direction: 'random',
      replaceExisting: false,
    });
    expect(harness.applySnapshot).toHaveBeenCalledWith(started);
    expect(harness.announce).toHaveBeenLastCalledWith('Rotation started.');
    expect(harness.elements.primaryButton.textContent).toBe('Pause rotation');
  });

  it('dispatches pause, resume, and stop from persisted state', async () => {
    const harness = createHarness();
    const restoredStartFocus = vi.spyOn(harness.elements.primaryButton, 'focus');
    harness.controller.setSnapshot(snapshot(rotation('running')));
    harness.elements.primaryButton.click();
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenLastCalledWith({ type: 'pause-rotation' }),
    );
    await vi.waitFor(() => expect(harness.elements.primaryButton.disabled).toBe(false));

    harness.controller.setSnapshot(snapshot(rotation('paused')));
    harness.elements.primaryButton.click();
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenLastCalledWith({ type: 'resume-rotation' }),
    );
    await vi.waitFor(() => expect(harness.elements.primaryButton.disabled).toBe(false));

    harness.controller.setSnapshot(snapshot(rotation('running')));
    harness.elements.stopButton.click();
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenLastCalledWith({ type: 'stop-rotation' }),
    );
    expect(harness.sendCommand).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => {
      expect(harness.elements.primaryButton.hidden).toBe(false);
      expect(harness.elements.primaryButton.textContent).toBe('Start rotation');
      expect(restoredStartFocus).toHaveBeenCalledOnce();
    });
  });

  it('requires inline confirmation before replacing a rotation', async () => {
    const harness = createHarness();
    const confirmationFocus = vi.spyOn(harness.elements.confirmReplaceButton, 'focus');
    const restoredFocus = vi.spyOn(harness.elements.replaceButton, 'focus');
    harness.controller.setSnapshot(snapshot(rotation('running')));
    harness.elements.replaceButton.click();

    expect(harness.elements.confirmation.hidden).toBe(false);
    expect(harness.sendCommand).not.toHaveBeenCalled();
    expect(confirmationFocus).toHaveBeenCalledOnce();

    harness.elements.cancelReplaceButton.click();
    expect(harness.elements.confirmation.hidden).toBe(true);
    expect(restoredFocus).toHaveBeenCalledOnce();

    harness.elements.replaceButton.click();

    harness.elements.confirmReplaceButton.click();
    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledOnce());
    expect(harness.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start-rotation', replaceExisting: true }),
    );
    expect(harness.announce).toHaveBeenLastCalledWith('Rotation replaced and started.');
  });

  it('suppresses double submission while a command is pending', async () => {
    let resolveCommand: ((value: { ok: true; snapshot: AutomationSnapshot }) => void) | undefined;
    const pendingCommand = new Promise<{ ok: true; snapshot: AutomationSnapshot }>((resolve) => {
      resolveCommand = resolve;
    });
    const harness = createHarness();
    harness.sendCommand.mockReturnValueOnce(pendingCommand);
    harness.controller.setSnapshot(snapshot(rotation('running')));

    harness.elements.primaryButton.click();
    harness.elements.primaryButton.click();
    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledOnce());
    expect(harness.elements.primaryButton.disabled).toBe(true);

    resolveCommand?.({ ok: true, snapshot: snapshot(rotation('paused')) });
    await vi.waitFor(() => expect(harness.elements.primaryButton.disabled).toBe(false));
    expect(harness.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('disables every rotation command control while another popup operation is pending', () => {
    const operationGate = createPopupOperationGate();
    const harness = createHarness({ operationGate });
    harness.controller.setSnapshot(snapshot(rotation('running')));

    const release = operationGate.tryAcquire();

    expect(harness.elements.region.getAttribute('aria-busy')).toBe('true');
    expect(harness.elements.settingsFieldset.disabled).toBe(true);
    expect(harness.elements.primaryButton.disabled).toBe(true);
    expect(harness.elements.replaceButton.disabled).toBe(true);
    expect(harness.elements.stopButton.disabled).toBe(true);

    release?.();
    expect(harness.elements.region.getAttribute('aria-busy')).toBe('false');
    expect(harness.elements.primaryButton.disabled).toBe(false);
  });

  it('refreshes persisted state and announces typed command failures', async () => {
    const active = snapshot(rotation('running'));
    const harness = createHarness();
    const confirmationFocus = vi.spyOn(harness.elements.confirmReplaceButton, 'focus');
    harness.sendCommand.mockResolvedValueOnce({
      ok: false,
      code: 'replacement-confirmation-required',
    });
    harness.refreshSnapshot.mockResolvedValueOnce(active);
    harness.controller.setSnapshot(snapshot());
    harness.elements.primaryButton.click();

    await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledOnce());
    expect(harness.elements.confirmation.hidden).toBe(false);
    expect(harness.elements.primaryButton.textContent).toBe('Pause rotation');
    expect(harness.elements.validation.textContent).toContain('needs confirmation');
    expect(harness.announce).toHaveBeenLastCalledWith(
      expect.stringContaining('Rotation command failed'),
    );
    expect(confirmationFocus).toHaveBeenCalledOnce();
  });
});
