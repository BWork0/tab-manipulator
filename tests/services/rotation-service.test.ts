import { DEFAULT_SETTINGS } from '@/core/defaults';
import type {
  HybridScheduler,
  ScheduleRequest,
  ScheduledDueAction,
  SchedulerClock,
  SchedulerDueEvent,
} from '@/core/scheduler';
import type { RotationSession, Settings } from '@/core/types';
import type { BrowserOperationResult, BrowserTabSnapshot } from '@/platform/browser-api';
import {
  RotationServiceError,
  createRotationService,
  type RotationServiceBrowser,
  type RotationServiceStore,
  type StartRotationInput,
} from '@/services/rotation-service';
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

function due(session: RotationSession): SchedulerDueEvent {
  if (session.state !== 'running') {
    throw new Error('Expected a running rotation session.');
  }

  return {
    kind: 'rotation',
    scheduleId: session.id,
    mechanism: session.intervalMs < 30_000 ? 'timeout' : 'alarm',
    dueAt: session.nextRunAt,
    deliveredAt: session.nextRunAt,
  };
}

function startInput(overrides: Partial<StartRotationInput> = {}): StartRotationInput {
  return {
    targetKeys: ['first', 'second', 'third'],
    intervalMs: 10_000,
    direction: 'forward',
    replaceExisting: false,
    ...overrides,
  };
}

function fixture(
  initialTabs = [tab('first', 0, { active: true }), tab('second', 1), tab('third', 2)],
) {
  const clock = new MutableClock();
  let currentTabs: readonly BrowserTabSnapshot[] = initialTabs;
  let allTabs: readonly BrowserTabSnapshot[] = initialTabs;
  let currentSettings: Settings = { ...DEFAULT_SETTINGS };
  let storedSession: RotationSession | null = null;
  let nextId = 1;

  const browser: RotationServiceBrowser = {
    queryCurrentWindowTabs: vi.fn(async () => success(currentTabs)),
    queryAllWindowTabs: vi.fn(async () => success(allTabs)),
    activateTab: vi.fn(async () => success(undefined)),
  };
  const store: RotationServiceStore = {
    getRotationSession: vi.fn(async () => storedSession),
    setRotationSession: vi.fn(async (session) => {
      storedSession = session;
      return session;
    }),
    clearRotationSession: vi.fn(async () => {
      storedSession = null;
    }),
  };
  const schedule = vi.fn(async (request: ScheduleRequest): Promise<ScheduledDueAction> => ({
    ...request,
    mechanism: request.intervalMs < 30_000 ? 'timeout' : 'alarm',
    nextRunAt: clock.now() + request.intervalMs,
  }));
  const recover = vi.fn(async (request) => ({
    ...request,
    mechanism: request.intervalMs < 30_000 ? ('timeout' as const) : ('alarm' as const),
  }));
  const cancel = vi.fn(async () => undefined);
  const scheduler: HybridScheduler = {
    schedule,
    recover,
    cancel,
    onDue: vi.fn(() => () => undefined),
  };
  const readSettings = vi.fn(async () => currentSettings);
  const service = createRotationService({
    browser,
    clock,
    scheduler,
    store,
    readSettings,
    createId: () => `rotation-${nextId++}`,
    random: () => 0,
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
    get session() {
      return storedSession;
    },
    setCurrentTabs(tabs: readonly BrowserTabSnapshot[]) {
      currentTabs = tabs;
    },
    setAllTabs(tabs: readonly BrowserTabSnapshot[]) {
      allTabs = tabs;
    },
    setSettings(settings: Settings) {
      currentSettings = settings;
    },
  };
}

function expectServiceError(error: unknown, code: RotationServiceError['code']): boolean {
  expect(error).toBeInstanceOf(RotationServiceError);
  expect(error).toMatchObject({ code });
  return true;
}

describe('rotation lifecycle service', () => {
  it('validates start input, captures only selected eligible targets in current order, and waits for the first interval', async () => {
    const tabs = [
      tab('unselected', 0, { active: true }),
      tab('second', 2),
      tab('pinned', 3, { pinned: true }),
      tab('first', 5),
      tab('restricted', 6, { url: 'chrome://settings/' }),
    ];
    const test = fixture(tabs);

    await expect(test.service.start(startInput({ intervalMs: 9_999 }))).rejects.toSatisfy((error) =>
      expectServiceError(error, 'invalid-interval'),
    );
    await expect(test.service.start(startInput({ targetKeys: ['first'] }))).rejects.toSatisfy(
      (error) => expectServiceError(error, 'insufficient-targets'),
    );

    const session = await test.service.start(
      startInput({ targetKeys: ['first', 'restricted', 'pinned', 'second'] }),
    );

    expect(session).toMatchObject({
      id: 'rotation-1',
      state: 'running',
      sourceWindowId: 3,
      intervalMs: 10_000,
      direction: 'forward',
      cursor: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
      nextRunAt: 11_000,
    });
    expect(session.targets.map(({ key, index }) => ({ key, index }))).toEqual([
      { key: 'second', index: 2 },
      { key: 'first', index: 5 },
    ]);
    expect(test.browser.activateTab).not.toHaveBeenCalled();
    expect(test.schedule).toHaveBeenCalledOnce();
    expect(test.store.setRotationSession).toHaveBeenCalledOnce();
  });

  it('requires explicit replacement but treats an identical repeated start as idempotent', async () => {
    const test = fixture();
    const original = await test.service.start(startInput());

    await expect(test.service.start(startInput())).resolves.toBe(original);
    expect(test.schedule).toHaveBeenCalledOnce();

    await expect(test.service.start(startInput({ direction: 'backward' }))).rejects.toSatisfy(
      (error) => expectServiceError(error, 'replacement-confirmation-required'),
    );
    expect(test.session).toBe(original);

    await expect(
      test.service.start(startInput({ direction: 'backward', replaceExisting: true })),
    ).resolves.toMatchObject({ id: 'rotation-2', direction: 'backward' });
    expect(test.schedule).toHaveBeenCalledTimes(2);
  });

  it('implements idempotent pause, resume, and stop transitions', async () => {
    const test = fixture();
    await test.service.start(startInput());

    test.clock.time = 2_000;
    const paused = await test.service.pause();
    await expect(test.service.pause()).resolves.toBe(paused);
    expect(paused).toMatchObject({ state: 'paused', updatedAt: 2_000 });
    expect('nextRunAt' in paused).toBe(false);

    test.clock.time = 4_000;
    const resumed = await test.service.resume();
    await expect(test.service.resume()).resolves.toBe(resumed);
    expect(resumed).toMatchObject({ state: 'running', nextRunAt: 14_000, updatedAt: 4_000 });
    expect(test.schedule).toHaveBeenCalledTimes(2);

    await expect(test.service.stop()).resolves.toBeNull();
    await expect(test.service.stop()).resolves.toBeNull();
    expect(test.session).toBeNull();
    expect(test.store.clearRotationSession).toHaveBeenCalledTimes(2);
  });

  it('reconciles reordering, activates exactly one next target, persists the tick, and schedules from completion time', async () => {
    const test = fixture();
    const started = await test.service.start(startInput());
    test.setAllTabs([
      tab('second', 1, { tabId: 11 }),
      tab('third', 3, { tabId: 12 }),
      tab('first', 5, { tabId: 10, active: true }),
    ]);
    test.clock.time = 20_000;

    const tick = await test.service.handleDueTick(due(started));

    expect(tick.status).toBe('completed');
    expect(test.browser.activateTab).toHaveBeenCalledOnce();
    expect(test.browser.activateTab).toHaveBeenCalledWith(11);
    expect(test.session).toMatchObject({
      state: 'running',
      cursor: 1,
      lastRunAt: 20_000,
      updatedAt: 20_000,
      nextRunAt: 30_000,
      lastResult: {
        counts: { succeeded: 1, skipped: 0, failed: 0, total: 1 },
      },
    });
    expect(test.session?.targets.map(({ key, index }) => ({ key, index }))).toEqual([
      { key: 'second', index: 1 },
      { key: 'third', index: 3 },
      { key: 'first', index: 5 },
    ]);
    expect(test.store.setRotationSession).toHaveBeenCalledTimes(2);
    expect(test.schedule).toHaveBeenLastCalledWith({
      kind: 'rotation',
      scheduleId: started.id,
      intervalMs: 10_000,
    });
  });

  it('re-evaluates changed filters before a tick and continues with the remaining targets', async () => {
    const tabs = [
      tab('first', 0, { active: true }),
      tab('second', 1),
      tab('third', 2),
      tab('blocked', 3),
    ];
    const test = fixture(tabs);
    const started = await test.service.start(
      startInput({ targetKeys: tabs.map(({ key }) => key) }),
    );
    test.setSettings({ ...DEFAULT_SETTINGS, blocklist: ['blocked.example'] });
    test.clock.time = 12_000;

    const tick = await test.service.handleDueTick(due(started));

    expect(tick).toMatchObject({
      status: 'completed',
      result: { counts: { succeeded: 1, skipped: 1, failed: 0, total: 2 } },
    });
    expect(test.session?.targets.map(({ key }) => key)).toEqual(['first', 'second', 'third']);
    expect(test.session?.lastResult?.targets).toContainEqual({
      status: 'skipped',
      targetKey: 'blocked',
      reason: 'filtered-out',
    });
  });

  it('stops safely with an explanation when tab closure leaves fewer than two targets', async () => {
    const test = fixture([tab('first', 0, { active: true }), tab('second', 1)]);
    const started = await test.service.start(startInput({ targetKeys: ['first', 'second'] }));
    test.setAllTabs([tab('first', 0, { active: true })]);
    test.clock.time = 11_000;

    const tick = await test.service.handleDueTick(due(started));

    expect(tick).toMatchObject({
      status: 'stopped',
      reason: 'insufficient-targets',
      session: {
        state: 'needs-attention',
        attentionReason: 'insufficient-targets',
        lastRunAt: 11_000,
      },
      result: { counts: { succeeded: 0, skipped: 1, failed: 0, total: 1 } },
    });
    expect(test.browser.activateTab).not.toHaveBeenCalled();
    expect(test.session?.targets.map(({ key }) => key)).toEqual(['first']);
    expect(test.cancel).toHaveBeenCalledWith('rotation');
    expect(test.schedule).toHaveBeenCalledOnce();
  });

  it('records an activation failure, keeps the preceding cursor, and schedules the next tick', async () => {
    const test = fixture();
    vi.mocked(test.browser.activateTab).mockResolvedValue({
      ok: false,
      error: { code: 'tab-activation-failed', operation: 'activate-tab' },
    });
    const started = await test.service.start(startInput());
    test.clock.time = 11_000;

    const tick = await test.service.handleDueTick(due(started));

    expect(tick).toMatchObject({
      status: 'completed',
      result: { counts: { succeeded: 0, skipped: 0, failed: 1, total: 1 } },
    });
    expect(test.session).toMatchObject({
      state: 'running',
      cursor: 0,
      lastRunAt: 11_000,
      nextRunAt: 21_000,
      lastResult: {
        targets: [{ status: 'failure', targetKey: 'second', errorCode: 'tab-activation-failed' }],
      },
    });
    expect(test.schedule).toHaveBeenCalledTimes(2);
  });

  it('serializes duplicate due delivery so the same due timestamp acts only once', async () => {
    const test = fixture();
    const started = await test.service.start(startInput());
    test.clock.time = 11_000;
    const event = due(started);

    const results = await Promise.all([
      test.service.handleDueTick(event),
      test.service.handleDueTick(event),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['completed', 'ignored']);
    expect(test.browser.activateTab).toHaveBeenCalledOnce();
    expect(test.schedule).toHaveBeenCalledTimes(2);
  });

  it('enters needs-attention without activation when the all-window query fails', async () => {
    const test = fixture();
    const started = await test.service.start(startInput());
    vi.mocked(test.browser.queryAllWindowTabs).mockResolvedValue({
      ok: false,
      error: { code: 'browser-operation-failed', operation: 'query-all-window-tabs' },
    });
    test.clock.time = 11_000;

    await expect(test.service.handleDueTick(due(started))).resolves.toMatchObject({
      status: 'needs-attention',
      reason: 'browser-operation-failed',
      session: {
        state: 'needs-attention',
        attentionReason: 'browser-operation-failed',
      },
    });
    expect(test.browser.activateTab).not.toHaveBeenCalled();
    expect(test.cancel).toHaveBeenCalledWith('rotation');
  });
});
