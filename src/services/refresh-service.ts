import { MIN_REFRESH_INTERVAL_MS } from '@/core/defaults';
import {
  aggregateRefreshResults,
  createRefreshPlan,
  executeRefreshPlan,
} from '@/core/refresh-engine';
import { parseRuleConfiguration } from '@/core/rule-engine';
import type { HybridScheduler, SchedulerClock, SchedulerDueEvent } from '@/core/scheduler';
import {
  evaluateTargetFilter,
  type CurrentTabSnapshot,
  type TargetFilterPolicy,
} from '@/core/target-reconciler';
import {
  DOMAIN_ERROR_CODES,
  RUNTIME_SCHEMA_VERSION,
  type ActionResultSummary,
  type DomainErrorCode,
  type RefreshSchedule,
  type Settings,
  type TabDescriptor,
  type TargetActionResult,
  type Timestamp,
} from '@/core/types';
import type { BrowserApiAdapter, BrowserTabSnapshot } from '@/platform/browser-api';

export interface StartRefreshInput {
  targetKeys: readonly string[];
  intervalMs: number;
  replaceExisting: boolean;
}

export interface RefreshNowInput {
  targetKeys: readonly string[];
}

export interface RefreshServiceStore {
  getRefreshSchedule(): Promise<RefreshSchedule | null>;
  setRefreshSchedule(schedule: RefreshSchedule): Promise<RefreshSchedule>;
  clearRefreshSchedule(): Promise<void>;
}

export type RefreshServiceBrowser = Pick<
  BrowserApiAdapter,
  'queryCurrentWindowTabs' | 'queryAllWindowTabs' | 'reloadTab'
>;

export interface RefreshServiceDependencies {
  browser: RefreshServiceBrowser;
  clock: SchedulerClock;
  scheduler: HybridScheduler;
  store: RefreshServiceStore;
  readSettings(): Promise<Settings>;
  createId(): string;
}

export type RefreshDueResult =
  | { status: 'ignored'; schedule: RefreshSchedule | null }
  | {
      status: 'completed';
      schedule: RefreshSchedule;
      result: ActionResultSummary;
    }
  | {
      status: 'needs-attention';
      reason: DomainErrorCode;
      schedule: RefreshSchedule;
      result?: ActionResultSummary;
    };

export interface RefreshService {
  start(input: StartRefreshInput): Promise<RefreshSchedule>;
  stop(): Promise<null>;
  handleDueRun(event: SchedulerDueEvent): Promise<RefreshDueResult>;
  refreshNow(input: RefreshNowInput): Promise<ActionResultSummary>;
}

export class RefreshServiceError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(`Refresh service failed: ${code}.`);
    this.name = 'RefreshServiceError';
  }
}

type ActionableTab = BrowserTabSnapshot & { tabId: number; windowId: number; url: string };

const DOMAIN_ERROR_CODE_SET = new Set<string>(DOMAIN_ERROR_CODES);

function isSafeIdentifier(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isActionableTab(tab: BrowserTabSnapshot): tab is ActionableTab {
  return (
    isSafeIdentifier(tab.tabId) && isSafeIdentifier(tab.windowId) && typeof tab.url === 'string'
  );
}

function errorCodeFrom(error: unknown, fallback: DomainErrorCode): DomainErrorCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DOMAIN_ERROR_CODE_SET.has(error.code)
  ) {
    return error.code as DomainErrorCode;
  }

  return fallback;
}

function policyFrom(settings: Settings): TargetFilterPolicy {
  const rules = parseRuleConfiguration(settings.allowlist, settings.blocklist);

  if (!rules.valid) {
    throw new RefreshServiceError('invalid-settings');
  }

  return { includePinned: settings.includePinned, rules: rules.configuration };
}

function descriptorFrom(tab: ActionableTab): TabDescriptor {
  return {
    key: tab.key,
    tabId: tab.tabId,
    windowId: tab.windowId,
    url: tab.url,
    ...(tab.title === undefined ? {} : { title: tab.title }),
    index: tab.index,
    pinned: tab.pinned,
  };
}

function captureScheduleTargets(
  tabs: readonly BrowserTabSnapshot[],
  targetKeys: readonly string[],
  policy: TargetFilterPolicy,
): { targets: readonly TabDescriptor[]; sourceWindowId: number } {
  const selectedKeys = new Set(targetKeys);
  const targets = tabs
    .filter(
      (tab): tab is ActionableTab =>
        selectedKeys.has(tab.key) &&
        isActionableTab(tab) &&
        evaluateTargetFilter(tab, policy).eligible,
    )
    .sort((left, right) => left.index - right.index || left.key.localeCompare(right.key))
    .map(descriptorFrom);

  if (targets.length === 0) {
    throw new RefreshServiceError('insufficient-targets');
  }

  const sourceWindowId = targets[0]!.windowId!;

  if (targets.some(({ windowId }) => windowId !== sourceWindowId)) {
    throw new RefreshServiceError('invalid-request');
  }

  return { targets, sourceWindowId };
}

function sameTargets(left: readonly TabDescriptor[], right: readonly TabDescriptor[]): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        target.key === other.key &&
        target.tabId === other.tabId &&
        target.windowId === other.windowId &&
        target.url === other.url &&
        target.index === other.index &&
        target.pinned === other.pinned
      );
    })
  );
}

function isSameRunningRequest(
  schedule: RefreshSchedule | null,
  input: StartRefreshInput,
  targets: readonly TabDescriptor[],
  sourceWindowId: number,
): schedule is Extract<RefreshSchedule, { state: 'running' }> {
  return (
    schedule?.state === 'running' &&
    schedule.intervalMs === input.intervalMs &&
    schedule.sourceWindowId === sourceWindowId &&
    sameTargets(schedule.targets, targets)
  );
}

function checkedNow(clock: SchedulerClock): Timestamp {
  const now = clock.now();

  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RefreshServiceError('unexpected-error');
  }

  return now;
}

function updatedAt(schedule: RefreshSchedule, now: Timestamp): Timestamp {
  return Math.max(now, schedule.createdAt, schedule.updatedAt, schedule.lastRunAt ?? 0);
}

function asAttention(
  schedule: RefreshSchedule,
  reason: DomainErrorCode,
  now: Timestamp,
  changes: Partial<Pick<RefreshSchedule, 'targets' | 'lastRunAt' | 'lastResult'>> = {},
): RefreshSchedule {
  const { nextRunAt: _nextRunAt, attentionReason: _attentionReason, ...base } = schedule;

  return {
    ...base,
    ...changes,
    state: 'needs-attention',
    attentionReason: reason,
    updatedAt: updatedAt(schedule, now),
  } as RefreshSchedule;
}

function currentSnapshots(tabs: readonly BrowserTabSnapshot[]): readonly CurrentTabSnapshot[] {
  return tabs
    .filter((tab): tab is BrowserTabSnapshot & { windowId: number } =>
      isSafeIdentifier(tab.windowId),
    )
    .map((tab) => ({
      ...(tab.tabId === undefined ? {} : { tabId: tab.tabId }),
      windowId: tab.windowId,
      ...(tab.url === undefined ? {} : { url: tab.url }),
      ...(tab.title === undefined ? {} : { title: tab.title }),
      index: tab.index,
      pinned: tab.pinned,
    }));
}

function readyTargets(plan: ReturnType<typeof createRefreshPlan>): readonly TabDescriptor[] {
  return plan.entries
    .filter((entry) => entry.status === 'ready')
    .map(({ target }) => target)
    .sort((left, right) => left.index - right.index || left.key.localeCompare(right.key));
}

function validateTargetKeys(targetKeys: readonly string[]): void {
  if (
    !Array.isArray(targetKeys) ||
    targetKeys.length === 0 ||
    targetKeys.some((key) => typeof key !== 'string' || key.trim().length === 0)
  ) {
    throw new RefreshServiceError('invalid-request');
  }
}

function validateStartInput(input: StartRefreshInput): void {
  validateTargetKeys(input.targetKeys);

  if (typeof input.replaceExisting !== 'boolean') {
    throw new RefreshServiceError('invalid-request');
  }

  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < MIN_REFRESH_INTERVAL_MS) {
    throw new RefreshServiceError('invalid-interval');
  }
}

/** Coordinates persisted refresh state, current browser state, and the refresh scheduler slot. */
export function createRefreshService({
  browser,
  clock,
  scheduler,
  store,
  readSettings,
  createId,
}: RefreshServiceDependencies): RefreshService {
  let operationQueue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function getSchedule(): Promise<RefreshSchedule | null> {
    try {
      return await store.getRefreshSchedule();
    } catch (error) {
      throw new RefreshServiceError(errorCodeFrom(error, 'storage-read-failed'));
    }
  }

  async function setSchedule(schedule: RefreshSchedule): Promise<RefreshSchedule> {
    try {
      return await store.setRefreshSchedule(schedule);
    } catch (error) {
      throw new RefreshServiceError(errorCodeFrom(error, 'storage-write-failed'));
    }
  }

  async function settings(): Promise<Settings> {
    try {
      return await readSettings();
    } catch (error) {
      throw new RefreshServiceError(errorCodeFrom(error, 'storage-read-failed'));
    }
  }

  async function cancelWithoutBlocking(): Promise<void> {
    try {
      await scheduler.cancel('refresh');
    } catch {
      // Persisted non-running or absent state makes a stale delivery harmless.
    }
  }

  async function restoreRegistration(schedule: RefreshSchedule | null): Promise<void> {
    try {
      if (schedule?.state === 'running') {
        await scheduler.recover({
          kind: 'refresh',
          scheduleId: schedule.id,
          intervalMs: schedule.intervalMs,
          nextRunAt: schedule.nextRunAt,
        });
      } else {
        await scheduler.cancel('refresh');
      }
    } catch {
      // The original persisted record remains the recovery source of truth.
    }
  }

  async function enterAttention(
    schedule: RefreshSchedule,
    reason: DomainErrorCode,
    now: Timestamp,
    changes?: Partial<Pick<RefreshSchedule, 'targets' | 'lastRunAt' | 'lastResult'>>,
  ): Promise<RefreshSchedule> {
    const attention = asAttention(schedule, reason, now, changes);
    const persisted = await setSchedule(attention);
    await cancelWithoutBlocking();
    return persisted;
  }

  async function start(input: StartRefreshInput): Promise<RefreshSchedule> {
    validateStartInput(input);
    const existing = await getSchedule();
    const [currentSettings, query] = await Promise.all([
      settings(),
      browser.queryCurrentWindowTabs(),
    ]);

    if (!query.ok) {
      throw new RefreshServiceError(query.error.code);
    }

    const policy = policyFrom(currentSettings);
    const captured = captureScheduleTargets(query.value, input.targetKeys, policy);

    if (isSameRunningRequest(existing, input, captured.targets, captured.sourceWindowId)) {
      return existing;
    }

    if (existing !== null && !input.replaceExisting) {
      throw new RefreshServiceError('replacement-confirmation-required');
    }

    const now = checkedNow(clock);
    const id = createId();

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new RefreshServiceError('unexpected-error');
    }

    let scheduled;

    try {
      scheduled = await scheduler.schedule({
        kind: 'refresh',
        scheduleId: id,
        intervalMs: input.intervalMs,
      });
    } catch (error) {
      await restoreRegistration(existing);
      throw new RefreshServiceError(errorCodeFrom(error, 'unexpected-error'));
    }

    const schedule: RefreshSchedule = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id,
      state: 'running',
      targets: captured.targets,
      sourceWindowId: captured.sourceWindowId,
      intervalMs: input.intervalMs,
      createdAt: now,
      updatedAt: now,
      nextRunAt: scheduled.nextRunAt,
    };

    try {
      return await setSchedule(schedule);
    } catch (error) {
      await cancelWithoutBlocking();
      await restoreRegistration(existing);
      throw error;
    }
  }

  async function stop(): Promise<null> {
    await cancelWithoutBlocking();

    try {
      await store.clearRefreshSchedule();
    } catch (error) {
      throw new RefreshServiceError(errorCodeFrom(error, 'storage-write-failed'));
    }

    return null;
  }

  async function handleDueRun(event: SchedulerDueEvent): Promise<RefreshDueResult> {
    const current = await getSchedule();

    if (
      event.kind !== 'refresh' ||
      current?.state !== 'running' ||
      current.id !== event.scheduleId ||
      current.nextRunAt !== event.dueAt
    ) {
      return { status: 'ignored', schedule: current };
    }

    let currentSettings: Settings;

    try {
      currentSettings = await settings();
    } catch (error) {
      const reason = errorCodeFrom(error, 'storage-read-failed');
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, schedule: attention };
    }

    let query;

    try {
      query = await browser.queryAllWindowTabs();
    } catch (error) {
      const reason = errorCodeFrom(error, 'browser-operation-failed');
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, schedule: attention };
    }

    if (!query.ok) {
      const reason = query.error.code;
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, schedule: attention };
    }

    let policy: TargetFilterPolicy;

    try {
      policy = policyFrom(currentSettings);
    } catch (error) {
      const reason = errorCodeFrom(error, 'invalid-settings');
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, schedule: attention };
    }

    const plan = createRefreshPlan({
      capturedTargets: current.targets,
      currentTabs: currentSnapshots(query.value),
      sourceWindowId: current.sourceWindowId,
      policy,
    });
    const targets = readyTargets(plan);
    const actionResults = await executeRefreshPlan(plan, async (target) => {
      const reload = await browser.reloadTab(target.tabId!);

      if (!reload.ok) {
        throw new RefreshServiceError(reload.error.code);
      }
    });
    const completedAt = checkedNow(clock);
    const result = aggregateRefreshResults('scheduled-refresh', completedAt, actionResults);

    if (targets.length === 0) {
      const attention = await enterAttention(current, 'insufficient-targets', completedAt, {
        targets,
        lastRunAt: completedAt,
        lastResult: result,
      });
      return {
        status: 'needs-attention',
        reason: 'insufficient-targets',
        schedule: attention,
        result,
      };
    }

    let scheduled;

    try {
      scheduled = await scheduler.schedule({
        kind: 'refresh',
        scheduleId: current.id,
        intervalMs: current.intervalMs,
      });
    } catch (error) {
      const reason = errorCodeFrom(error, 'unexpected-error');
      const attention = await enterAttention(current, reason, completedAt, {
        targets,
        lastRunAt: completedAt,
        lastResult: result,
      });
      return { status: 'needs-attention', reason, schedule: attention, result };
    }

    const next: RefreshSchedule = {
      ...current,
      state: 'running',
      targets,
      updatedAt: updatedAt(current, completedAt),
      lastRunAt: completedAt,
      lastResult: result,
      nextRunAt: scheduled.nextRunAt,
    };

    try {
      const persisted = await setSchedule(next);
      return { status: 'completed', schedule: persisted, result };
    } catch (error) {
      await cancelWithoutBlocking();
      throw error;
    }
  }

  async function refreshNow(input: RefreshNowInput): Promise<ActionResultSummary> {
    validateTargetKeys(input.targetKeys);
    const [currentSettings, query] = await Promise.all([
      settings(),
      browser.queryCurrentWindowTabs(),
    ]);

    if (!query.ok) {
      throw new RefreshServiceError(query.error.code);
    }

    const policy = policyFrom(currentSettings);
    const selectedKeys = new Set(input.targetKeys);
    const selectedTabs = query.value.filter((tab) => selectedKeys.has(tab.key));
    const sourceWindowId = selectedTabs.find(isActionableTab)?.windowId;

    if (sourceWindowId === undefined) {
      throw new RefreshServiceError('insufficient-targets');
    }

    const capturedTargets = selectedTabs
      .filter(isActionableTab)
      .sort((left, right) => left.index - right.index || left.key.localeCompare(right.key))
      .map(descriptorFrom);
    const plan = createRefreshPlan({
      capturedTargets,
      currentTabs: currentSnapshots(query.value),
      sourceWindowId,
      policy,
    });
    const plannedKeys = new Set(capturedTargets.map(({ key }) => key));
    const missingResults: TargetActionResult[] = [...selectedKeys]
      .filter((key) => !plannedKeys.has(key))
      .map((targetKey) => ({ status: 'skipped', targetKey, reason: 'missing-tab' }));
    const actionResults = await executeRefreshPlan(plan, async (target) => {
      const reload = await browser.reloadTab(target.tabId!);

      if (!reload.ok) {
        throw new RefreshServiceError(reload.error.code);
      }
    });

    return aggregateRefreshResults('refresh-now', checkedNow(clock), [
      ...actionResults,
      ...missingResults,
    ]);
  }

  return {
    start: (input) => enqueue(() => start(input)),
    stop: () => enqueue(stop),
    handleDueRun: (event) => enqueue(() => handleDueRun(event)),
    refreshNow: (input) => enqueue(() => refreshNow(input)),
  };
}
