import {
  ALARM_SCHEDULER_INTERVAL_MS,
  SCHEDULER_ALARM_NAMES,
  createHybridScheduler,
  type AlarmDueEvent,
  type AlarmSchedulerDriver,
  type SchedulerClock,
  type SchedulerDueEvent,
  type SchedulerTimers,
} from '@/core/scheduler';
import { describe, expect, it, vi } from 'vitest';

class MutableClock implements SchedulerClock {
  constructor(public time: number) {}

  now(): number {
    return this.time;
  }
}

class FakeTimers implements SchedulerTimers {
  readonly scheduled = new Map<number, { callback: () => void | Promise<void>; delayMs: number }>();
  readonly cleared: number[] = [];
  private nextHandle = 1;

  setTimeout(callback: () => void | Promise<void>, delayMs: number): number {
    const handle = this.nextHandle++;
    this.scheduled.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    const numericHandle = handle as number;
    this.cleared.push(numericHandle);
    this.scheduled.delete(numericHandle);
  }

  entry(handle: number) {
    const entry = this.scheduled.get(handle);

    if (!entry) {
      throw new Error(`Missing fake timeout ${handle}.`);
    }

    return entry;
  }

  async fire(handle: number): Promise<void> {
    const { callback } = this.entry(handle);
    this.scheduled.delete(handle);
    await callback();
  }
}

class FakeAlarms implements AlarmSchedulerDriver {
  readonly schedule = vi.fn(async (_name: string, _when: number) => undefined);
  readonly cancel = vi.fn(async (_name: string) => undefined);
  readonly listeners: ((event: AlarmDueEvent) => void)[] = [];

  addListener(listener: (event: AlarmDueEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(event: AlarmDueEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function fixture(startAt = 1_000) {
  const clock = new MutableClock(startAt);
  const timers = new FakeTimers();
  const alarms = new FakeAlarms();
  const scheduler = createHybridScheduler({ clock, timers, alarms });
  return { clock, timers, alarms, scheduler };
}

describe('hybrid scheduler', () => {
  it('uses the exact 29,999/30,000 ms boundary for rotation', async () => {
    const { alarms, scheduler, timers } = fixture();

    await expect(
      scheduler.schedule({ kind: 'rotation', scheduleId: 'fast', intervalMs: 29_999 }),
    ).resolves.toEqual({
      kind: 'rotation',
      scheduleId: 'fast',
      intervalMs: 29_999,
      mechanism: 'timeout',
      nextRunAt: 30_999,
    });
    expect([...timers.scheduled.values()]).toEqual([expect.objectContaining({ delayMs: 29_999 })]);
    expect(alarms.schedule).not.toHaveBeenCalled();

    await expect(
      scheduler.schedule({
        kind: 'rotation',
        scheduleId: 'alarm-boundary',
        intervalMs: ALARM_SCHEDULER_INTERVAL_MS,
      }),
    ).resolves.toEqual({
      kind: 'rotation',
      scheduleId: 'alarm-boundary',
      intervalMs: 30_000,
      mechanism: 'alarm',
      nextRunAt: 31_000,
    });
    expect(timers.cleared).toEqual([1]);
    expect(alarms.schedule).toHaveBeenLastCalledWith(SCHEDULER_ALARM_NAMES.rotation, 31_000);
  });

  it('always uses alarms for refresh and rejects a sub-30-second refresh', async () => {
    const { alarms, scheduler, timers } = fixture();

    await expect(
      scheduler.schedule({ kind: 'refresh', scheduleId: 'refresh', intervalMs: 30_000 }),
    ).resolves.toMatchObject({ mechanism: 'alarm', nextRunAt: 31_000 });
    expect(alarms.schedule).toHaveBeenCalledWith(SCHEDULER_ALARM_NAMES.refresh, 31_000);
    expect(timers.scheduled.size).toBe(0);

    await expect(
      scheduler.schedule({ kind: 'refresh', scheduleId: 'invalid', intervalMs: 29_999 }),
    ).rejects.toThrow('Invalid refresh schedule request.');
  });

  it('calculates the next run from actual action completion after a delayed callback', async () => {
    const { clock, scheduler, timers } = fixture();
    const events: SchedulerDueEvent[] = [];
    let rescheduled: Promise<unknown> | undefined;

    scheduler.onDue((event) => {
      events.push(event);
      clock.time = 42_500;
      rescheduled = scheduler.schedule({
        kind: 'rotation',
        scheduleId: event.scheduleId,
        intervalMs: 10_000,
      });
    });

    await scheduler.schedule({ kind: 'rotation', scheduleId: 'rotation', intervalMs: 10_000 });
    clock.time = 40_000;
    await timers.fire(1);
    await rescheduled;

    expect(events).toEqual([
      {
        kind: 'rotation',
        scheduleId: 'rotation',
        mechanism: 'timeout',
        dueAt: 11_000,
        deliveredAt: 40_000,
      },
    ]);
    expect(timers.entry(2).delayMs).toBe(10_000);
    await expect(rescheduled).resolves.toMatchObject({ nextRunAt: 52_500 });
  });

  it('cancels both mechanisms and ignores a stale timeout callback', async () => {
    const { alarms, clock, scheduler, timers } = fixture();
    const due = vi.fn();
    scheduler.onDue(due);

    await scheduler.schedule({ kind: 'rotation', scheduleId: 'fast', intervalMs: 10_000 });
    const staleCallback = timers.entry(1).callback;
    await scheduler.cancel('rotation');
    expect(timers.cleared).toEqual([1]);

    clock.time = 20_000;
    await staleCallback();
    expect(due).not.toHaveBeenCalled();

    await scheduler.schedule({ kind: 'refresh', scheduleId: 'refresh', intervalMs: 30_000 });
    await scheduler.cancel('refresh');
    expect(alarms.cancel).toHaveBeenLastCalledWith(SCHEDULER_ALARM_NAMES.refresh);
  });

  it('consumes an alarm timestamp before dispatch so duplicate delivery runs once', async () => {
    const { alarms, clock, scheduler } = fixture();
    const due = vi.fn();
    scheduler.onDue(due);

    await scheduler.schedule({ kind: 'refresh', scheduleId: 'refresh', intervalMs: 30_000 });
    clock.time = 31_000;
    const event = { name: SCHEDULER_ALARM_NAMES.refresh, scheduledTime: 31_000 };
    alarms.emit(event);
    alarms.emit(event);
    await Promise.resolve();

    expect(due).toHaveBeenCalledOnce();
    expect(due).toHaveBeenCalledWith({
      kind: 'refresh',
      scheduleId: 'refresh',
      mechanism: 'alarm',
      dueAt: 31_000,
      deliveredAt: 31_000,
    });
  });

  it('ignores a duplicate old alarm after the listener schedules a new due timestamp', async () => {
    const { alarms, clock, scheduler } = fixture();
    const events: SchedulerDueEvent[] = [];
    scheduler.onDue((event) => {
      events.push(event);
    });

    await scheduler.schedule({ kind: 'refresh', scheduleId: 'refresh', intervalMs: 30_000 });
    clock.time = 31_000;
    alarms.emit({ name: SCHEDULER_ALARM_NAMES.refresh, scheduledTime: 31_000 });
    await Promise.resolve();
    await scheduler.schedule({ kind: 'refresh', scheduleId: 'refresh', intervalMs: 30_000 });

    alarms.emit({ name: SCHEDULER_ALARM_NAMES.refresh, scheduledTime: 31_000 });
    await Promise.resolve();
    expect(events).toHaveLength(1);

    clock.time = 61_000;
    alarms.emit({ name: SCHEDULER_ALARM_NAMES.refresh, scheduledTime: 61_000 });
    await Promise.resolve();
    expect(events).toHaveLength(2);
  });

  it('re-arms rather than firing early when the wall clock moves backward', async () => {
    const { clock, scheduler, timers } = fixture(10_000);
    const due = vi.fn();
    scheduler.onDue(due);

    await scheduler.schedule({ kind: 'rotation', scheduleId: 'rotation', intervalMs: 10_000 });
    clock.time = 5_000;
    await timers.fire(1);

    expect(due).not.toHaveBeenCalled();
    expect(timers.entry(2).delayMs).toBe(15_000);

    clock.time = 20_000;
    await timers.fire(2);
    expect(due).toHaveBeenCalledOnce();
  });

  it('recovers only one overdue action and preserves its persisted due timestamp', async () => {
    const { clock, scheduler, timers } = fixture(100_000);
    const due = vi.fn();
    scheduler.onDue(due);

    await expect(
      scheduler.recover({
        kind: 'rotation',
        scheduleId: 'rotation',
        intervalMs: 10_000,
        nextRunAt: 20_000,
      }),
    ).resolves.toMatchObject({ mechanism: 'timeout', nextRunAt: 20_000 });
    expect(timers.entry(1).delayMs).toBe(0);
    const staleCallback = timers.entry(1).callback;

    await timers.fire(1);
    expect(due).toHaveBeenCalledOnce();
    expect(due).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: 20_000, deliveredAt: 100_000 }),
    );
    expect(timers.scheduled.size).toBe(0);

    clock.time = 200_000;
    await staleCallback();
    expect(due).toHaveBeenCalledOnce();
  });

  it('registers the alarm listener once and ignores unrelated alarm names', () => {
    const { alarms, scheduler } = fixture();
    const due = vi.fn();
    scheduler.onDue(due);
    scheduler.onDue(vi.fn());

    expect(alarms.listeners).toHaveLength(1);
    alarms.emit({ name: 'another-extension:alarm', scheduledTime: 1_000 });
    expect(due).not.toHaveBeenCalled();
  });
});
