import { evaluateUrlRules, type RuleConfiguration, type RuleDecision } from './rule-engine';
import { evaluateTabEligibility, type TabIneligibilityReason } from './tab-eligibility';
import type { TabDescriptor, TargetSkipReason } from './types';

export interface TargetFilterPolicy {
  includePinned: boolean;
  rules: RuleConfiguration;
}

export type TargetFilterDecision =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'ineligible-url';
      detail: TabIneligibilityReason;
    }
  | { eligible: false; reason: 'pinned-tab-excluded' }
  | {
      eligible: false;
      reason: 'filtered-out';
      detail: Extract<RuleDecision, { allowed: false }>['reason'];
    };

export interface CurrentTabSnapshot {
  tabId?: number;
  windowId: number;
  url?: string;
  title?: string;
  index: number;
  pinned: boolean;
}

export interface ReconcileTargetsInput {
  capturedTargets: readonly TabDescriptor[];
  currentTabs: readonly CurrentTabSnapshot[];
  sourceWindowId: number;
  policy: TargetFilterPolicy;
}

export type TargetReconciliationOutcome =
  | {
      status: 'eligible';
      targetKey: TabDescriptor['key'];
      target: TabDescriptor;
    }
  | {
      status: 'skipped';
      targetKey: TabDescriptor['key'];
      reason: TargetSkipReason;
    };

export interface TargetReconciliationResult {
  /** Eligible captured targets in their current browser index order. */
  targets: readonly TabDescriptor[];
  /** One outcome for every captured descriptor, kept in captured order. */
  outcomes: readonly TargetReconciliationOutcome[];
}

/** Applies the complete shared eligibility policy without calling browser APIs. */
export function evaluateTargetFilter(
  target: Pick<CurrentTabSnapshot, 'url' | 'pinned'>,
  policy: TargetFilterPolicy,
): TargetFilterDecision {
  const eligibility = evaluateTabEligibility(target.url);

  if (!eligibility.eligible) {
    return {
      eligible: false,
      reason: 'ineligible-url',
      detail: eligibility.reason,
    };
  }

  if (target.pinned && !policy.includePinned) {
    return { eligible: false, reason: 'pinned-tab-excluded' };
  }

  const ruleDecision = evaluateUrlRules(target.url, policy.rules);

  if (!ruleDecision.allowed) {
    return {
      eligible: false,
      reason: 'filtered-out',
      detail: ruleDecision.reason,
    };
  }

  return { eligible: true };
}

/**
 * Revalidates captured targets against a current browser snapshot. Historical numeric IDs are
 * accepted only when their current URL still exactly matches the captured descriptor.
 */
export function reconcileTargets({
  capturedTargets,
  currentTabs,
  sourceWindowId,
  policy,
}: ReconcileTargetsInput): TargetReconciliationResult {
  const currentTabsById = new Map<number, CurrentTabSnapshot>();

  for (const currentTab of currentTabs) {
    if (currentTab.tabId !== undefined && !currentTabsById.has(currentTab.tabId)) {
      currentTabsById.set(currentTab.tabId, currentTab);
    }
  }

  const outcomes: TargetReconciliationOutcome[] = [];
  const eligibleTargets: Array<{ capturedOrder: number; target: TabDescriptor }> = [];
  const resolvedTabIds = new Set<number>();

  for (const [capturedOrder, capturedTarget] of capturedTargets.entries()) {
    if (capturedTarget.tabId === undefined) {
      outcomes.push({
        status: 'skipped',
        targetKey: capturedTarget.key,
        reason: 'missing-tab',
      });
      continue;
    }

    const currentTab = currentTabsById.get(capturedTarget.tabId);

    if (!currentTab) {
      outcomes.push({
        status: 'skipped',
        targetKey: capturedTarget.key,
        reason: 'missing-tab',
      });
      continue;
    }

    if (currentTab.url !== capturedTarget.url) {
      outcomes.push({
        status: 'skipped',
        targetKey: capturedTarget.key,
        reason: 'url-mismatch',
      });
      continue;
    }

    if (currentTab.windowId !== sourceWindowId) {
      outcomes.push({
        status: 'skipped',
        targetKey: capturedTarget.key,
        reason: 'moved-to-another-window',
      });
      continue;
    }

    if (resolvedTabIds.has(capturedTarget.tabId)) {
      outcomes.push({
        status: 'skipped',
        targetKey: capturedTarget.key,
        reason: 'duplicate-target',
      });
      continue;
    }

    resolvedTabIds.add(capturedTarget.tabId);

    const filterDecision = evaluateTargetFilter(currentTab, policy);

    if (!filterDecision.eligible) {
      outcomes.push({
        status: 'skipped',
        targetKey: capturedTarget.key,
        reason: filterDecision.reason,
      });
      continue;
    }

    const target: TabDescriptor = {
      key: capturedTarget.key,
      tabId: capturedTarget.tabId,
      windowId: currentTab.windowId,
      url: currentTab.url,
      ...(currentTab.title === undefined ? {} : { title: currentTab.title }),
      index: currentTab.index,
      pinned: currentTab.pinned,
    };

    eligibleTargets.push({ capturedOrder, target });
    outcomes.push({ status: 'eligible', targetKey: capturedTarget.key, target });
  }

  eligibleTargets.sort(
    (left, right) =>
      left.target.index - right.target.index || left.capturedOrder - right.capturedOrder,
  );

  return {
    targets: eligibleTargets.map(({ target }) => target),
    outcomes,
  };
}
