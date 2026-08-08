import { createDefaultBackgroundApplication } from '@/background/create-app';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { SCHEDULER_ALARM_NAMES, type SchedulerClock, type SchedulerTimers } from '@/core/scheduler';
import type { Timestamp } from '@/core/types';
import type { Command, RuntimeMessageResponse } from '@/messaging/protocol';
import { getRefreshSchedule, getRotationSession } from '@/storage/runtime-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

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

  clear(): void {
    this.scheduled.clear();
  }
}

interface CreatedTab {
  id: number;
  key: string;
  url: string;
}

const timersInUse: TrackingTimers[] = [];

function createTimers(): TrackingTimers {
  const timers = new TrackingTimers();
  timersInUse.push(timers);
  return timers;
}

async function createTabSet(
  definitions: readonly { url: string; active?: boolean; pinned?: boolean }[],
): Promise<readonly CreatedTab[]> {
  const window = await fakeBrowser.windows.create({ focused: true });

  if (window?.id === undefined) {
    throw new Error('The fake browser did not create a window identifier.');
  }

  return Promise.all(
    definitions.map(async ({ url, active = false, pinned = false }) => {
      const tab = await fakeBrowser.tabs.create({ windowId: window.id, url, active, pinned });

      if (tab.id === undefined) {
        throw new Error('The fake browser did not create a tab identifier.');
      }

      return { id: tab.id, key: `tab:${tab.id}`, url };
    }),
  );
}

function startApplication(clock: MutableClock, timers = createTimers()) {
  const application = createDefaultBackgroundApplication({ clock, timers });
  application.start();
  return application;
}

async function send(command: Command): Promise<RuntimeMessageResponse> {
  return (await fakeBrowser.runtime.sendMessage(command)) as RuntimeMessageResponse;
}

async function deliverAlarm(name: string, scheduledTime: number): Promise<void> {
  await fakeBrowser.alarms.onAlarm.trigger({ name, scheduledTime, persistAcrossSessions: false });
}

beforeEach(() => {
  fakeBrowser.reset();
  timersInUse.length = 0;
});

afterEach(() => {
  for (const timers of timersInUse) {
    expect(timers.scheduled.size).toBe(0);
    timers.clear();
  }

  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe.sequential('background integration flows', () => {
  it('runs rotation from message start through one tick to stop, including badge and record cleanup', async () => {
    const clock = new MutableClock();
    const tabs = await createTabSet([
      { url: 'https://one.example/', active: true },
      { url: 'https://two.example/' },
      { url: 'https://three.example/' },
    ]);
    const activation = vi.spyOn(fakeBrowser.tabs, 'update');
    const badgeText = vi.spyOn(fakeBrowser.action, 'setBadgeText');
    const application = startApplication(clock);
    await application.whenReady();

    const started = await send({
      type: 'start-rotation',
      targetKeys: tabs.map(({ key }) => key),
      intervalMs: 30_000,
      direction: 'forward',
      replaceExisting: false,
    });

    expect(started).toMatchObject({
      ok: true,
      command: 'start-rotation',
      data: { status: 'rotating', rotation: { state: 'running', nextRunAt: 31_000 } },
    });
    expect(activation).not.toHaveBeenCalled();
    expect(badgeText).toHaveBeenCalledWith({ text: 'ON' });

    clock.time = 31_000 as Timestamp;
    await deliverAlarm(SCHEDULER_ALARM_NAMES.rotation, 31_000);
    await vi.waitFor(async () => {
      await expect(getRotationSession()).resolves.toMatchObject({
        lastRunAt: 31_000,
        nextRunAt: 61_000,
      });
    });

    expect(activation).toHaveBeenCalledOnce();
    expect(activation).toHaveBeenCalledWith(tabs[0]!.id, { active: true });

    await expect(send({ type: 'stop-rotation' })).resolves.toMatchObject({
      ok: true,
      data: { status: 'idle', rotation: null },
    });
    await expect(getRotationSession()).resolves.toBeNull();
    await expect(fakeBrowser.alarms.getAll()).resolves.toEqual([]);
    expect(badgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('runs one delayed refresh pass, continues after a partial API failure, and ignores duplicate delivery', async () => {
    const clock = new MutableClock();
    const tabs = await createTabSet([
      { url: 'https://one.example/', active: true },
      { url: 'https://two.example/' },
      { url: 'https://three.example/' },
    ]);
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload').mockImplementation(async (tabId) => {
      if (tabId === tabs[0]!.id) {
        throw new Error('failed');
      }
    });
    const badgeText = vi.spyOn(fakeBrowser.action, 'setBadgeText');
    const application = startApplication(clock);
    await application.whenReady();

    await expect(
      send({
        type: 'start-refresh',
        targetKeys: tabs.map(({ key }) => key),
        intervalMs: 30_000,
        replaceExisting: false,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { status: 'refreshing', refresh: { nextRunAt: 31_000 } },
    });

    clock.time = 181_000 as Timestamp;
    await Promise.all([
      deliverAlarm(SCHEDULER_ALARM_NAMES.refresh, 31_000),
      deliverAlarm(SCHEDULER_ALARM_NAMES.refresh, 31_000),
    ]);
    await vi.waitFor(async () => {
      await expect(getRefreshSchedule()).resolves.toMatchObject({
        lastRunAt: 181_000,
        nextRunAt: 211_000,
        lastResult: {
          counts: { succeeded: 2, skipped: 0, failed: 1, total: 3 },
        },
      });
    });

    expect(reload).toHaveBeenCalledTimes(3);
    expect(new Set(reload.mock.calls.map(([tabId]) => tabId))).toEqual(
      new Set(tabs.map(({ id }) => id)),
    );
    expect(badgeText).toHaveBeenCalledWith({ text: '!' });

    await expect(send({ type: 'stop-refresh' })).resolves.toMatchObject({
      ok: true,
      data: { status: 'idle', refresh: null },
    });
    await expect(getRefreshSchedule()).resolves.toBeNull();
    await expect(fakeBrowser.alarms.getAll()).resolves.toEqual([]);
    expect(badgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('applies changed pinned settings to the next active rotation and refresh actions', async () => {
    const clock = new MutableClock();
    const tabs = await createTabSet([
      { url: 'https://one.example/', active: true },
      { url: 'https://pinned.example/', pinned: true },
      { url: 'https://three.example/' },
    ]);
    const activation = vi.spyOn(fakeBrowser.tabs, 'update');
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload');
    const application = startApplication(clock);
    await application.whenReady();

    await expect(
      send({
        type: 'update-settings',
        settings: { ...DEFAULT_SETTINGS, includePinned: true },
      }),
    ).resolves.toMatchObject({ ok: true, command: 'update-settings' });
    await send({
      type: 'start-rotation',
      targetKeys: tabs.map(({ key }) => key),
      intervalMs: 30_000,
      direction: 'forward',
      replaceExisting: false,
    });
    await send({
      type: 'start-refresh',
      targetKeys: tabs.map(({ key }) => key),
      intervalMs: 30_000,
      replaceExisting: false,
    });

    await expect(
      send({
        type: 'update-settings',
        settings: { ...DEFAULT_SETTINGS, includePinned: false },
      }),
    ).resolves.toMatchObject({ ok: true, command: 'update-settings' });

    clock.time = 31_000 as Timestamp;
    await deliverAlarm(SCHEDULER_ALARM_NAMES.rotation, 31_000);
    await deliverAlarm(SCHEDULER_ALARM_NAMES.refresh, 31_000);
    await vi.waitFor(async () => {
      await expect(getRotationSession()).resolves.toMatchObject({ lastRunAt: 31_000 });
      await expect(getRefreshSchedule()).resolves.toMatchObject({ lastRunAt: 31_000 });
    });

    expect(activation).toHaveBeenCalledOnce();
    expect(activation).not.toHaveBeenCalledWith(tabs[1]!.id, { active: true });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalledWith(tabs[1]!.id);
    await expect(getRotationSession()).resolves.toMatchObject({
      targets: [{ key: tabs[0]!.key }, { key: tabs[2]!.key }],
      lastResult: {
        targets: expect.arrayContaining([
          { status: 'skipped', targetKey: tabs[1]!.key, reason: 'pinned-tab-excluded' },
        ]),
      },
    });
    await expect(getRefreshSchedule()).resolves.toMatchObject({
      targets: [{ key: tabs[0]!.key }, { key: tabs[2]!.key }],
      lastResult: {
        targets: expect.arrayContaining([
          { status: 'skipped', targetKey: tabs[1]!.key, reason: 'pinned-tab-excluded' },
        ]),
      },
    });

    await send({ type: 'stop-rotation' });
    await send({ type: 'stop-refresh' });
  });

  it('reinitializes against stale IDs and enters attention without acting when URL recovery is ambiguous', async () => {
    const clock = new MutableClock();
    const originalTabs = await createTabSet([
      { url: 'https://one.example/', active: true },
      { url: 'https://two.example/' },
    ]);
    const listenerRegistration = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const firstApplication = startApplication(clock);
    await firstApplication.whenReady();
    await send({
      type: 'start-rotation',
      targetKeys: originalTabs.map(({ key }) => key),
      intervalMs: 30_000,
      direction: 'forward',
      replaceExisting: false,
    });

    fakeBrowser.alarms.onAlarm.removeAllListeners();
    fakeBrowser.runtime.onMessage.removeAllListeners();
    fakeBrowser.runtime.onStartup.removeAllListeners();
    fakeBrowser.runtime.onInstalled.removeAllListeners();
    for (const [index, { id }] of originalTabs.entries()) {
      await fakeBrowser.tabs.update(id, { url: `https://stale-${index}.example/` });
    }
    const replacementTabs = await createTabSet([
      { url: originalTabs[0]!.url, active: true },
      { url: originalTabs[0]!.url },
      { url: originalTabs[1]!.url },
    ]);
    expect(replacementTabs.map(({ id }) => id)).not.toEqual(originalTabs.map(({ id }) => id));

    const activation = vi.spyOn(fakeBrowser.tabs, 'update');
    const badgeText = vi.spyOn(fakeBrowser.action, 'setBadgeText');
    clock.time = 2_000 as Timestamp;
    const restoredApplication = startApplication(clock);
    await restoredApplication.whenReady();

    await expect(getRotationSession()).resolves.toMatchObject({
      state: 'needs-attention',
      attentionReason: 'ambiguous-recovery',
    });
    expect(await getRotationSession()).not.toHaveProperty('nextRunAt');
    expect(activation).not.toHaveBeenCalled();
    expect(listenerRegistration).toHaveBeenCalledTimes(2);
    await expect(fakeBrowser.alarms.getAll()).resolves.toEqual([]);
    expect(badgeText).toHaveBeenCalledWith({ text: '!' });

    await send({ type: 'stop-rotation' });
    await expect(getRotationSession()).resolves.toBeNull();
  });
});
