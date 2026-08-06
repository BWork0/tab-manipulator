import {
  createStartupRecovery,
  recoverRuntimeTargets,
  type RecoveryTabSnapshot,
  type StartupRecoveryBrowser,
  type StartupRecoveryStore,
} from '@/core/recovery';
import {
  createHybridScheduler,
  type AlarmDueEvent,
  type AlarmSchedulerDriver,
  type HybridScheduler,
  type RecoverScheduleRequest,
  type ScheduleKind,
  type ScheduleRequest,
  type ScheduledDueAction,
  type SchedulerClock,
  type SchedulerDueEvent,
  type SchedulerDueListener,
  type SchedulerTimers,
} from '@/core/scheduler';
import {
  RUNTIME_SCHEMA_VERSION,
  type RefreshSchedule,
  type RotationSession,
  type TabDescriptor,
} from '@/core/types';
import { describe, expect, it, vi } from 'vitest';

class MutableClock implements SchedulerClock {
  constructor(public time: number) {}

  now(): number {
    return this.time;
  }
}

class RecordingScheduler implements HybridScheduler {
  readonly schedule = vi.fn(async (request: ScheduleRequest): Promise<ScheduledDueAction> => ({
    ...request,
    mechanism: 'alarm',
    nextRunAt: 0,
  }));
  readonly recover = vi.fn(
    async (request: RecoverScheduleRequest): Promise<ScheduledDueAction> => ({
      ...request,
      mechanism: request.kind === 'rotation' && request.intervalMs < 30_000 ? 'timeout' : 'alarm',
    }),
  );
  readonly cancel = vi.fn(async (_kind: ScheduleKind): Promise<void> => undefined);

  onDue(_listener: SchedulerDueListener): () => void {
    return () => undefined;
  }
}

class MemoryStore implements StartupRecoveryStore {
  readonly getRotationSession = vi.fn(async () => this.rotation);
  readonly getRefreshSchedule = vi.fn(async () => this.refresh);
  readonly setRotationSession = vi.fn(async (session: RotationSession) => {
    this.rotation = session;
    return session;
  });
  readonly setRefreshSchedule = vi.fn(async (schedule: RefreshSchedule) => {
    this.refresh = schedule;
    return schedule;
  });

  constructor(
    public rotation: RotationSession | null,
    public refresh: RefreshSchedule | null,
  ) {}
}

class FakeTimers implements SchedulerTimers {
  readonly scheduled = new Map<number, { callback: () => void | Promise<void>; delayMs: number }>();
  private nextHandle = 1;

  setTimeout(callback: () => void | Promise<void>, delayMs: number): number {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  async fire(handle: number): Promise<void> {
    const entry = this.scheduled.get(handle);

    if (!entry) {
      throw new Error(`Missing fake timeout ${handle}.`);
    }

    this.scheduled.delete(handle);
    await entry.callback();
  }
}

class FakeAlarms implements AlarmSchedulerDriver {
  readonly schedule = vi.fn(async (_name: string, _when: number) => undefined);
  readonly cancel = vi.fn(async (_name: string) => undefined);
  readonly listeners: ((event: AlarmDueEvent) => void)[] = [];

  addListener(listener: (event: AlarmDueEvent) => void): void {
    this.listeners.push(listener);
  }
}

function target(overrides: Partial<TabDescriptor> = {}): TabDescriptor {
  return {
    key: 'target-a',
    tabId: 10,
    windowId: 3,
    url: 'https://a.example.test/',
    title: 'Captured A',
    index: 0,
    pinned: false,
    ...overrides,
  };
}

function tab(overrides: Partial<RecoveryTabSnapshot> = {}): RecoveryTabSnapshot {
  return {
    tabId: 10,
    windowId: 3,
    url: 'https://a.example.test/',
    title: 'Current A',
    index: 0,
    pinned: false,
    ...overrides,
  };
}

function runningRotation(overrides: Partial<RotationSession> = {}): RotationSession {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: 'rotation-1',
    state: 'running',
    targets: [
      target(),
      target({
        key: 'target-b',
        tabId: 11,
        url: 'https://b.example.test/',
        title: 'Captured B',
        index: 1,
      }),
    ],
    sourceWindowId: 3,
    intervalMs: 10_000,
    direction: 'forward',
    cursor: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    nextRunAt: 20_000,
    ...overrides,
  } as RotationSession;
}

function runningRefresh(overrides: Partial<RefreshSchedule> = {}): RefreshSchedule {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: 'refresh-1',
    state: 'running',
    targets: [target()],
    sourceWindowId: 3,
    intervalMs: 30_000,
    createdAt: 1_000,
    updatedAt: 2_000,
    nextRunAt: 35_000,
    ...overrides,
  } as RefreshSchedule;
}

function browserWithTabs(tabs: readonly RecoveryTabSnapshot[]) {
  const browser: StartupRecoveryBrowser & {
    activateTab: ReturnType<typeof vi.fn>;
    reloadTab: ReturnType<typeof vi.fn>;
  } = {
    queryAllWindowTabs: vi.fn(async () => ({ ok: true as const, value: tabs })),
    activateTab: vi.fn(),
    reloadTab: vi.fn(),
  };
  return browser;
}

describe('conservative startup recovery', () => {
  it('revalidates same-session IDs and restores one callback across repeated background recovery', async () => {
    const store = new MemoryStore(runningRotation(), null);
    const scheduler = new RecordingScheduler();
    const browser = browserWithTabs([
      tab({ title: 'Updated A', index: 4 }),
      tab({
        tabId: 11,
        url: 'https://b.example.test/',
        title: 'Updated B',
        index: 5,
      }),
    ]);
    const recovery = createStartupRecovery({
      browser,
      clock: new MutableClock(5_000),
      scheduler,
      store,
    });

    const first = recovery.recover();
    const second = recovery.recover();

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({
      rotation: {
        kind: 'rotation',
        status: 'recovered',
        method: 'live-ids',
        scheduled: true,
      },
      refresh: { kind: 'refresh', status: 'absent' },
    });
    expect(browser.queryAllWindowTabs).toHaveBeenCalledOnce();
    expect(store.setRotationSession).toHaveBeenCalledOnce();
    expect(store.rotation?.targets).toEqual([
      target({ title: 'Updated A', index: 4 }),
      target({
        key: 'target-b',
        tabId: 11,
        url: 'https://b.example.test/',
        title: 'Updated B',
        index: 5,
      }),
    ]);
    expect(store.rotation?.updatedAt).toBe(5_000);
    expect(scheduler.recover).toHaveBeenCalledOnce();
    expect(scheduler.recover).toHaveBeenCalledWith({
      kind: 'rotation',
      scheduleId: 'rotation-1',
      intervalMs: 10_000,
      nextRunAt: 20_000,
    });
    expect(browser.activateTab).not.toHaveBeenCalled();
    expect(browser.reloadTab).not.toHaveBeenCalled();
  });

  it('selects the unique complete restart window with the best relative-order score', async () => {
    const targets = [
      target(),
      target({ key: 'target-b', tabId: 11, url: 'https://b.example.test/', index: 1 }),
    ];
    const store = new MemoryStore(null, runningRefresh({ targets }));
    const scheduler = new RecordingScheduler();
    const browser = browserWithTabs([
      tab({ tabId: 70, windowId: 7, index: 4 }),
      tab({ tabId: 71, windowId: 7, url: 'https://b.example.test/', index: 5 }),
      tab({ tabId: 80, windowId: 8, url: 'https://b.example.test/', index: 4 }),
      tab({ tabId: 81, windowId: 8, index: 5 }),
    ]);
    const recovery = createStartupRecovery({
      browser,
      clock: new MutableClock(10_000),
      scheduler,
      store,
    });

    await expect(recovery.recover()).resolves.toMatchObject({
      refresh: { status: 'recovered', method: 'window-match', scheduled: true },
    });
    expect(store.refresh?.sourceWindowId).toBe(7);
    expect(store.refresh?.targets.map(({ tabId }) => tabId)).toEqual([70, 71]);
    expect(scheduler.recover).toHaveBeenCalledOnce();
  });

  it('treats duplicate restart URLs as ambiguous and takes no browser action', async () => {
    const store = new MemoryStore(null, runningRefresh());
    const scheduler = new RecordingScheduler();
    const browser = browserWithTabs([
      tab({ tabId: 20, windowId: 4, index: 0 }),
      tab({ tabId: 21, windowId: 4, index: 1 }),
    ]);
    const recovery = createStartupRecovery({
      browser,
      clock: new MutableClock(10_000),
      scheduler,
      store,
    });

    await expect(recovery.recover()).resolves.toMatchObject({
      refresh: {
        kind: 'refresh',
        status: 'needs-attention',
        reason: 'ambiguous-recovery',
      },
    });
    expect(store.refresh).toMatchObject({
      state: 'needs-attention',
      attentionReason: 'ambiguous-recovery',
    });
    expect(store.refresh).not.toHaveProperty('nextRunAt');
    expect(scheduler.recover).not.toHaveBeenCalled();
    expect(browser.activateTab).not.toHaveBeenCalled();
    expect(browser.reloadTab).not.toHaveBeenCalled();
  });

  it('does not guess after only part of a live-ID set can be restored', async () => {
    const store = new MemoryStore(runningRotation(), null);
    const scheduler = new RecordingScheduler();
    const browser = browserWithTabs([
      tab(),
      tab({ tabId: 21, url: 'https://b.example.test/', index: 1 }),
    ]);
    const recovery = createStartupRecovery({
      browser,
      clock: new MutableClock(10_000),
      scheduler,
      store,
    });

    await recovery.recover();

    expect(store.rotation).toMatchObject({
      state: 'needs-attention',
      attentionReason: 'ambiguous-recovery',
    });
    expect(scheduler.recover).not.toHaveBeenCalled();
    expect(browser.activateTab).not.toHaveBeenCalled();
    expect(browser.reloadTab).not.toHaveBeenCalled();
  });

  it('delivers one expired due action and schedules the next action from completion time', async () => {
    const clock = new MutableClock(100_000);
    const timers = new FakeTimers();
    const scheduler = createHybridScheduler({ clock, timers, alarms: new FakeAlarms() });
    const store = new MemoryStore(runningRotation(), null);
    const browser = browserWithTabs([
      tab(),
      tab({ tabId: 11, url: 'https://b.example.test/', index: 1 }),
    ]);
    const events: SchedulerDueEvent[] = [];
    let nextSchedule: Promise<ScheduledDueAction> | undefined;

    scheduler.onDue(async (event) => {
      events.push(event);
      clock.time = 100_500;
      nextSchedule = scheduler.schedule({
        kind: event.kind,
        scheduleId: event.scheduleId,
        intervalMs: 10_000,
      });
      await nextSchedule;
    });

    const recovery = createStartupRecovery({ browser, clock, scheduler, store });
    await Promise.all([recovery.recover(), recovery.recover()]);

    expect(timers.scheduled.size).toBe(1);
    const [expiredHandle, expiredEntry] = [...timers.scheduled.entries()][0]!;
    expect(expiredEntry.delayMs).toBe(0);

    await timers.fire(expiredHandle);
    await nextSchedule;

    expect(events).toEqual([
      {
        kind: 'rotation',
        scheduleId: 'rotation-1',
        mechanism: 'timeout',
        dueAt: 20_000,
        deliveredAt: 100_000,
      },
    ]);
    expect([...timers.scheduled.values()]).toEqual([expect.objectContaining({ delayMs: 10_000 })]);
    await expect(nextSchedule).resolves.toMatchObject({ nextRunAt: 110_500 });

    clock.time = 200_000;
    await expiredEntry.callback();
    expect(events).toHaveLength(1);
  });

  it('reports tied complete window matches as ambiguous', () => {
    const targets = [
      target({ tabId: 100 }),
      target({ key: 'target-b', tabId: 101, url: 'https://b.example.test/', index: 1 }),
    ];
    const decision = recoverRuntimeTargets(
      targets,
      3,
      [
        tab({ tabId: 20, windowId: 4 }),
        tab({ tabId: 21, windowId: 4, url: 'https://b.example.test/', index: 1 }),
        tab({ tabId: 30, windowId: 5 }),
        tab({ tabId: 31, windowId: 5, url: 'https://b.example.test/', index: 1 }),
      ],
      2,
    );

    expect(decision).toMatchObject({
      status: 'needs-attention',
      reason: 'ambiguous-recovery',
    });
    expect(decision.windowScores).toEqual([
      expect.objectContaining({ windowId: 4, complete: true, relativeOrderMatches: 1 }),
      expect.objectContaining({ windowId: 5, complete: true, relativeOrderMatches: 1 }),
    ]);
  });
});
