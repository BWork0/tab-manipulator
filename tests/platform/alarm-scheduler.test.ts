import {
  AlarmSchedulerError,
  createBrowserAlarmScheduler,
  type BrowserAlarmLike,
  type BrowserAlarmsApiLike,
} from '@/platform/alarm-scheduler';
import { describe, expect, it, vi } from 'vitest';

function fakeAlarmApi() {
  const browserListeners: ((alarm: BrowserAlarmLike) => void)[] = [];
  const api: BrowserAlarmsApiLike = {
    create: vi.fn(),
    clear: vi.fn().mockResolvedValue(true),
    onAlarm: {
      addListener: vi.fn((listener) => browserListeners.push(listener)),
    },
  };

  return { api, browserListeners };
}

describe('browser alarm scheduler', () => {
  it('wraps one-shot alarm creation and cancellation', async () => {
    const { api } = fakeAlarmApi();
    const scheduler = createBrowserAlarmScheduler(api);

    await scheduler.schedule('tab-manipulator:rotation', 45_000);
    await scheduler.cancel('tab-manipulator:rotation');

    expect(api.create).toHaveBeenCalledWith('tab-manipulator:rotation', { when: 45_000 });
    expect(api.clear).toHaveBeenCalledWith('tab-manipulator:rotation');
  });

  it('registers one browser listener and fans out valid due events', () => {
    const { api, browserListeners } = fakeAlarmApi();
    const scheduler = createBrowserAlarmScheduler(api);
    const first = vi.fn();
    const second = vi.fn();

    scheduler.addListener(first);
    scheduler.addListener(second);
    expect(api.onAlarm?.addListener).toHaveBeenCalledOnce();

    browserListeners[0]?.({ name: 'tab-manipulator:refresh', scheduledTime: 30_000 });
    expect(first).toHaveBeenCalledWith({
      name: 'tab-manipulator:refresh',
      scheduledTime: 30_000,
    });
    expect(second).toHaveBeenCalledOnce();
  });

  it('drops malformed browser events before they reach core scheduling', () => {
    const { api, browserListeners } = fakeAlarmApi();
    const scheduler = createBrowserAlarmScheduler(api);
    const listener = vi.fn();
    scheduler.addListener(listener);

    browserListeners[0]?.({ name: 'alarm', scheduledTime: Number.NaN });
    expect(listener).not.toHaveBeenCalled();
  });

  it('converts unavailable and rejected APIs to stable platform errors', async () => {
    const unavailable = createBrowserAlarmScheduler({});
    await expect(unavailable.schedule('alarm', 1)).rejects.toEqual(
      new AlarmSchedulerError('browser-api-unavailable', 'schedule-alarm'),
    );
    await expect(unavailable.cancel('alarm')).rejects.toEqual(
      new AlarmSchedulerError('browser-api-unavailable', 'cancel-alarm'),
    );

    const cannotDeliver = createBrowserAlarmScheduler({
      create: vi.fn(),
      clear: vi.fn(),
    });
    await expect(cannotDeliver.schedule('alarm', 1)).rejects.toEqual(
      new AlarmSchedulerError('browser-api-unavailable', 'schedule-alarm'),
    );

    const rejected = createBrowserAlarmScheduler({
      create: vi.fn().mockRejectedValue(new Error('private alarm details')),
      clear: vi.fn().mockRejectedValue(new Error('private alarm details')),
      onAlarm: { addListener: vi.fn() },
    });
    await expect(rejected.schedule('alarm', 1)).rejects.toEqual(
      new AlarmSchedulerError('browser-operation-failed', 'schedule-alarm'),
    );
    await expect(rejected.cancel('alarm')).rejects.toEqual(
      new AlarmSchedulerError('browser-operation-failed', 'cancel-alarm'),
    );
  });
});
