import { MIN_ROTATION_INTERVAL_MS } from '@/core/defaults';
import { selectNextRotationTarget, type RandomSource } from '@/core/rotation-engine';
import { parseRuleConfiguration, type RuleConfiguration } from '@/core/rule-engine';
import type { HybridScheduler, SchedulerClock, SchedulerDueEvent } from '@/core/scheduler';
import {
  reconcileTargets,
  evaluateTargetFilter,
  type CurrentTabSnapshot,
  type TargetFilterPolicy,
  type TargetReconciliationOutcome,
} from '@/core/target-reconciler';
import {
  DOMAIN_ERROR_CODES,
  RUNTIME_SCHEMA_VERSION,
  type ActionResultSummary,
  type DomainErrorCode,
  type RotationDirection,
  type RotationSession,
  type Settings,
  type TabDescriptor,
  type TargetActionResult,
  type Timestamp,
} from '@/core/types';
import type {
  BrowserApiAdapter,
  BrowserOperationResult,
  BrowserTabSnapshot,
} from '@/platform/browser-api';

export interface StartRotationInput {
  targetKeys: readonly string[];
  intervalMs: number;
  direction: RotationDirection;
  replaceExisting: boolean;
}

export interface RotationServiceStore {
  getRotationSession(): Promise<RotationSession | null>;
  setRotationSession(session: RotationSession): Promise<RotationSession>;
  clearRotationSession(): Promise<void>;
}

export type RotationServiceBrowser = Pick<
  BrowserApiAdapter,
  'queryCurrentWindowTabs' | 'queryAllWindowTabs' | 'activateTab'
>;

export interface RotationServiceDependencies {
  browser: RotationServiceBrowser;
  clock: SchedulerClock;
  scheduler: HybridScheduler;
  store: RotationServiceStore;
  readSettings(): Promise<Settings>;
  createId(): string;
  random?: RandomSource;
}

export type RotationTickResult =
  | { status: 'ignored'; session: RotationSession | null }
  | {
      status: 'completed';
      session: RotationSession;
      result: ActionResultSummary;
    }
  | {
      status: 'stopped';
      reason: Extract<DomainErrorCode, 'insufficient-targets'>;
      session: RotationSession;
      result: ActionResultSummary;
    }
  | {
      status: 'needs-attention';
      reason: DomainErrorCode;
      session: RotationSession;
      result?: ActionResultSummary;
    };

export interface RotationService {
  start(input: StartRotationInput): Promise<RotationSession>;
  pause(): Promise<RotationSession>;
  resume(): Promise<RotationSession>;
  stop(): Promise<null>;
  handleDueTick(event: SchedulerDueEvent): Promise<RotationTickResult>;
}

export class RotationServiceError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(`Rotation service failed: ${code}.`);
    this.name = 'RotationServiceError';
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

function isDirection(value: unknown): value is RotationDirection {
  return value === 'forward' || value === 'backward' || value === 'random';
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
    throw new RotationServiceError('invalid-settings');
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

function initialCursor(
  tabs: readonly BrowserTabSnapshot[],
  targets: readonly TabDescriptor[],
  sourceWindowId: number,
  direction: RotationDirection,
): number {
  const activeIndex = tabs.find(
    (tab) => tab.active && tab.windowId === sourceWindowId && Number.isSafeInteger(tab.index),
  )?.index;

  if (activeIndex !== undefined && activeIndex >= 0) {
    return activeIndex;
  }

  if (direction === 'forward') {
    return Math.max(...targets.map(({ index }) => index));
  }

  if (direction === 'backward') {
    return Math.min(...targets.map(({ index }) => index));
  }

  return Number.MAX_SAFE_INTEGER;
}

function captureTargets(
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

  if (targets.length < 2) {
    throw new RotationServiceError('insufficient-targets');
  }

  const sourceWindowId = targets[0]!.windowId!;

  if (targets.some(({ windowId }) => windowId !== sourceWindowId)) {
    throw new RotationServiceError('invalid-request');
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
  session: RotationSession | null,
  input: StartRotationInput,
  targets: readonly TabDescriptor[],
  sourceWindowId: number,
): session is Extract<RotationSession, { state: 'running' }> {
  return (
    session?.state === 'running' &&
    session.intervalMs === input.intervalMs &&
    session.direction === input.direction &&
    session.sourceWindowId === sourceWindowId &&
    sameTargets(session.targets, targets)
  );
}

function checkedNow(clock: SchedulerClock): Timestamp {
  const now = clock.now();

  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RotationServiceError('unexpected-error');
  }

  return now;
}

function updatedAt(session: RotationSession, now: Timestamp): Timestamp {
  return Math.max(now, session.createdAt, session.updatedAt, session.lastRunAt ?? 0);
}

function asPaused(session: RotationSession, now: Timestamp): RotationSession {
  const { nextRunAt: _nextRunAt, attentionReason: _attentionReason, ...base } = session;

  return {
    ...base,
    state: 'paused',
    updatedAt: updatedAt(session, now),
  };
}

function asAttention(
  session: RotationSession,
  reason: DomainErrorCode,
  now: Timestamp,
  changes: Partial<Pick<RotationSession, 'targets' | 'cursor' | 'lastRunAt' | 'lastResult'>> = {},
): RotationSession {
  const { nextRunAt: _nextRunAt, attentionReason: _attentionReason, ...base } = session;

  return {
    ...base,
    ...changes,
    state: 'needs-attention',
    attentionReason: reason,
    updatedAt: updatedAt(session, now),
  } as RotationSession;
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

function skippedResults(outcomes: readonly TargetReconciliationOutcome[]): TargetActionResult[] {
  return outcomes
    .filter((outcome) => outcome.status === 'skipped')
    .map(({ targetKey, reason }) => ({ status: 'skipped', targetKey, reason }));
}

function summarize(
  completedAt: Timestamp,
  targets: readonly TargetActionResult[],
): ActionResultSummary {
  return {
    action: 'rotation',
    completedAt,
    targets: [...targets],
    counts: {
      succeeded: targets.filter(({ status }) => status === 'success').length,
      skipped: targets.filter(({ status }) => status === 'skipped').length,
      failed: targets.filter(({ status }) => status === 'failure').length,
      total: targets.length,
    },
  };
}

function validateStartInput(input: StartRotationInput): void {
  if (
    !Array.isArray(input.targetKeys) ||
    input.targetKeys.some((key) => typeof key !== 'string' || key.trim().length === 0) ||
    typeof input.replaceExisting !== 'boolean' ||
    !isDirection(input.direction)
  ) {
    throw new RotationServiceError('invalid-request');
  }

  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < MIN_ROTATION_INTERVAL_MS) {
    throw new RotationServiceError('invalid-interval');
  }
}

/** Coordinates persisted rotation state, current browser state, and one hybrid scheduler slot. */
export function createRotationService({
  browser,
  clock,
  scheduler,
  store,
  readSettings,
  createId,
  random = Math.random,
}: RotationServiceDependencies): RotationService {
  let operationQueue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function getSession(): Promise<RotationSession | null> {
    try {
      return await store.getRotationSession();
    } catch (error) {
      throw new RotationServiceError(errorCodeFrom(error, 'storage-read-failed'));
    }
  }

  async function setSession(session: RotationSession): Promise<RotationSession> {
    try {
      return await store.setRotationSession(session);
    } catch (error) {
      throw new RotationServiceError(errorCodeFrom(error, 'storage-write-failed'));
    }
  }

  async function settings(): Promise<Settings> {
    try {
      return await readSettings();
    } catch (error) {
      throw new RotationServiceError(errorCodeFrom(error, 'storage-read-failed'));
    }
  }

  async function cancelWithoutBlocking(): Promise<void> {
    try {
      await scheduler.cancel('rotation');
    } catch {
      // Persisted non-running or absent state makes a stale delivery harmless.
    }
  }

  async function restoreRegistration(session: RotationSession | null): Promise<void> {
    try {
      if (session?.state === 'running') {
        await scheduler.recover({
          kind: 'rotation',
          scheduleId: session.id,
          intervalMs: session.intervalMs,
          nextRunAt: session.nextRunAt,
        });
      } else {
        await scheduler.cancel('rotation');
      }
    } catch {
      // The original persisted record remains the recovery source of truth.
    }
  }

  async function enterAttention(
    session: RotationSession,
    reason: DomainErrorCode,
    now: Timestamp,
    changes?: Partial<Pick<RotationSession, 'targets' | 'cursor' | 'lastRunAt' | 'lastResult'>>,
  ): Promise<RotationSession> {
    const attention = asAttention(session, reason, now, changes);
    const persisted = await setSession(attention);
    await cancelWithoutBlocking();
    return persisted;
  }

  async function start(input: StartRotationInput): Promise<RotationSession> {
    validateStartInput(input);
    const existing = await getSession();
    const [currentSettings, query] = await Promise.all([
      settings(),
      browser.queryCurrentWindowTabs(),
    ]);

    if (!query.ok) {
      throw new RotationServiceError(query.error.code);
    }

    const policy = policyFrom(currentSettings);
    const captured = captureTargets(query.value, input.targetKeys, policy);

    if (isSameRunningRequest(existing, input, captured.targets, captured.sourceWindowId)) {
      return existing;
    }

    if (existing !== null && !input.replaceExisting) {
      throw new RotationServiceError('replacement-confirmation-required');
    }

    const now = checkedNow(clock);
    const id = createId();

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new RotationServiceError('unexpected-error');
    }

    let scheduled;

    try {
      scheduled = await scheduler.schedule({
        kind: 'rotation',
        scheduleId: id,
        intervalMs: input.intervalMs,
      });
    } catch (error) {
      await restoreRegistration(existing);
      throw new RotationServiceError(errorCodeFrom(error, 'unexpected-error'));
    }

    const session: RotationSession = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id,
      state: 'running',
      targets: captured.targets,
      sourceWindowId: captured.sourceWindowId,
      intervalMs: input.intervalMs,
      direction: input.direction,
      cursor: initialCursor(
        query.value,
        captured.targets,
        captured.sourceWindowId,
        input.direction,
      ),
      createdAt: now,
      updatedAt: now,
      nextRunAt: scheduled.nextRunAt,
    };

    try {
      return await setSession(session);
    } catch (error) {
      await cancelWithoutBlocking();
      await restoreRegistration(existing);
      throw error;
    }
  }

  async function pause(): Promise<RotationSession> {
    const current = await getSession();

    if (current === null || current.state === 'needs-attention') {
      throw new RotationServiceError('schedule-not-found');
    }

    if (current.state === 'paused') {
      await cancelWithoutBlocking();
      return current;
    }

    const paused = await setSession(asPaused(current, checkedNow(clock)));
    await cancelWithoutBlocking();
    return paused;
  }

  async function resume(): Promise<RotationSession> {
    const current = await getSession();

    if (current === null || current.state === 'needs-attention') {
      throw new RotationServiceError('schedule-not-found');
    }

    if (current.state === 'running') {
      return current;
    }

    let scheduled;

    try {
      scheduled = await scheduler.schedule({
        kind: 'rotation',
        scheduleId: current.id,
        intervalMs: current.intervalMs,
      });
    } catch (error) {
      throw new RotationServiceError(errorCodeFrom(error, 'unexpected-error'));
    }

    const resumed: RotationSession = {
      ...current,
      state: 'running',
      updatedAt: updatedAt(current, checkedNow(clock)),
      nextRunAt: scheduled.nextRunAt,
    };

    try {
      return await setSession(resumed);
    } catch (error) {
      await cancelWithoutBlocking();
      throw error;
    }
  }

  async function stop(): Promise<null> {
    await cancelWithoutBlocking();

    try {
      await store.clearRotationSession();
    } catch (error) {
      throw new RotationServiceError(errorCodeFrom(error, 'storage-write-failed'));
    }

    return null;
  }

  async function handleDueTick(event: SchedulerDueEvent): Promise<RotationTickResult> {
    const current = await getSession();

    if (
      event.kind !== 'rotation' ||
      current?.state !== 'running' ||
      current.id !== event.scheduleId ||
      current.nextRunAt !== event.dueAt
    ) {
      return { status: 'ignored', session: current };
    }

    let currentSettings: Settings;

    try {
      currentSettings = await settings();
    } catch (error) {
      const reason = errorCodeFrom(error, 'storage-read-failed');
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, session: attention };
    }

    let query: BrowserOperationResult<readonly BrowserTabSnapshot[]>;

    try {
      query = await browser.queryAllWindowTabs();
    } catch (error) {
      const reason = errorCodeFrom(error, 'browser-operation-failed');
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, session: attention };
    }

    if (!query.ok) {
      const reason = query.error.code;
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, session: attention };
    }

    let policy: TargetFilterPolicy;

    try {
      policy = policyFrom(currentSettings);
    } catch (error) {
      const reason = errorCodeFrom(error, 'invalid-settings');
      const attention = await enterAttention(current, reason, checkedNow(clock));
      return { status: 'needs-attention', reason, session: attention };
    }

    const currentTargetKey = current.targets.find(({ index }) => index === current.cursor)?.key;
    const reconciliation = reconcileTargets({
      capturedTargets: current.targets,
      currentTabs: currentSnapshots(query.value),
      sourceWindowId: current.sourceWindowId,
      policy,
    });
    const skipped = skippedResults(reconciliation.outcomes);

    if (reconciliation.targets.length < 2) {
      const completedAt = checkedNow(clock);
      const result = summarize(completedAt, skipped);
      const stopped = await enterAttention(current, 'insufficient-targets', completedAt, {
        targets: reconciliation.targets,
        lastRunAt: completedAt,
        lastResult: result,
      });
      return { status: 'stopped', reason: 'insufficient-targets', session: stopped, result };
    }

    const selection = selectNextRotationTarget(
      {
        targets: reconciliation.targets,
        direction: current.direction,
        cursor: current.cursor,
        ...(currentTargetKey === undefined ? {} : { currentTargetKey }),
      },
      random,
    );

    if (selection.status === 'stop') {
      const completedAt = checkedNow(clock);
      const result = summarize(completedAt, skipped);
      const stopped = await enterAttention(current, selection.reason, completedAt, {
        targets: reconciliation.targets,
        lastRunAt: completedAt,
        lastResult: result,
      });
      return { status: 'stopped', reason: selection.reason, session: stopped, result };
    }

    let actionResult: TargetActionResult;

    try {
      const activation = await browser.activateTab(selection.target.tabId!);
      actionResult = activation.ok
        ? { status: 'success', targetKey: selection.target.key }
        : {
            status: 'failure',
            targetKey: selection.target.key,
            errorCode: activation.error.code,
          };
    } catch {
      actionResult = {
        status: 'failure',
        targetKey: selection.target.key,
        errorCode: 'tab-activation-failed',
      };
    }

    const completedAt = checkedNow(clock);
    const result = summarize(completedAt, [...skipped, actionResult]);
    const previousTarget =
      currentTargetKey === undefined
        ? undefined
        : reconciliation.targets.find(({ key }) => key === currentTargetKey);
    const cursor =
      actionResult.status === 'success'
        ? selection.cursor
        : (previousTarget?.index ?? current.cursor);

    let scheduled;

    try {
      scheduled = await scheduler.schedule({
        kind: 'rotation',
        scheduleId: current.id,
        intervalMs: current.intervalMs,
      });
    } catch (error) {
      const reason = errorCodeFrom(error, 'unexpected-error');
      const attention = await enterAttention(current, reason, completedAt, {
        targets: reconciliation.targets,
        cursor,
        lastRunAt: completedAt,
        lastResult: result,
      });
      return { status: 'needs-attention', reason, session: attention, result };
    }

    const next: RotationSession = {
      ...current,
      state: 'running',
      targets: reconciliation.targets,
      cursor,
      updatedAt: updatedAt(current, completedAt),
      lastRunAt: completedAt,
      lastResult: result,
      nextRunAt: scheduled.nextRunAt,
    };

    try {
      const persisted = await setSession(next);
      return { status: 'completed', session: persisted, result };
    } catch (error) {
      await cancelWithoutBlocking();
      throw error;
    }
  }

  return {
    start: (input) => enqueue(() => start(input)),
    pause: () => enqueue(pause),
    resume: () => enqueue(resume),
    stop: () => enqueue(stop),
    handleDueTick: (event) => enqueue(() => handleDueTick(event)),
  };
}
