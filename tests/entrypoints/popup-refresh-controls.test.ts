import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { ActionResultSummary, RefreshSchedule, Timestamp } from '@/core/types';
import {
  createRefreshControlsController,
  type RefreshControlElements,
  type RefreshControlsOptions,
} from '@/entrypoints/popup/refresh-controls';
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
          <option value="30000">30 seconds</option>
          <option value="60000">1 minute</option>
          <option value="300000">5 minutes</option>
          <option value="custom">Custom</option>
        </select>
        <div id="custom-group" hidden>
          <input id="custom" type="number" value="300" />
        </div>
      </fieldset>
      <p id="validation" hidden></p>
      <p id="result" data-tone="neutral" hidden></p>
      <button id="start" type="button">Start refresh</button>
      <button id="replace" type="button" hidden>Replace refresh</button>
      <button id="stop" type="button" hidden>Stop refresh</button>
      <button id="refresh-now" type="button">Refresh now</button>
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

function elements(document: Document): RefreshControlElements {
  return {
    region: required(document, '#region'),
    settingsFieldset: required(document, '#settings'),
    interval: required(document, '#interval'),
    customIntervalGroup: required(document, '#custom-group'),
    customInterval: required(document, '#custom'),
    validation: required(document, '#validation'),
    result: required(document, '#result'),
    startButton: required(document, '#start'),
    replaceButton: required(document, '#replace'),
    stopButton: required(document, '#stop'),
    refreshNowButton: required(document, '#refresh-now'),
    confirmation: required(document, '#confirmation'),
    confirmReplaceButton: required(document, '#confirm'),
    cancelReplaceButton: required(document, '#cancel'),
  };
}

function refreshSchedule(overrides: Partial<RefreshSchedule> = {}): RefreshSchedule {
  const base = {
    schemaVersion: 1 as const,
    id: 'refresh-1',
    targets: [],
    sourceWindowId: 1,
    intervalMs: 30_000,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };

  return {
    ...base,
    state: 'running',
    nextRunAt: (NOW + base.intervalMs) as Timestamp,
  } as RefreshSchedule;
}

function snapshot(schedule: RefreshSchedule | null = null): AutomationSnapshot {
  return {
    status: schedule === null ? 'idle' : 'refreshing',
    settings: DEFAULT_SETTINGS,
    rotation: null,
    refresh: schedule,
    capabilities: {
      currentWindowTabQuery: 'available',
      allWindowTabQuery: 'available',
      tabActivation: 'available',
      tabReload: 'available',
      toolbarState: 'available',
      optionsPage: 'available',
    },
    ...(schedule?.state === 'running' ? { nextRunAt: schedule.nextRunAt } : {}),
  };
}

function refreshNowResult(): ActionResultSummary {
  return {
    action: 'refresh-now',
    completedAt: NOW,
    targets: [
      { status: 'success', targetKey: 'tab:1' },
      { status: 'success', targetKey: 'tab:2' },
      { status: 'skipped', targetKey: 'tab:3', reason: 'filtered-out' },
      { status: 'failure', targetKey: 'tab:4', errorCode: 'tab-reload-failed' },
    ],
    counts: { succeeded: 2, skipped: 1, failed: 1, total: 4 },
  };
}

function createHarness(overrides: Partial<RefreshControlsOptions> = {}) {
  const page = createDocument();
  const document = page.document as unknown as Document;
  const viewElements = elements(document);
  const revalidateSelectedTargets = vi.fn().mockResolvedValue(['tab:1']);
  const sendCommand = vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot() });
  const refreshSnapshot = vi.fn().mockResolvedValue(snapshot());
  const applySnapshot = vi.fn();
  const announce = vi.fn();
  const controller = createRefreshControlsController({
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

describe('popup refresh controls', () => {
  it('reflects the persisted default and active schedule interval', () => {
    const harness = createHarness();
    harness.controller.setSnapshot(snapshot());

    expect(harness.elements.interval.value).toBe('300000');
    expect(harness.elements.startButton.hidden).toBe(false);
    expect(harness.elements.replaceButton.hidden).toBe(true);
    expect(harness.elements.stopButton.hidden).toBe(true);

    harness.controller.setSnapshot(snapshot(refreshSchedule({ intervalMs: 45_000 })));

    expect(harness.elements.interval.value).toBe('custom');
    expect(harness.elements.customInterval.value).toBe('45');
    expect(harness.elements.customIntervalGroup.hidden).toBe(false);
    expect(harness.elements.startButton.hidden).toBe(true);
    expect(harness.elements.replaceButton.hidden).toBe(false);
    expect(harness.elements.stopButton.hidden).toBe(false);
    expect(harness.elements.refreshNowButton.hidden).toBe(false);
  });

  it('validates the 30-second minimum and at least one revalidated target', async () => {
    const harness = createHarness();
    harness.controller.setSnapshot(snapshot());
    selectValue(harness.elements.interval, 'custom');
    harness.elements.customInterval.value = '29';
    harness.elements.startButton.click();

    expect(harness.sendCommand).not.toHaveBeenCalled();
    expect(harness.elements.validation.textContent).toContain('at least 30 seconds');
    expect(harness.elements.customInterval.getAttribute('aria-invalid')).toBe('true');

    harness.elements.customInterval.value = '30';
    harness.revalidateSelectedTargets.mockResolvedValueOnce([]);
    harness.elements.startButton.click();
    await vi.waitFor(() =>
      expect(harness.elements.validation.textContent).toContain('at least one eligible tab'),
    );

    expect(harness.sendCommand).not.toHaveBeenCalled();
  });

  it('starts from the current selection and applies the returned persisted snapshot', async () => {
    const started = snapshot(refreshSchedule({ intervalMs: 60_000 }));
    const harness = createHarness();
    harness.sendCommand.mockResolvedValueOnce({ ok: true, snapshot: started });
    harness.controller.setSnapshot(snapshot());
    selectValue(harness.elements.interval, '60000');
    harness.elements.startButton.click();

    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledOnce());
    expect(harness.sendCommand).toHaveBeenCalledWith({
      type: 'start-refresh',
      targetKeys: ['tab:1'],
      intervalMs: 60_000,
      replaceExisting: false,
    });
    expect(harness.applySnapshot).toHaveBeenCalledWith(started);
    expect(harness.announce).toHaveBeenLastCalledWith('Refresh schedule started.');
    expect(harness.elements.startButton.hidden).toBe(true);
  });

  it('requires inline confirmation before replacement and supports stopping', async () => {
    const active = snapshot(refreshSchedule());
    const harness = createHarness();
    const confirmationFocus = vi.spyOn(harness.elements.confirmReplaceButton, 'focus');
    const restoredFocus = vi.spyOn(harness.elements.replaceButton, 'focus');
    harness.controller.setSnapshot(active);
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
    expect(harness.sendCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'start-refresh', replaceExisting: true }),
    );
    await vi.waitFor(() => expect(harness.elements.replaceButton.disabled).toBe(false));

    harness.controller.setSnapshot(active);
    harness.elements.stopButton.click();
    await vi.waitFor(() =>
      expect(harness.sendCommand).toHaveBeenLastCalledWith({ type: 'stop-refresh' }),
    );
    expect(harness.sendCommand).toHaveBeenCalledTimes(2);
  });

  it('refreshes now without changing the active schedule and exposes partial counts', async () => {
    const schedule = refreshSchedule({ intervalMs: 60_000 });
    const active = snapshot(schedule);
    const result = refreshNowResult();
    const harness = createHarness();
    harness.revalidateSelectedTargets.mockResolvedValueOnce(['tab:1', 'tab:2', 'tab:3', 'tab:4']);
    harness.sendCommand.mockResolvedValueOnce({ ok: true, snapshot: active, result });
    harness.controller.setSnapshot(active);
    harness.elements.refreshNowButton.click();

    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledOnce());
    expect(harness.sendCommand).toHaveBeenCalledWith({
      type: 'refresh-now',
      targetKeys: ['tab:1', 'tab:2', 'tab:3', 'tab:4'],
    });
    expect(harness.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start-refresh',
      }),
    );
    expect(harness.sendCommand).not.toHaveBeenCalledWith({ type: 'stop-refresh' });
    expect(harness.applySnapshot).toHaveBeenCalledWith(active);
    expect(active.refresh?.nextRunAt).toBe(schedule.nextRunAt);
    expect(harness.elements.result.hidden).toBe(false);
    expect(harness.elements.result.textContent).toBe(
      'Refresh now complete: 2 succeeded, 1 skipped, 1 failed.',
    );
    expect(harness.elements.result.dataset.tone).toBe('attention');
    expect(harness.announce).toHaveBeenLastCalledWith(harness.elements.result.textContent);
  });

  it('validates the current selection before refresh-now', async () => {
    const harness = createHarness();
    harness.revalidateSelectedTargets.mockResolvedValueOnce([]);
    harness.controller.setSnapshot(snapshot());
    harness.elements.refreshNowButton.click();

    await vi.waitFor(() =>
      expect(harness.elements.validation.textContent).toContain('at least one eligible tab'),
    );
    expect(harness.sendCommand).not.toHaveBeenCalled();
    expect(harness.announce).toHaveBeenLastCalledWith(
      'Select at least one eligible tab to refresh now.',
    );
  });

  it('suppresses double submission while refresh-now is pending', async () => {
    let resolveCommand:
      | ((value: { ok: true; snapshot: AutomationSnapshot; result: ActionResultSummary }) => void)
      | undefined;
    const pendingCommand = new Promise<{
      ok: true;
      snapshot: AutomationSnapshot;
      result: ActionResultSummary;
    }>((resolve) => {
      resolveCommand = resolve;
    });
    const harness = createHarness();
    harness.sendCommand.mockReturnValueOnce(pendingCommand);
    harness.controller.setSnapshot(snapshot());

    harness.elements.refreshNowButton.click();
    harness.elements.refreshNowButton.click();
    await vi.waitFor(() => expect(harness.sendCommand).toHaveBeenCalledOnce());
    expect(harness.elements.refreshNowButton.disabled).toBe(true);

    resolveCommand?.({ ok: true, snapshot: snapshot(), result: refreshNowResult() });
    await vi.waitFor(() => expect(harness.elements.refreshNowButton.disabled).toBe(false));
    expect(harness.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('disables every refresh command control while another popup operation is pending', () => {
    const operationGate = createPopupOperationGate();
    const harness = createHarness({ operationGate });
    harness.controller.setSnapshot(snapshot(refreshSchedule()));

    const release = operationGate.tryAcquire();

    expect(harness.elements.region.getAttribute('aria-busy')).toBe('true');
    expect(harness.elements.settingsFieldset.disabled).toBe(true);
    expect(harness.elements.replaceButton.disabled).toBe(true);
    expect(harness.elements.stopButton.disabled).toBe(true);
    expect(harness.elements.refreshNowButton.disabled).toBe(true);

    release?.();
    expect(harness.elements.region.getAttribute('aria-busy')).toBe('false');
    expect(harness.elements.refreshNowButton.disabled).toBe(false);
  });

  it('refreshes persisted state and announces typed command failures', async () => {
    const active = snapshot(refreshSchedule());
    const harness = createHarness();
    const confirmationFocus = vi.spyOn(harness.elements.confirmReplaceButton, 'focus');
    harness.sendCommand.mockResolvedValueOnce({
      ok: false,
      code: 'replacement-confirmation-required',
    });
    harness.refreshSnapshot.mockResolvedValueOnce(active);
    harness.controller.setSnapshot(snapshot());
    harness.elements.startButton.click();

    await vi.waitFor(() => expect(harness.refreshSnapshot).toHaveBeenCalledOnce());
    expect(harness.applySnapshot).toHaveBeenCalledWith(active);
    expect(harness.elements.confirmation.hidden).toBe(false);
    expect(harness.elements.startButton.hidden).toBe(true);
    expect(harness.elements.validation.textContent).toContain('needs confirmation');
    expect(harness.announce).toHaveBeenLastCalledWith(
      expect.stringContaining('Refresh command failed'),
    );
    expect(confirmationFocus).toHaveBeenCalledOnce();
  });
});
