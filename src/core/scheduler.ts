import { MIN_REFRESH_INTERVAL_MS, MIN_ROTATION_INTERVAL_MS } from './defaults';
import type { Milliseconds, Timestamp } from './types';

export const ALARM_SCHEDULER_INTERVAL_MS = 30_000;

export const SCHEDULER_ALARM_NAMES = Object.freeze({
  rotation: 'tab-manipulator:rotation',
  refresh: 'tab-manipulator:refresh',
} as const);

export type ScheduleKind = keyof typeof SCHEDULER_ALARM_NAMES;
export type SchedulingMechanism = 'alarm' | 'timeout';

export interface ScheduleRequest {
  kind: ScheduleKind;
  scheduleId: string;
  intervalMs: Milliseconds;
}

export interface RecoverScheduleRequest extends ScheduleRequest {
  nextRunAt: Timestamp;
}

export interface ScheduledDueAction extends ScheduleRequest {
  mechanism: SchedulingMechanism;
  nextRunAt: Timestamp;
}

export interface SchedulerDueEvent {
  kind: ScheduleKind;
  scheduleId: string;
  mechanism: SchedulingMechanism;
  dueAt: Timestamp;
  deliveredAt: Timestamp;
}

export type SchedulerDueListener = (event: SchedulerDueEvent) => void | Promise<void>;

export interface SchedulerClock {
  now(): Timestamp;
}

export interface SchedulerTimers {
  setTimeout(callback: () => void | Promise<void>, delayMs: Milliseconds): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AlarmDueEvent {
  name: string;
  scheduledTime: Timestamp;
}

export interface AlarmSchedulerDriver {
  schedule(name: string, when: Timestamp): Promise<void>;
  cancel(name: string): Promise<void>;
  addListener(listener: (event: AlarmDueEvent) => void): void;
}

export interface HybridScheduler {
  /** Schedules one future due action from the clock's current time. */
  schedule(request: ScheduleRequest): Promise<ScheduledDueAction>;
  /** Restores one persisted due action without replaying earlier missed intervals. */
  recover(request: RecoverScheduleRequest): Promise<ScheduledDueAction>;
  /** Cancels the active in-memory or browser-owned due action for a schedule kind. */
  cancel(kind: ScheduleKind): Promise<void>;
  /** Adds an application listener. The scheduler consumes a due timestamp before dispatch. */
  onDue(listener: SchedulerDueListener): () => void;
}

export interface HybridSchedulerDependencies {
  clock: SchedulerClock;
  timers: SchedulerTimers;
  alarms: AlarmSchedulerDriver;
}

interface ActiveDueAction extends ScheduledDueAction {
  token: number;
  triggerAt: Timestamp;
  timeoutHandle?: unknown;
}

function assertScheduleRequest(request: ScheduleRequest): void {
  const minimum = request.kind === 'rotation' ? MIN_ROTATION_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS;

  if (
    request.scheduleId.trim().length === 0 ||
    !Number.isSafeInteger(request.intervalMs) ||
    request.intervalMs < minimum
  ) {
    throw new TypeError(`Invalid ${request.kind} schedule request.`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid scheduler ${label}.`);
  }
}

function mechanismFor(request: ScheduleRequest): SchedulingMechanism {
  if (request.kind === 'refresh' || request.intervalMs >= ALARM_SCHEDULER_INTERVAL_MS) {
    return 'alarm';
  }

  return 'timeout';
}

function addInterval(timestamp: Timestamp, intervalMs: Milliseconds): Timestamp {
  const result = timestamp + intervalMs;

  if (!Number.isSafeInteger(result)) {
    throw new TypeError('The next scheduler timestamp is outside the supported range.');
  }

  return result;
}

/**
 * Coordinates one-shot alarms and timeouts. It never creates a periodic source: application
 * services schedule the next action only after the preceding action has completed.
 */
export function createHybridScheduler({
  clock,
  timers,
  alarms,
}: HybridSchedulerDependencies): HybridScheduler {
  const active = new Map<ScheduleKind, ActiveDueAction>();
  const listeners = new Set<SchedulerDueListener>();
  const handlingTokens = new Set<number>();
  const operationQueues = new Map<ScheduleKind, Promise<void>>();
  let nextToken = 1;

  function enqueue<T>(kind: ScheduleKind, operation: () => Promise<T>): Promise<T> {
    const preceding = operationQueues.get(kind) ?? Promise.resolve();
    const result = preceding.then(operation, operation);
    operationQueues.set(
      kind,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  function clearActiveTimeout(action: ActiveDueAction): void {
    if (action.mechanism === 'timeout' && action.timeoutHandle !== undefined) {
      timers.clearTimeout(action.timeoutHandle);
    }
  }

  async function removeActive(kind: ScheduleKind): Promise<ActiveDueAction | undefined> {
    const action = active.get(kind);

    if (!action) {
      return undefined;
    }

    active.delete(kind);
    clearActiveTimeout(action);

    if (action.mechanism === 'alarm') {
      await alarms.cancel(SCHEDULER_ALARM_NAMES[kind]);
    }

    return action;
  }

  async function deliver(action: ActiveDueAction): Promise<void> {
    const deliveredAt = clock.now();
    assertTimestamp(deliveredAt, 'clock value');

    if (deliveredAt < action.nextRunAt) {
      action.triggerAt = action.nextRunAt;

      if (action.mechanism === 'timeout') {
        action.timeoutHandle = timers.setTimeout(
          () => handleTrigger(action.kind, action.token, 'timeout'),
          action.nextRunAt - deliveredAt,
        );
      } else {
        await alarms.schedule(SCHEDULER_ALARM_NAMES[action.kind], action.triggerAt);
      }

      return;
    }

    active.delete(action.kind);
    action.timeoutHandle = undefined;

    const event: SchedulerDueEvent = Object.freeze({
      kind: action.kind,
      scheduleId: action.scheduleId,
      mechanism: action.mechanism,
      dueAt: action.nextRunAt,
      deliveredAt,
    });

    await Promise.allSettled([...listeners].map((listener) => listener(event)));
  }

  async function handleTrigger(
    kind: ScheduleKind,
    token: number,
    mechanism: SchedulingMechanism,
    alarmScheduledTime?: Timestamp,
  ): Promise<void> {
    const action = active.get(kind);

    if (
      !action ||
      action.token !== token ||
      action.mechanism !== mechanism ||
      handlingTokens.has(token) ||
      (mechanism === 'alarm' && alarmScheduledTime !== action.triggerAt)
    ) {
      return;
    }

    handlingTokens.add(token);

    try {
      await deliver(action);
    } finally {
      handlingTokens.delete(token);
    }
  }

  function armTimeout(action: ActiveDueAction, now: Timestamp): void {
    action.timeoutHandle = timers.setTimeout(
      () => handleTrigger(action.kind, action.token, 'timeout'),
      Math.max(0, action.triggerAt - now),
    );
  }

  async function install(
    request: ScheduleRequest,
    nextRunAt: Timestamp,
    now: Timestamp,
  ): Promise<ScheduledDueAction> {
    assertScheduleRequest(request);
    assertTimestamp(nextRunAt, 'nextRunAt');
    assertTimestamp(now, 'clock value');
    await removeActive(request.kind);

    const mechanism = mechanismFor(request);
    const action: ActiveDueAction = {
      ...request,
      mechanism,
      nextRunAt,
      triggerAt: Math.max(nextRunAt, now),
      token: nextToken++,
    };
    active.set(request.kind, action);

    try {
      if (mechanism === 'timeout') {
        armTimeout(action, now);
      } else {
        const alarmName = SCHEDULER_ALARM_NAMES[request.kind];
        await alarms.cancel(alarmName);
        await alarms.schedule(alarmName, action.triggerAt);
      }
    } catch (error) {
      if (active.get(request.kind)?.token === action.token) {
        active.delete(request.kind);
        clearActiveTimeout(action);
      }

      throw error;
    }

    return Object.freeze({
      kind: action.kind,
      scheduleId: action.scheduleId,
      intervalMs: action.intervalMs,
      mechanism: action.mechanism,
      nextRunAt: action.nextRunAt,
    });
  }

  alarms.addListener((event) => {
    const kind = (Object.entries(SCHEDULER_ALARM_NAMES) as [ScheduleKind, string][]).find(
      ([, name]) => name === event.name,
    )?.[0];

    if (!kind) {
      return;
    }

    const action = active.get(kind);

    if (!action) {
      return;
    }

    void handleTrigger(kind, action.token, 'alarm', event.scheduledTime);
  });

  return {
    schedule(request) {
      return enqueue(request.kind, async () => {
        assertScheduleRequest(request);
        const now = clock.now();
        assertTimestamp(now, 'clock value');
        return install(request, addInterval(now, request.intervalMs), now);
      });
    },

    recover(request) {
      return enqueue(request.kind, async () => {
        assertScheduleRequest(request);
        assertTimestamp(request.nextRunAt, 'nextRunAt');
        const now = clock.now();
        return install(request, request.nextRunAt, now);
      });
    },

    cancel(kind) {
      return enqueue(kind, async () => {
        const removed = await removeActive(kind);

        if (!removed) {
          await alarms.cancel(SCHEDULER_ALARM_NAMES[kind]);
        }
      });
    },

    onDue(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
