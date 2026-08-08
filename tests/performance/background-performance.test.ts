import { createDefaultBackgroundApplication } from '@/background/create-app';
import { SCHEDULER_ALARM_NAMES, type SchedulerClock, type SchedulerTimers } from '@/core/scheduler';
import type { Timestamp } from '@/core/types';
import type { Command, RuntimeMessageResponse } from '@/messaging/protocol';
import { getRefreshSchedule, getRotationSession } from '@/storage/runtime-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const TAB_COUNT = 55;

class MutableClock implements SchedulerClock {
  constructor(public time = 1_000 as Timestamp) {}

  now(): Timestamp {
    return this.time;
  }
}

class TrackingTimers implements SchedulerTimers {
  readonly scheduled = new Map<unknown, () => void | Promise<void>>();
  private nextHandle = 1;

  setTimeout(callback: () => void | Promise<void>): unknown {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle);
  }
}

interface CreatedTab {
  id: number;
  key: string;
}

async function createTabs(count: number): Promise<readonly CreatedTab[]> {
  const window = await fakeBrowser.windows.create({ focused: true });

  if (window?.id === undefined) {
    throw new Error('The fake browser did not create a window identifier.');
  }

  const windowId = window.id;

  const tabs: CreatedTab[] = [];

  for (let index = 0; index < count; index += 1) {
    const tab = await fakeBrowser.tabs.create({
      windowId,
      url: `https://dashboard-${index}.example/`,
      active: index === 0,
    });

    if (tab.id === undefined) {
      throw new Error('The fake browser did not create a tab identifier.');
    }

    tabs.push({ id: tab.id, key: `tab:${tab.id}` });
  }

  return tabs;
}

async function send(command: Command): Promise<RuntimeMessageResponse> {
  return (await fakeBrowser.runtime.sendMessage(command)) as RuntimeMessageResponse;
}

async function deliverAlarm(name: string, scheduledTime: Timestamp): Promise<void> {
  await fakeBrowser.alarms.onAlarm.trigger({
    name,
    scheduledTime,
    persistAcrossSessions: false,
  });
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe.sequential('T061 performance and idle behavior', () => {
  it('registers no idle timer, alarm, listener loop, or storage-write polling', async () => {
    const timers = new TrackingTimers();
    const storageSet = vi.spyOn(fakeBrowser.storage.local, 'set');
    const storageRemove = vi.spyOn(fakeBrowser.storage.local, 'remove');
    const alarmListeners = vi.spyOn(fakeBrowser.alarms.onAlarm, 'addListener');
    const messageListeners = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const startupListeners = vi.spyOn(fakeBrowser.runtime.onStartup, 'addListener');
    const installedListeners = vi.spyOn(fakeBrowser.runtime.onInstalled, 'addListener');
    const application = createDefaultBackgroundApplication({
      clock: new MutableClock(),
      timers,
    });

    application.start();
    application.start();
    await application.whenReady();
    await Promise.resolve();

    expect(timers.scheduled).toHaveLength(0);
    await expect(fakeBrowser.alarms.getAll()).resolves.toEqual([]);
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
    expect(alarmListeners).toHaveBeenCalledOnce();
    expect(messageListeners).toHaveBeenCalledOnce();
    expect(startupListeners).toHaveBeenCalledOnce();
    expect(installedListeners).toHaveBeenCalledOnce();
  });

  it('runs one rotation action and one refresh pass for 55 tabs without storms', async () => {
    const clock = new MutableClock();
    const timers = new TrackingTimers();
    const tabs = await createTabs(TAB_COUNT);
    const storageSet = vi.spyOn(fakeBrowser.storage.local, 'set');
    const storageRemove = vi.spyOn(fakeBrowser.storage.local, 'remove');
    const activation = vi.spyOn(fakeBrowser.tabs, 'update');
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload').mockResolvedValue(undefined);
    const application = createDefaultBackgroundApplication({ clock, timers });
    application.start();
    await application.whenReady();

    const startedAt = performance.now();
    await expect(
      send({
        type: 'start-rotation',
        targetKeys: tabs.map(({ key }) => key),
        intervalMs: 30_000,
        direction: 'forward',
        replaceExisting: false,
      }),
    ).resolves.toMatchObject({ ok: true, command: 'start-rotation' });
    await expect(
      send({
        type: 'start-refresh',
        targetKeys: tabs.map(({ key }) => key),
        intervalMs: 30_000,
        replaceExisting: false,
      }),
    ).resolves.toMatchObject({ ok: true, command: 'start-refresh' });

    expect(storageSet).toHaveBeenCalledTimes(4);
    expect(storageSet.mock.calls.flatMap(([items]) => Object.keys(items))).toEqual([
      'runtime-rotation',
      'runtime-rotation$',
      'runtime-refresh',
      'runtime-refresh$',
    ]);
    expect(storageRemove).toHaveBeenCalledTimes(2);
    expect(timers.scheduled).toHaveLength(0);
    await expect(fakeBrowser.alarms.getAll()).resolves.toHaveLength(2);

    storageSet.mockClear();
    storageRemove.mockClear();
    await expect(send({ type: 'get-snapshot' })).resolves.toMatchObject({ ok: true });
    await expect(send({ type: 'get-tab-list' })).resolves.toMatchObject({
      ok: true,
      data: { length: TAB_COUNT },
    });
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();

    clock.time = 31_000 as Timestamp;
    await Promise.all([
      deliverAlarm(SCHEDULER_ALARM_NAMES.rotation, clock.time),
      deliverAlarm(SCHEDULER_ALARM_NAMES.rotation, clock.time),
      deliverAlarm(SCHEDULER_ALARM_NAMES.refresh, clock.time),
      deliverAlarm(SCHEDULER_ALARM_NAMES.refresh, clock.time),
    ]);
    await vi.waitFor(async () => {
      await expect(getRotationSession()).resolves.toMatchObject({ lastRunAt: clock.time });
      await expect(getRefreshSchedule()).resolves.toMatchObject({
        lastRunAt: clock.time,
        lastResult: { counts: { succeeded: TAB_COUNT, total: TAB_COUNT } },
      });
    });

    const durationMs = performance.now() - startedAt;
    console.info(
      `T061 synthetic ${TAB_COUNT}-tab rotation and refresh lifecycle: ${durationMs.toFixed(2)} ms.`,
    );
    expect(activation).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(TAB_COUNT);
    expect(new Set(reload.mock.calls.map(([tabId]) => tabId))).toEqual(
      new Set(tabs.map(({ id }) => id)),
    );
    expect(storageSet).toHaveBeenCalledTimes(2);
    expect(storageSet.mock.calls.flatMap(([items]) => Object.keys(items))).toEqual([
      'runtime-rotation',
      'runtime-refresh',
    ]);
    expect(storageRemove).toHaveBeenCalledTimes(2);
    await expect(fakeBrowser.alarms.getAll()).resolves.toHaveLength(2);

    storageSet.mockClear();
    storageRemove.mockClear();
    await send({ type: 'get-snapshot' });
    await send({ type: 'get-tab-list' });
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();

    await send({ type: 'stop-rotation' });
    await send({ type: 'stop-refresh' });
    await expect(fakeBrowser.alarms.getAll()).resolves.toEqual([]);
    expect(timers.scheduled).toHaveLength(0);
  });
});
