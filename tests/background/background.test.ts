import {
  createBackgroundApplication,
  createDefaultBackgroundApplication,
  type BackgroundApplicationDependencies,
  type BackgroundRuntimeApi,
} from '@/background/create-app';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type {
  ActionResultSummary,
  RefreshSchedule,
  RotationSession,
  Timestamp,
} from '@/core/types';
import type { AutomationSnapshot, Command, RuntimeMessageResponse } from '@/messaging/protocol';
import backgroundDefinition, { startBackground } from '@/entrypoints/background';
import { setRotationSession } from '@/storage/runtime-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const NOW = 100_000 as Timestamp;
const TOOLBAR_STATE = {
  text: '',
  backgroundColor: '#000000',
  title: 'Tab Manipulator: Idle',
};

function snapshot(): AutomationSnapshot {
  return {
    status: 'idle',
    settings: DEFAULT_SETTINGS,
    rotation: null,
    refresh: null,
    capabilities: {
      currentWindowTabQuery: 'available',
      allWindowTabQuery: 'available',
      tabActivation: 'available',
      tabReload: 'available',
      toolbarState: 'available',
      optionsPage: 'available',
    },
  };
}

function rotationSession(): RotationSession {
  return {
    schemaVersion: 1,
    id: 'rotation-1',
    state: 'running',
    targets: [
      {
        key: 'tab:1',
        tabId: 1,
        windowId: 1,
        url: 'https://one.example/',
        index: 0,
        pinned: false,
      },
      {
        key: 'tab:2',
        tabId: 2,
        windowId: 1,
        url: 'https://two.example/',
        index: 1,
        pinned: false,
      },
    ],
    sourceWindowId: 1,
    intervalMs: 30_000,
    direction: 'forward',
    cursor: 0,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW + 30_000,
  };
}

function refreshSchedule(): RefreshSchedule {
  return {
    schemaVersion: 1,
    id: 'refresh-1',
    state: 'running',
    targets: [rotationSession().targets[0]!],
    sourceWindowId: 1,
    intervalMs: 30_000,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW + 30_000,
  };
}

function actionResult(): ActionResultSummary {
  return {
    action: 'refresh-now',
    completedAt: NOW,
    targets: [{ status: 'success', targetKey: 'tab:1' }],
    counts: { succeeded: 1, skipped: 0, failed: 0, total: 1 },
  };
}

function createHarness() {
  let dueListener:
    Parameters<BackgroundApplicationDependencies['scheduler']['onDue']>[0] | undefined;
  let persistedRotation: RotationSession | null = rotationSession();
  let persistedRefresh: RefreshSchedule | null = refreshSchedule();
  const currentSnapshot = snapshot();
  const scheduler = {
    schedule: vi.fn(),
    recover: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    onDue: vi.fn((listener) => {
      dueListener = listener;
      return () => undefined;
    }),
  } satisfies BackgroundApplicationDependencies['scheduler'];
  const recovery = { recover: vi.fn().mockResolvedValue({}) };
  const rotation = {
    start: vi.fn().mockResolvedValue(rotationSession()),
    pause: vi
      .fn()
      .mockResolvedValue({ ...rotationSession(), state: 'paused', nextRunAt: undefined }),
    resume: vi.fn().mockResolvedValue(rotationSession()),
    stop: vi.fn().mockResolvedValue(null),
    handleDueTick: vi.fn().mockResolvedValue({ status: 'ignored', session: rotationSession() }),
  } satisfies BackgroundApplicationDependencies['rotation'];
  const refresh = {
    start: vi.fn().mockResolvedValue(refreshSchedule()),
    stop: vi.fn().mockResolvedValue(null),
    handleDueRun: vi.fn().mockResolvedValue({ status: 'ignored', schedule: refreshSchedule() }),
    refreshNow: vi.fn().mockResolvedValue(actionResult()),
  } satisfies BackgroundApplicationDependencies['refresh'];
  const status = {
    getSnapshot: vi.fn().mockResolvedValue(currentSnapshot),
    syncToolbar: vi.fn().mockResolvedValue({
      snapshot: currentSnapshot,
      toolbarUpdate: { ok: true, state: TOOLBAR_STATE },
    }),
  } satisfies BackgroundApplicationDependencies['status'];
  const attentionStore = {
    updateRotationSession: vi.fn(async (update) => {
      persistedRotation = await update(persistedRotation);
      return persistedRotation;
    }),
    updateRefreshSchedule: vi.fn(async (update) => {
      persistedRefresh = await update(persistedRefresh);
      return persistedRefresh;
    }),
  } satisfies BackgroundApplicationDependencies['attentionStore'];
  const settingsStore = {
    updateSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
  } satisfies BackgroundApplicationDependencies['settingsStore'];
  const browser = {
    queryCurrentWindowTabs: vi.fn().mockResolvedValue({
      ok: true,
      value: [
        {
          key: 'tab:1',
          tabId: 1,
          windowId: 1,
          url: 'https://one.example/',
          title: 'One',
          favIconUrl: 'https://one.example/favicon.ico',
          index: 0,
          pinned: false,
          active: true,
        },
        {
          key: 'tab:2',
          tabId: 2,
          windowId: 1,
          url: 'chrome://settings/',
          index: 1,
          pinned: false,
          active: false,
        },
      ],
    }),
  } satisfies BackgroundApplicationDependencies['browser'];
  const dependencies: BackgroundApplicationDependencies = {
    runtime: fakeBrowser.runtime as unknown as BackgroundRuntimeApi,
    browser,
    scheduler,
    recovery,
    rotation,
    refresh,
    status,
    attentionStore,
    settingsStore,
    clock: { now: () => NOW },
  };
  const application = createBackgroundApplication(dependencies);

  return {
    application,
    browser,
    scheduler,
    recovery,
    rotation,
    refresh,
    status,
    attentionStore,
    settingsStore,
    getDueListener: () => dueListener,
    getPersistedRotation: () => persistedRotation,
  };
}

async function send(command: Command | unknown): Promise<RuntimeMessageResponse> {
  return (await fakeBrowser.runtime.sendMessage(command)) as RuntimeMessageResponse;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('background application', () => {
  it('keeps the WXT background main function synchronous', () => {
    expect(backgroundDefinition.main).toBe(startBackground);
    expect(backgroundDefinition.main.constructor.name).toBe('Function');
  });

  it('registers listeners and runs recovery exactly once per application instance', async () => {
    const runtimeMessageSpy = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const startupSpy = vi.spyOn(fakeBrowser.runtime.onStartup, 'addListener');
    const installedSpy = vi.spyOn(fakeBrowser.runtime.onInstalled, 'addListener');
    const harness = createHarness();

    harness.application.start();
    harness.application.start();
    await harness.application.whenReady();
    await fakeBrowser.runtime.onStartup.trigger();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });

    expect(runtimeMessageSpy).toHaveBeenCalledOnce();
    expect(startupSpy).toHaveBeenCalledOnce();
    expect(installedSpy).toHaveBeenCalledOnce();
    expect(harness.scheduler.onDue).toHaveBeenCalledOnce();
    expect(harness.recovery.recover).toHaveBeenCalledOnce();
  });

  it('restores one native alarm and one listener set after background reinitialization', async () => {
    const window = await fakeBrowser.windows.create({ focused: true });

    if (window?.id === undefined) {
      throw new Error('The fake browser did not create a window identifier.');
    }

    const firstTab = await fakeBrowser.tabs.create({
      windowId: window.id,
      url: 'https://one.example/',
      active: true,
    });
    const secondTab = await fakeBrowser.tabs.create({
      windowId: window.id,
      url: 'https://two.example/',
      active: false,
    });

    if (firstTab.id === undefined || secondTab.id === undefined) {
      throw new Error('The fake browser did not create tab identifiers.');
    }

    await setRotationSession({
      ...rotationSession(),
      targets: [
        {
          ...rotationSession().targets[0]!,
          tabId: firstTab.id,
          windowId: window.id,
          index: firstTab.index,
        },
        {
          ...rotationSession().targets[1]!,
          tabId: secondTab.id,
          windowId: window.id,
          index: secondTab.index,
        },
      ],
      sourceWindowId: window.id,
    });
    const alarmSpy = vi.spyOn(fakeBrowser.alarms.onAlarm, 'addListener');
    const messageSpy = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    alarmSpy.mockClear();
    messageSpy.mockClear();
    const options = {
      clock: { now: () => NOW },
      timers: { setTimeout: vi.fn(), clearTimeout: vi.fn() },
    };
    const firstApplication = createDefaultBackgroundApplication(options);

    firstApplication.start();
    firstApplication.start();
    await firstApplication.whenReady();
    expect(await fakeBrowser.alarms.getAll()).toHaveLength(1);

    fakeBrowser.alarms.onAlarm.removeAllListeners();
    fakeBrowser.runtime.onMessage.removeAllListeners();
    fakeBrowser.runtime.onStartup.removeAllListeners();
    fakeBrowser.runtime.onInstalled.removeAllListeners();

    const restoredApplication = createDefaultBackgroundApplication(options);

    restoredApplication.start();
    restoredApplication.start();
    await restoredApplication.whenReady();

    expect(await fakeBrowser.alarms.getAll()).toHaveLength(1);
    expect(alarmSpy).toHaveBeenCalledTimes(2);
    expect(messageSpy).toHaveBeenCalledTimes(2);
  });

  it('dispatches every validated command to its application handler', async () => {
    const harness = createHarness();
    harness.application.start();
    await harness.application.whenReady();

    const commands = [
      { type: 'get-snapshot' },
      { type: 'get-tab-list' },
      {
        type: 'start-rotation',
        targetKeys: ['tab:1', 'tab:2'],
        intervalMs: 30_000,
        direction: 'forward',
        replaceExisting: false,
      },
      { type: 'pause-rotation' },
      { type: 'resume-rotation' },
      { type: 'stop-rotation' },
      {
        type: 'start-refresh',
        targetKeys: ['tab:1'],
        intervalMs: 30_000,
        replaceExisting: false,
      },
      { type: 'stop-refresh' },
      { type: 'refresh-now', targetKeys: ['tab:1'] },
      { type: 'update-settings', settings: DEFAULT_SETTINGS },
    ] satisfies readonly Command[];

    for (const command of commands) {
      await expect(send(command)).resolves.toMatchObject({ ok: true, command: command.type });
    }

    const tabListResponse = await send({ type: 'get-tab-list' });
    expect(tabListResponse).toMatchObject({
      ok: true,
      data: [
        { key: 'tab:1', eligibility: { eligible: true } },
        {
          key: 'tab:2',
          eligibility: { eligible: false, reason: 'browser-internal-url' },
        },
      ],
    });
    expect(harness.rotation.start).toHaveBeenCalledOnce();
    expect(harness.rotation.pause).toHaveBeenCalledOnce();
    expect(harness.rotation.resume).toHaveBeenCalledOnce();
    expect(harness.rotation.stop).toHaveBeenCalledOnce();
    expect(harness.refresh.start).toHaveBeenCalledOnce();
    expect(harness.refresh.stop).toHaveBeenCalledOnce();
    expect(harness.refresh.refreshNow).toHaveBeenCalledOnce();
    expect(harness.settingsStore.updateSettings).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it('rejects invalid complete settings without overwriting the last valid update', async () => {
    const harness = createHarness();
    const validSettings = { ...DEFAULT_SETTINGS, includePinned: true };
    harness.settingsStore.updateSettings.mockResolvedValueOnce(validSettings);
    harness.application.start();
    await harness.application.whenReady();

    await expect(send({ type: 'update-settings', settings: validSettings })).resolves.toMatchObject(
      { ok: true, command: 'update-settings' },
    );
    await expect(
      send({
        type: 'update-settings',
        settings: { ...validSettings, rotationIntervalMs: 9_999 },
      }),
    ).resolves.toEqual({
      ok: false,
      command: 'update-settings',
      error: { code: 'invalid-settings' },
    });

    expect(harness.settingsStore.updateSettings).toHaveBeenCalledOnce();
    expect(harness.settingsStore.updateSettings).toHaveBeenCalledWith(validSettings);
  });

  it('rejects malformed messages before they reach services', async () => {
    const harness = createHarness();
    harness.application.start();
    await harness.application.whenReady();

    await expect(send({ type: 'start-rotation', targetKeys: [] })).resolves.toEqual({
      ok: false,
      command: null,
      error: { code: 'invalid-request' },
    });
    expect(harness.rotation.start).not.toHaveBeenCalled();
    expect(harness.attentionStore.updateRotationSession).not.toHaveBeenCalled();
  });

  it('keeps due handling alive after the command sender is gone', async () => {
    const harness = createHarness();
    harness.application.start();
    await harness.application.whenReady();
    await send({
      type: 'start-rotation',
      targetKeys: ['tab:1', 'tab:2'],
      intervalMs: 30_000,
      direction: 'forward',
      replaceExisting: false,
    });

    await harness.getDueListener()?.({
      kind: 'rotation',
      scheduleId: 'rotation-1',
      mechanism: 'alarm',
      dueAt: NOW + 30_000,
      deliveredAt: NOW + 30_000,
    });

    expect(harness.rotation.handleDueTick).toHaveBeenCalledOnce();
    expect(harness.status.syncToolbar).toHaveBeenCalledTimes(3);
  });

  it('returns a typed error and persists safe attention after an uncaught command failure', async () => {
    const harness = createHarness();
    harness.rotation.start.mockRejectedValueOnce(new Error('sensitive internal detail'));
    harness.application.start();
    await harness.application.whenReady();

    await expect(
      send({
        type: 'start-rotation',
        targetKeys: ['tab:1', 'tab:2'],
        intervalMs: 30_000,
        direction: 'forward',
        replaceExisting: false,
      }),
    ).resolves.toEqual({
      ok: false,
      command: 'start-rotation',
      error: { code: 'unexpected-error' },
    });

    expect(harness.getPersistedRotation()).toMatchObject({
      state: 'needs-attention',
      attentionReason: 'unexpected-error',
    });
    expect(harness.getPersistedRotation()).not.toHaveProperty('nextRunAt');
    expect(harness.scheduler.cancel).toHaveBeenCalledWith('rotation');
  });
});
