import { DEFAULT_SETTINGS } from '@/core/defaults';
import type {
  HybridScheduler,
  ScheduleRequest,
  ScheduledDueAction,
  SchedulerClock,
  SchedulerDueEvent,
} from '@/core/scheduler';
import type { RefreshSchedule, Settings } from '@/core/types';
import type { BrowserOperationResult, BrowserTabSnapshot } from '@/platform/browser-api';
import {
  RefreshServiceError,
  createRefreshService,
  type RefreshServiceBrowser,
  type RefreshServiceStore,
  type StartRefreshInput,
} from '@/services/refresh-service';
import { describe, expect, it, vi } from 'vitest';

class MutableClock implements SchedulerClock {
  constructor(public time = 1_000) {}

  now(): number {
    return this.time;
  }
}

function tab(
  key: string,
  index: number,
  overrides: Partial<BrowserTabSnapshot> = {},
): BrowserTabSnapshot {
  const tabId = index + 10;
  return {
    key,
    tabId,
    windowId: 3,
    url: `https://${key}.example/`,
    title: key,
    index,
    pinned: false,
    active: false,
    ...overrides,
  };
}

function success<T>(value: T): BrowserOperationResult<T> {
  return { ok: true, value };
}

function due(schedule: RefreshSchedule): SchedulerDueEvent {
  if (schedule.state !== 'running') {
    throw new Error('Expected a running refresh schedule.');
  }

  return {
    kind: 'refresh',
    scheduleId: schedule.id,
    mechanism: 'alarm',
    dueAt: schedule.nextRunAt,
    deliveredAt: schedule.nextRunAt,
  };
}

function startInput(overrides: Partial<StartRefreshInput> = {}): StartRefreshInput {
  return {
    targetKeys: ['first', 'second', 'third'],
    intervalMs: 30_000,
    replaceExisting: false,
    ...overrides,
  };
}

function fixture(initialTabs = [tab('first', 0), tab('second', 1), tab('third', 2)]) {
  const clock = new MutableClock();
  let currentTabs: readonly BrowserTabSnapshot[] = initialTabs;
  let allTabs: readonly BrowserTabSnapshot[] = initialTabs;
  let currentSettings: Settings = { ...DEFAULT_SETTINGS };
  let storedSchedule: RefreshSchedule | null = null;
  let nextId = 1;

  const browser: RefreshServiceBrowser = {
    queryCurrentWindowTabs: vi.fn(async () => success(currentTabs)),
    queryAllWindowTabs: vi.fn(async () => success(allTabs)),
    reloadTab: vi.fn(async () => success(undefined)),
  };
  const store: RefreshServiceStore = {
    getRefreshSchedule: vi.fn(async () => storedSchedule),
    setRefreshSchedule: vi.fn(async (schedule) => {
      storedSchedule = schedule;
      return schedule;
    }),
    clearRefreshSchedule: vi.fn(async () => {
      storedSchedule = null;
    }),
  };
  const schedule = vi.fn(async (request: ScheduleRequest): Promise<ScheduledDueAction> => ({
    ...request,
    mechanism: 'alarm',
    nextRunAt: clock.now() + request.intervalMs,
  }));
  const recover = vi.fn(async (request) => ({ ...request, mechanism: 'alarm' as const }));
  const cancel = vi.fn(async () => undefined);
  const scheduler: HybridScheduler = {
    schedule,
    recover,
    cancel,
    onDue: vi.fn(() => () => undefined),
  };
  const readSettings = vi.fn(async () => currentSettings);
  const service = createRefreshService({
    browser,
    clock,
    scheduler,
    store,
    readSettings,
    createId: () => `refresh-${nextId++}`,
  });

  return {
    browser,
    cancel,
    clock,
    readSettings,
    recover,
    schedule,
    service,
    store,
    get refreshSchedule() {
      return storedSchedule;
    },
    setAllTabs(tabs: readonly BrowserTabSnapshot[]) {
      allTabs = tabs;
    },
    setSettings(settings: Settings) {
      currentSettings = settings;
    },
  };
}

function expectServiceError(error: unknown, code: RefreshServiceError['code']): boolean {
  expect(error).toBeInstanceOf(RefreshServiceError);
  expect(error).toMatchObject({ code });
  return true;
}

describe('refresh lifecycle service', () => {
  it('validates the minimum interval and selected targets, captures eligible tabs, and waits for the first interval', async () => {
    const tabs = [
      tab('unselected', 0),
      tab('second', 2),
      tab('pinned', 3, { pinned: true }),
      tab('first', 5),
      tab('restricted', 6, { url: 'chrome://settings/' }),
    ];
    const test = fixture(tabs);

    await expect(test.service.start(startInput({ intervalMs: 29_999 }))).rejects.toSatisfy(
      (error) => expectServiceError(error, 'invalid-interval'),
    );
    await expect(test.service.start(startInput({ targetKeys: ['restricted'] }))).rejects.toSatisfy(
      (error) => expectServiceError(error, 'insufficient-targets'),
    );

    const schedule = await test.service.start(
      startInput({ targetKeys: ['first', 'restricted', 'pinned', 'second'] }),
    );

    expect(schedule).toMatchObject({
      id: 'refresh-1',
      state: 'running',
      sourceWindowId: 3,
      intervalMs: 30_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      nextRunAt: 31_000,
    });
    expect(schedule.targets.map(({ key, index }) => ({ key, index }))).toEqual([
      { key: 'second', index: 2 },
      { key: 'first', index: 5 },
    ]);
    expect(test.browser.reloadTab).not.toHaveBeenCalled();
    expect(test.schedule).toHaveBeenCalledOnce();
    expect(test.store.setRefreshSchedule).toHaveBeenCalledOnce();
  });

  it('requires explicit replacement but treats an identical repeated start as idempotent', async () => {
    const test = fixture();
    const original = await test.service.start(startInput());

    await expect(test.service.start(startInput())).resolves.toBe(original);
    expect(test.schedule).toHaveBeenCalledOnce();

    await expect(test.service.start(startInput({ intervalMs: 60_000 }))).rejects.toSatisfy(
      (error) => expectServiceError(error, 'replacement-confirmation-required'),
    );
    expect(test.refreshSchedule).toBe(original);

    await expect(
      test.service.start(startInput({ intervalMs: 60_000, replaceExisting: true })),
    ).resolves.toMatchObject({ id: 'refresh-2', intervalMs: 60_000 });
    expect(test.schedule).toHaveBeenCalledTimes(2);
  });

  it('makes repeated stop commands harmless and clears persisted target metadata', async () => {
    const test = fixture();
    await test.service.start(startInput());

    await expect(test.service.stop()).resolves.toBeNull();
    await expect(test.service.stop()).resolves.toBeNull();

    expect(test.refreshSchedule).toBeNull();
    expect(test.cancel).toHaveBeenCalledTimes(2);
    expect(test.store.clearRefreshSchedule).toHaveBeenCalledTimes(2);
  });

  it('reconciles every due pass, continues after partial failure, persists removals, and schedules from completion time', async () => {
    const test = fixture();
    const started = await test.service.start(startInput());
    test.setAllTabs([
      tab('second', 1, { tabId: 11 }),
      tab('third', 3, { tabId: 12 }),
      tab('first', 5, { tabId: 10 }),
    ]);
    test.setSettings({ ...DEFAULT_SETTINGS, blocklist: ['third.example'] });
    vi.mocked(test.browser.reloadTab).mockImplementation(async (tabId) =>
      tabId === 10
        ? {
            ok: false,
            error: { code: 'tab-reload-failed', operation: 'reload-tab' },
          }
        : success(undefined),
    );
    test.clock.time = 75_000;

    const run = await test.service.handleDueRun(due(started));

    expect(run).toMatchObject({
      status: 'completed',
      result: { counts: { succeeded: 1, skipped: 1, failed: 1, total: 3 } },
    });
    expect(test.browser.reloadTab).toHaveBeenCalledTimes(2);
    expect(test.browser.reloadTab).toHaveBeenNthCalledWith(1, 10);
    expect(test.browser.reloadTab).toHaveBeenNthCalledWith(2, 11);
    expect(test.refreshSchedule).toMatchObject({
      state: 'running',
      lastRunAt: 75_000,
      updatedAt: 75_000,
      nextRunAt: 105_000,
      lastResult: {
        targets: [
          { status: 'failure', targetKey: 'first', errorCode: 'tab-reload-failed' },
          { status: 'success', targetKey: 'second' },
          { status: 'skipped', targetKey: 'third', reason: 'filtered-out' },
        ],
      },
    });
    expect(test.refreshSchedule?.targets.map(({ key, index }) => ({ key, index }))).toEqual([
      { key: 'second', index: 1 },
      { key: 'first', index: 5 },
    ]);
    expect(test.schedule).toHaveBeenLastCalledWith({
      kind: 'refresh',
      scheduleId: started.id,
      intervalMs: 30_000,
    });
  });

  it('revalidates an active refresh on its next pass after pinned tabs are excluded', async () => {
    const tabs = [tab('first', 0), tab('pinned', 1, { pinned: true }), tab('second', 2)];
    const test = fixture(tabs);
    test.setSettings({ ...DEFAULT_SETTINGS, includePinned: true });
    const started = await test.service.start(
      startInput({ targetKeys: tabs.map(({ key }) => key) }),
    );
    expect(started.targets.map(({ key }) => key)).toEqual(['first', 'pinned', 'second']);

    test.setSettings({ ...DEFAULT_SETTINGS, includePinned: false });
    test.clock.time = 40_000;
    const run = await test.service.handleDueRun(due(started));

    expect(run.status).toBe('completed');
    expect(test.readSettings).toHaveBeenCalledTimes(2);
    expect(test.browser.reloadTab).toHaveBeenCalledTimes(2);
    expect(test.browser.reloadTab).not.toHaveBeenCalledWith(11);
    expect(test.refreshSchedule?.targets.map(({ key }) => key)).toEqual(['first', 'second']);
    expect(test.refreshSchedule?.lastResult?.targets).toContainEqual({
      status: 'skipped',
      targetKey: 'pinned',
      reason: 'pinned-tab-excluded',
    });
  });

  it('performs at most one delayed pass and ignores duplicate delivery of the consumed due timestamp', async () => {
    const test = fixture();
    const started = await test.service.start(startInput());
    const event = due(started);
    test.clock.time = 181_000;

    const results = await Promise.all([
      test.service.handleDueRun(event),
      test.service.handleDueRun(event),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['completed', 'ignored']);
    expect(test.browser.reloadTab).toHaveBeenCalledTimes(3);
    expect(test.refreshSchedule).toMatchObject({ lastRunAt: 181_000, nextRunAt: 211_000 });
    expect(test.schedule).toHaveBeenCalledTimes(2);
  });

  it('keeps refresh-now independent from a running schedule and reports success, skips, and failures', async () => {
    const tabs = [
      tab('first', 0),
      tab('second', 1),
      tab('restricted', 2, { url: 'chrome://settings/' }),
    ];
    const test = fixture(tabs);
    const scheduled = await test.service.start(
      startInput({ targetKeys: ['first', 'second'], intervalMs: 60_000 }),
    );
    vi.mocked(test.browser.reloadTab).mockImplementation(async (tabId) =>
      tabId === 10
        ? {
            ok: false,
            error: { code: 'tab-reload-failed', operation: 'reload-tab' },
          }
        : success(undefined),
    );
    vi.mocked(test.store.setRefreshSchedule).mockClear();
    test.clock.time = 5_000;

    const result = await test.service.refreshNow({
      targetKeys: ['first', 'second', 'restricted', 'closed'],
    });

    expect(result).toEqual({
      action: 'refresh-now',
      completedAt: 5_000,
      targets: [
        { status: 'failure', targetKey: 'first', errorCode: 'tab-reload-failed' },
        { status: 'success', targetKey: 'second' },
        { status: 'skipped', targetKey: 'restricted', reason: 'ineligible-url' },
        { status: 'skipped', targetKey: 'closed', reason: 'missing-tab' },
      ],
      counts: { succeeded: 1, skipped: 2, failed: 1, total: 4 },
    });
    expect(test.refreshSchedule).toBe(scheduled);
    expect(test.refreshSchedule?.nextRunAt).toBe(61_000);
    expect(test.store.setRefreshSchedule).not.toHaveBeenCalled();
    expect(test.schedule).toHaveBeenCalledOnce();
  });

  it('enters needs-attention without rescheduling when every target is removed', async () => {
    const test = fixture([tab('first', 0)]);
    const started = await test.service.start(startInput({ targetKeys: ['first'] }));
    test.setAllTabs([]);
    test.clock.time = 31_000;

    const run = await test.service.handleDueRun(due(started));

    expect(run).toMatchObject({
      status: 'needs-attention',
      reason: 'insufficient-targets',
      schedule: {
        state: 'needs-attention',
        targets: [],
        lastRunAt: 31_000,
        attentionReason: 'insufficient-targets',
      },
      result: { counts: { succeeded: 0, skipped: 1, failed: 0, total: 1 } },
    });
    expect(test.browser.reloadTab).not.toHaveBeenCalled();
    expect(test.schedule).toHaveBeenCalledOnce();
    expect(test.cancel).toHaveBeenCalledWith('refresh');
  });

  it('enters needs-attention without reloading when the all-window query fails', async () => {
    const test = fixture();
    const started = await test.service.start(startInput());
    vi.mocked(test.browser.queryAllWindowTabs).mockResolvedValue({
      ok: false,
      error: { code: 'browser-operation-failed', operation: 'query-all-window-tabs' },
    });
    test.clock.time = 31_000;

    await expect(test.service.handleDueRun(due(started))).resolves.toMatchObject({
      status: 'needs-attention',
      reason: 'browser-operation-failed',
      schedule: {
        state: 'needs-attention',
        attentionReason: 'browser-operation-failed',
      },
    });
    expect(test.browser.reloadTab).not.toHaveBeenCalled();
    expect(test.cancel).toHaveBeenCalledWith('refresh');
  });
});
