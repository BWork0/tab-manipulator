import type { HybridScheduler, ScheduleKind, SchedulerClock } from './scheduler';
import {
  DOMAIN_ERROR_CODES,
  type DomainErrorCode,
  type RefreshSchedule,
  type RotationSession,
  type TabDescriptor,
} from './types';

export interface RecoveryTabSnapshot {
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  index: number;
  pinned: boolean;
}

export interface RecoveryWindowScore {
  windowId: number;
  exactMatches: number;
  relativeOrderMatches: number;
  complete: boolean;
  ambiguous: boolean;
}

export type TargetRecoveryDecision =
  | {
      status: 'recovered';
      method: 'live-ids' | 'window-match';
      sourceWindowId: number;
      targets: readonly TabDescriptor[];
      windowScores: readonly RecoveryWindowScore[];
    }
  | {
      status: 'needs-attention';
      reason: Extract<DomainErrorCode, 'ambiguous-recovery'>;
      windowScores: readonly RecoveryWindowScore[];
    };

export type RecoveryBrowserResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: DomainErrorCode } };

export interface StartupRecoveryBrowser {
  queryAllWindowTabs(): Promise<RecoveryBrowserResult<readonly RecoveryTabSnapshot[]>>;
}

export interface StartupRecoveryStore {
  getRotationSession(): Promise<RotationSession | null>;
  setRotationSession(session: RotationSession): Promise<RotationSession>;
  getRefreshSchedule(): Promise<RefreshSchedule | null>;
  setRefreshSchedule(schedule: RefreshSchedule): Promise<RefreshSchedule>;
}

export interface StartupRecoveryDependencies {
  browser: StartupRecoveryBrowser;
  clock: SchedulerClock;
  scheduler: HybridScheduler;
  store: StartupRecoveryStore;
}

export type ScheduleRecoveryResult =
  | { kind: ScheduleKind; status: 'absent' }
  | {
      kind: ScheduleKind;
      status: 'recovered';
      method: 'live-ids' | 'window-match';
      scheduled: boolean;
    }
  | { kind: ScheduleKind; status: 'needs-attention'; reason: DomainErrorCode };

export interface StartupRecoveryResult {
  rotation: ScheduleRecoveryResult;
  refresh: ScheduleRecoveryResult;
}

export interface StartupRecovery {
  /** Runs at most once for this background application instance. */
  recover(): Promise<StartupRecoveryResult>;
}

type RuntimeRecord = RotationSession | RefreshSchedule;
type RecoverableRuntimeRecord = Extract<RuntimeRecord, { state: 'running' | 'paused' }>;

const DOMAIN_ERROR_CODE_SET = new Set<string>(DOMAIN_ERROR_CODES);

function isUsableSnapshot(
  tab: RecoveryTabSnapshot,
): tab is RecoveryTabSnapshot & { tabId: number; windowId: number; url: string } {
  return (
    Number.isSafeInteger(tab.tabId) &&
    (tab.tabId as number) >= 0 &&
    Number.isSafeInteger(tab.windowId) &&
    (tab.windowId as number) >= 0 &&
    typeof tab.url === 'string'
  );
}

function recoveredDescriptor(
  captured: TabDescriptor,
  current: RecoveryTabSnapshot & { tabId: number; windowId: number; url: string },
): TabDescriptor {
  return Object.freeze({
    key: captured.key,
    tabId: current.tabId,
    windowId: current.windowId,
    url: current.url,
    ...(current.title === undefined ? {} : { title: current.title }),
    index: current.index,
    pinned: current.pinned,
  });
}

function compareCapturedOrder(
  left: { inputOrder: number; target: TabDescriptor },
  right: { inputOrder: number; target: TabDescriptor },
): number {
  return left.target.index - right.target.index || left.inputOrder - right.inputOrder;
}

function relativeOrderScore(
  targets: readonly TabDescriptor[],
  matches: ReadonlyMap<string, RecoveryTabSnapshot>,
): number {
  const ordered = targets
    .map((target, inputOrder) => ({ inputOrder, target }))
    .sort(compareCapturedOrder)
    .map(({ target }) => matches.get(target.key))
    .filter((tab): tab is RecoveryTabSnapshot => tab !== undefined);
  let score = 0;

  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      if ((ordered[leftIndex]?.index ?? 0) < (ordered[rightIndex]?.index ?? 0)) {
        score += 1;
      }
    }
  }

  return score;
}

interface ScoredWindow {
  score: RecoveryWindowScore;
  matches: ReadonlyMap<
    string,
    RecoveryTabSnapshot & { tabId: number; windowId: number; url: string }
  >;
}

function scoreWindow(
  windowId: number,
  targets: readonly TabDescriptor[],
  tabs: readonly (RecoveryTabSnapshot & { tabId: number; windowId: number; url: string })[],
): ScoredWindow {
  const targetCounts = new Map<string, number>();
  const tabsByUrl = new Map<
    string,
    (RecoveryTabSnapshot & { tabId: number; windowId: number; url: string })[]
  >();

  for (const target of targets) {
    targetCounts.set(target.url, (targetCounts.get(target.url) ?? 0) + 1);
  }

  for (const tab of tabs) {
    const matchingTabs = tabsByUrl.get(tab.url) ?? [];
    matchingTabs.push(tab);
    tabsByUrl.set(tab.url, matchingTabs);
  }

  let exactMatches = 0;
  let ambiguous = false;

  for (const [url, targetCount] of targetCounts) {
    const tabCount = tabsByUrl.get(url)?.length ?? 0;
    exactMatches += Math.min(targetCount, tabCount);

    if (targetCount > 1 || tabCount > 1) {
      ambiguous = true;
    }
  }

  const matches = new Map<
    string,
    RecoveryTabSnapshot & { tabId: number; windowId: number; url: string }
  >();

  if (!ambiguous) {
    for (const target of targets) {
      const match = tabsByUrl.get(target.url)?.[0];

      if (match) {
        matches.set(target.key, match);
      }
    }
  }

  return {
    score: Object.freeze({
      windowId,
      exactMatches,
      relativeOrderMatches: relativeOrderScore(targets, matches),
      complete: exactMatches === targets.length,
      ambiguous,
    }),
    matches,
  };
}

function scoreWindows(
  targets: readonly TabDescriptor[],
  currentTabs: readonly RecoveryTabSnapshot[],
): readonly ScoredWindow[] {
  const tabsByWindow = new Map<
    number,
    (RecoveryTabSnapshot & { tabId: number; windowId: number; url: string })[]
  >();

  for (const tab of currentTabs) {
    if (!isUsableSnapshot(tab)) {
      continue;
    }

    const windowTabs = tabsByWindow.get(tab.windowId) ?? [];
    windowTabs.push(tab);
    tabsByWindow.set(tab.windowId, windowTabs);
  }

  return [...tabsByWindow]
    .sort(([leftWindowId], [rightWindowId]) => leftWindowId - rightWindowId)
    .map(([windowId, tabs]) => scoreWindow(windowId, targets, tabs));
}

function resolveByLiveIds(
  targets: readonly TabDescriptor[],
  sourceWindowId: number,
  currentTabs: readonly RecoveryTabSnapshot[],
): { status: 'complete'; targets: readonly TabDescriptor[] } | { status: 'none' | 'partial' } {
  const tabsById = new Map<number, RecoveryTabSnapshot[]>();

  for (const tab of currentTabs) {
    if (tab.tabId === undefined) {
      continue;
    }

    const matchingTabs = tabsById.get(tab.tabId) ?? [];
    matchingTabs.push(tab);
    tabsById.set(tab.tabId, matchingTabs);
  }

  const matches: (RecoveryTabSnapshot & { tabId: number; windowId: number; url: string })[] = [];

  for (const target of targets) {
    if (target.tabId === undefined) {
      continue;
    }

    const candidates = tabsById.get(target.tabId) ?? [];

    if (candidates.length !== 1) {
      continue;
    }

    const candidate = candidates[0];

    if (candidate && isUsableSnapshot(candidate) && candidate.url === target.url) {
      matches.push(candidate);
    }
  }

  if (matches.length === 0) {
    return { status: 'none' };
  }

  const uniqueIds = new Set(matches.map(({ tabId }) => tabId));
  const sameSourceWindow = matches.every(({ windowId }) => windowId === sourceWindowId);

  if (matches.length !== targets.length || uniqueIds.size !== targets.length || !sameSourceWindow) {
    return { status: 'partial' };
  }

  return {
    status: 'complete',
    targets: Object.freeze(
      targets.map((target, index) => recoveredDescriptor(target, matches[index]!)),
    ),
  };
}

/**
 * Revalidates live IDs first, then conservatively scores complete URL/order matches by window.
 * Duplicate target URLs or duplicate matching tabs are intentionally considered ambiguous.
 */
export function recoverRuntimeTargets(
  targets: readonly TabDescriptor[],
  sourceWindowId: number,
  currentTabs: readonly RecoveryTabSnapshot[],
  minimumTargetCount: number,
): TargetRecoveryDecision {
  if (targets.length < minimumTargetCount) {
    return { status: 'needs-attention', reason: 'ambiguous-recovery', windowScores: [] };
  }

  const liveIdResolution = resolveByLiveIds(targets, sourceWindowId, currentTabs);

  if (liveIdResolution.status === 'complete') {
    return {
      status: 'recovered',
      method: 'live-ids',
      sourceWindowId,
      targets: liveIdResolution.targets,
      windowScores: [],
    };
  }

  if (liveIdResolution.status === 'partial') {
    return { status: 'needs-attention', reason: 'ambiguous-recovery', windowScores: [] };
  }

  const scoredWindows = scoreWindows(targets, currentTabs);
  const candidates = scoredWindows.filter(({ score }) => score.complete && !score.ambiguous);
  const bestOrderScore = Math.max(-1, ...candidates.map(({ score }) => score.relativeOrderMatches));
  const winners = candidates.filter(({ score }) => score.relativeOrderMatches === bestOrderScore);
  const windowScores = Object.freeze(scoredWindows.map(({ score }) => score));

  if (winners.length !== 1) {
    return { status: 'needs-attention', reason: 'ambiguous-recovery', windowScores };
  }

  const winner = winners[0]!;

  return {
    status: 'recovered',
    method: 'window-match',
    sourceWindowId: winner.score.windowId,
    targets: Object.freeze(
      targets.map((target) => recoveredDescriptor(target, winner.matches.get(target.key)!)),
    ),
    windowScores,
  };
}

function safeUpdatedAt(record: RuntimeRecord, now: number): number {
  return Math.max(now, record.createdAt, record.updatedAt, record.lastRunAt ?? 0);
}

function withRecoveredTargets<TRecord extends RecoverableRuntimeRecord>(
  record: TRecord,
  decision: Extract<TargetRecoveryDecision, { status: 'recovered' }>,
  now: number,
): TRecord {
  return Object.freeze({
    ...record,
    targets: decision.targets,
    sourceWindowId: decision.sourceWindowId,
    updatedAt: safeUpdatedAt(record, now),
  }) as unknown as TRecord;
}

function withAttention<TRecord extends RuntimeRecord>(
  record: TRecord,
  reason: DomainErrorCode,
  now: number,
): TRecord {
  const { nextRunAt: _nextRunAt, attentionReason: _attentionReason, ...base } = record;

  return Object.freeze({
    ...base,
    state: 'needs-attention',
    attentionReason: reason,
    updatedAt: safeUpdatedAt(record, now),
  }) as TRecord;
}

function errorCodeFrom(error: unknown): DomainErrorCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DOMAIN_ERROR_CODE_SET.has(error.code)
  ) {
    return error.code as DomainErrorCode;
  }

  return 'unexpected-error';
}

async function cancelWithoutBlocking(
  scheduler: HybridScheduler,
  kind: ScheduleKind,
): Promise<void> {
  try {
    await scheduler.cancel(kind);
  } catch {
    // With no active in-memory registration, a stale browser alarm cannot dispatch a due action.
  }
}

async function performStartupRecovery({
  browser,
  clock,
  scheduler,
  store,
}: StartupRecoveryDependencies): Promise<StartupRecoveryResult> {
  const now = clock.now();

  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Invalid recovery clock value.');
  }

  const [rotation, refresh] = await Promise.all([
    store.getRotationSession(),
    store.getRefreshSchedule(),
  ]);
  const records = [
    { kind: 'rotation' as const, record: rotation },
    { kind: 'refresh' as const, record: refresh },
  ];
  const pending = records.filter(
    (entry): entry is typeof entry & { record: RecoverableRuntimeRecord } =>
      entry.record?.state === 'running' || entry.record?.state === 'paused',
  );

  for (const { kind, record } of records) {
    if (record === null || record.state === 'needs-attention') {
      await cancelWithoutBlocking(scheduler, kind);
    }
  }

  if (pending.length === 0) {
    return {
      rotation:
        rotation === null
          ? { kind: 'rotation', status: 'absent' }
          : {
              kind: 'rotation',
              status: 'needs-attention',
              reason: rotation.attentionReason ?? 'unexpected-error',
            },
      refresh:
        refresh === null
          ? { kind: 'refresh', status: 'absent' }
          : {
              kind: 'refresh',
              status: 'needs-attention',
              reason: refresh.attentionReason ?? 'unexpected-error',
            },
    };
  }

  const tabResult = await browser.queryAllWindowTabs();
  const results = new Map<ScheduleKind, ScheduleRecoveryResult>();

  for (const { kind, record } of records) {
    if (record === null) {
      results.set(kind, { kind, status: 'absent' });
      continue;
    }

    if (record.state === 'needs-attention') {
      results.set(kind, {
        kind,
        status: 'needs-attention',
        reason: record.attentionReason,
      });
      continue;
    }

    if (!tabResult.ok) {
      const attention = withAttention(record, tabResult.error.code, now);

      if (kind === 'rotation') {
        await store.setRotationSession(attention as RotationSession);
      } else {
        await store.setRefreshSchedule(attention as RefreshSchedule);
      }

      await cancelWithoutBlocking(scheduler, kind);
      results.set(kind, { kind, status: 'needs-attention', reason: tabResult.error.code });
      continue;
    }

    const decision = recoverRuntimeTargets(
      record.targets,
      record.sourceWindowId,
      tabResult.value,
      kind === 'rotation' ? 2 : 1,
    );

    if (decision.status === 'needs-attention') {
      const attention = withAttention(record, decision.reason, now);

      if (kind === 'rotation') {
        await store.setRotationSession(attention as RotationSession);
      } else {
        await store.setRefreshSchedule(attention as RefreshSchedule);
      }

      await cancelWithoutBlocking(scheduler, kind);
      results.set(kind, { kind, status: 'needs-attention', reason: decision.reason });
      continue;
    }

    const recovered = withRecoveredTargets(record, decision, now);

    if (kind === 'rotation') {
      await store.setRotationSession(recovered as RotationSession);
    } else {
      await store.setRefreshSchedule(recovered as RefreshSchedule);
    }

    if (recovered.state === 'paused') {
      await cancelWithoutBlocking(scheduler, kind);
      results.set(kind, {
        kind,
        status: 'recovered',
        method: decision.method,
        scheduled: false,
      });
      continue;
    }

    try {
      await scheduler.recover({
        kind,
        scheduleId: recovered.id,
        intervalMs: recovered.intervalMs,
        nextRunAt: recovered.nextRunAt,
      });
      results.set(kind, {
        kind,
        status: 'recovered',
        method: decision.method,
        scheduled: true,
      });
    } catch (error) {
      const reason = errorCodeFrom(error);
      const attention = withAttention(recovered, reason, now);

      if (kind === 'rotation') {
        await store.setRotationSession(attention as RotationSession);
      } else {
        await store.setRefreshSchedule(attention as RefreshSchedule);
      }

      await cancelWithoutBlocking(scheduler, kind);
      results.set(kind, { kind, status: 'needs-attention', reason });
    }
  }

  return {
    rotation: results.get('rotation')!,
    refresh: results.get('refresh')!,
  };
}

/** Creates an idempotent startup recovery boundary for one background application instance. */
export function createStartupRecovery(dependencies: StartupRecoveryDependencies): StartupRecovery {
  let recovery: Promise<StartupRecoveryResult> | undefined;

  return {
    recover() {
      recovery ??= performStartupRecovery(dependencies);
      return recovery;
    },
  };
}
