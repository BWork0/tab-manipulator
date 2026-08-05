import {
  reconcileTargets,
  type ReconcileTargetsInput,
  type TargetReconciliationOutcome,
} from './target-reconciler';
import type {
  ActionResultCounts,
  ActionResultSummary,
  TabDescriptor,
  TargetActionResult,
  TargetActionSkipped,
  Timestamp,
} from './types';

export type RefreshAction = Extract<
  ActionResultSummary['action'],
  'scheduled-refresh' | 'refresh-now'
>;

export type RefreshPlanEntry =
  | {
      status: 'ready';
      targetKey: TabDescriptor['key'];
      target: TabDescriptor;
    }
  | TargetActionSkipped;

export interface RefreshPlan {
  /** One entry for every captured descriptor, kept in captured order. */
  entries: readonly RefreshPlanEntry[];
}

export type ReloadRefreshTarget = (target: TabDescriptor) => Promise<void>;

/** Revalidates captured targets and produces at most one reload entry per live browser tab. */
export function createRefreshPlan(input: ReconcileTargetsInput): RefreshPlan {
  const reconciliation = reconcileTargets(input);

  return { entries: reconciliation.outcomes.map(toRefreshPlanEntry) };
}

/**
 * Attempts every ready entry independently. Browser errors are deliberately reduced to a stable
 * code so results can be persisted or shown without retaining error text or page content.
 */
export async function executeRefreshPlan(
  plan: RefreshPlan,
  reloadTarget: ReloadRefreshTarget,
): Promise<readonly TargetActionResult[]> {
  const results: TargetActionResult[] = [];

  for (const entry of plan.entries) {
    if (entry.status === 'skipped') {
      results.push(entry);
      continue;
    }

    try {
      await reloadTarget(entry.target);
      results.push({ status: 'success', targetKey: entry.targetKey });
    } catch {
      results.push({
        status: 'failure',
        targetKey: entry.targetKey,
        errorCode: 'tab-reload-failed',
      });
    }
  }

  return results;
}

/** Builds page-content-free counts and per-target outcomes for popup feedback and persistence. */
export function aggregateRefreshResults(
  action: RefreshAction,
  completedAt: Timestamp,
  targets: readonly TargetActionResult[],
): ActionResultSummary {
  const counts: ActionResultCounts = {
    succeeded: 0,
    skipped: 0,
    failed: 0,
    total: targets.length,
  };

  for (const target of targets) {
    if (target.status === 'success') {
      counts.succeeded += 1;
    } else if (target.status === 'skipped') {
      counts.skipped += 1;
    } else {
      counts.failed += 1;
    }
  }

  return { action, completedAt, targets: [...targets], counts };
}

function toRefreshPlanEntry(outcome: TargetReconciliationOutcome): RefreshPlanEntry {
  if (outcome.status === 'skipped') {
    return outcome;
  }

  return {
    status: 'ready',
    targetKey: outcome.targetKey,
    target: outcome.target,
  };
}
