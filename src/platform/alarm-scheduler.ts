import type { AlarmDueEvent, AlarmSchedulerDriver } from '../core/scheduler';
import type { DomainErrorCode, Timestamp } from '../core/types';
import { browser } from 'wxt/browser';

export type AlarmOperation = 'schedule-alarm' | 'cancel-alarm';

export interface BrowserAlarmLike {
  name: string;
  scheduledTime: number;
}

export interface BrowserAlarmEventLike {
  addListener(listener: (alarm: BrowserAlarmLike) => void): void;
}

export interface BrowserAlarmsApiLike {
  create?: (name: string, alarmInfo: { when: number }) => Promise<void> | void;
  clear?: (name: string) => Promise<boolean> | boolean;
  onAlarm?: BrowserAlarmEventLike;
}

export class AlarmSchedulerError extends Error {
  constructor(
    readonly code: Extract<DomainErrorCode, 'browser-api-unavailable' | 'browser-operation-failed'>,
    readonly operation: AlarmOperation,
  ) {
    super(`${operation} failed: ${code}.`);
    this.name = 'AlarmSchedulerError';
  }
}

/** Wraps browser.alarms and registers at most one browser listener for this adapter instance. */
export function createBrowserAlarmScheduler(
  api: BrowserAlarmsApiLike = browser.alarms as unknown as BrowserAlarmsApiLike,
): AlarmSchedulerDriver {
  const listeners = new Set<(event: AlarmDueEvent) => void>();
  let listenerRegistered = false;

  function ensureListener(): void {
    if (listenerRegistered) {
      return;
    }

    if (typeof api.onAlarm?.addListener !== 'function') {
      return;
    }

    api.onAlarm.addListener((alarm) => {
      if (
        typeof alarm.name !== 'string' ||
        !Number.isSafeInteger(alarm.scheduledTime) ||
        alarm.scheduledTime < 0
      ) {
        return;
      }

      const event = Object.freeze({
        name: alarm.name,
        scheduledTime: alarm.scheduledTime as Timestamp,
      });

      for (const listener of listeners) {
        listener(event);
      }
    });
    listenerRegistered = true;
  }

  return {
    async schedule(name, when) {
      if (
        typeof api.create !== 'function' ||
        typeof api.clear !== 'function' ||
        typeof api.onAlarm?.addListener !== 'function'
      ) {
        throw new AlarmSchedulerError('browser-api-unavailable', 'schedule-alarm');
      }

      try {
        await api.create(name, { when });
      } catch {
        throw new AlarmSchedulerError('browser-operation-failed', 'schedule-alarm');
      }
    },

    async cancel(name) {
      if (typeof api.clear !== 'function') {
        throw new AlarmSchedulerError('browser-api-unavailable', 'cancel-alarm');
      }

      try {
        await api.clear(name);
      } catch {
        throw new AlarmSchedulerError('browser-operation-failed', 'cancel-alarm');
      }
    },

    addListener(listener) {
      listeners.add(listener);
      ensureListener();
    },
  };
}
