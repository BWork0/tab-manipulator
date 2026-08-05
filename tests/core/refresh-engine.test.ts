import {
  aggregateRefreshResults,
  createRefreshPlan,
  executeRefreshPlan,
  type RefreshPlan,
} from '@/core/refresh-engine';
import { parseRuleConfiguration, type RuleConfiguration } from '@/core/rule-engine';
import type { CurrentTabSnapshot, TargetFilterPolicy } from '@/core/target-reconciler';
import type { TabDescriptor, TargetActionResult } from '@/core/types';
import { describe, expect, it, vi } from 'vitest';

function rules(allowlist = '', blocklist = ''): RuleConfiguration {
  const result = parseRuleConfiguration(allowlist, blocklist);

  if (!result.valid) {
    throw new Error(`Expected valid rules: ${JSON.stringify(result.errors)}`);
  }

  return result.configuration;
}

function policy(overrides: Partial<TargetFilterPolicy> = {}): TargetFilterPolicy {
  return {
    includePinned: false,
    rules: rules(),
    ...overrides,
  };
}

function capturedTarget(
  key: string,
  tabId: number,
  overrides: Partial<TabDescriptor> = {},
): TabDescriptor {
  return {
    key,
    tabId,
    windowId: 3,
    url: `https://${key}.test/`,
    index: tabId,
    pinned: false,
    ...overrides,
  };
}

function currentTab(
  key: string,
  tabId: number,
  overrides: Partial<CurrentTabSnapshot> = {},
): CurrentTabSnapshot {
  return {
    tabId,
    windowId: 3,
    url: `https://${key}.test/`,
    index: tabId,
    pinned: false,
    ...overrides,
  };
}

describe('refresh planning', () => {
  it('plans each eligible live tab once and preserves independent skip outcomes', () => {
    const capturedTargets = [
      capturedTarget('first', 10),
      capturedTarget('duplicate-id', 10, { url: 'https://first.test/' }),
      capturedTarget('blocked', 11),
      capturedTarget('closed', 12),
      capturedTarget('last', 13),
    ];

    const plan = createRefreshPlan({
      capturedTargets,
      currentTabs: [
        currentTab('first', 10, { index: 4 }),
        currentTab('blocked', 11, { index: 2 }),
        currentTab('last', 13, { index: 1 }),
        currentTab('not-captured', 14, { index: 0 }),
      ],
      sourceWindowId: 3,
      policy: policy({ rules: rules('', 'blocked.test') }),
    });

    expect(
      plan.entries.map((entry) =>
        entry.status === 'ready'
          ? { status: entry.status, targetKey: entry.targetKey, tabId: entry.target.tabId }
          : entry,
      ),
    ).toEqual([
      { status: 'ready', targetKey: 'first', tabId: 10 },
      { status: 'skipped', targetKey: 'duplicate-id', reason: 'duplicate-target' },
      { status: 'skipped', targetKey: 'blocked', reason: 'filtered-out' },
      { status: 'skipped', targetKey: 'closed', reason: 'missing-tab' },
      { status: 'ready', targetKey: 'last', tabId: 13 },
    ]);
    expect(
      plan.entries.filter((entry) => entry.status === 'ready').map(({ target }) => target.tabId),
    ).toEqual([10, 13]);
  });
});

describe('refresh execution', () => {
  it('attempts the remaining targets after an individual reload fails', async () => {
    const first = capturedTarget('first', 10);
    const second = capturedTarget('second', 11);
    const third = capturedTarget('third', 12);
    const plan: RefreshPlan = {
      entries: [
        { status: 'ready', targetKey: first.key, target: first },
        { status: 'skipped', targetKey: 'closed', reason: 'missing-tab' },
        { status: 'ready', targetKey: second.key, target: second },
        { status: 'ready', targetKey: third.key, target: third },
      ],
    };
    const reloadTarget = vi.fn(async (target: TabDescriptor) => {
      if (target.key === 'second') {
        throw new Error('Sensitive browser error text.');
      }
    });

    const results = await executeRefreshPlan(plan, reloadTarget);

    expect(reloadTarget.mock.calls.map(([target]) => target.key)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(results).toEqual([
      { status: 'success', targetKey: 'first' },
      { status: 'skipped', targetKey: 'closed', reason: 'missing-tab' },
      { status: 'failure', targetKey: 'second', errorCode: 'tab-reload-failed' },
      { status: 'success', targetKey: 'third' },
    ]);
    expect(JSON.stringify(results)).not.toContain('Sensitive browser error text.');
    expect(JSON.stringify(results)).not.toContain('https://');
  });
});

describe('refresh result aggregation', () => {
  it('produces accurate popup counts without adding page content', () => {
    const targets: readonly TargetActionResult[] = [
      { status: 'success', targetKey: 'first' },
      { status: 'skipped', targetKey: 'closed', reason: 'missing-tab' },
      { status: 'failure', targetKey: 'second', errorCode: 'tab-reload-failed' },
      { status: 'success', targetKey: 'third' },
    ];

    const summary = aggregateRefreshResults('refresh-now', 42_000, targets);

    expect(summary).toEqual({
      action: 'refresh-now',
      completedAt: 42_000,
      targets,
      counts: { succeeded: 2, skipped: 1, failed: 1, total: 4 },
    });
    expect(summary.targets).not.toBe(targets);
    expect(JSON.stringify(summary)).not.toContain('url');
    expect(JSON.stringify(summary)).not.toContain('title');
  });

  it('returns zero counts for an empty scheduled refresh pass', () => {
    expect(aggregateRefreshResults('scheduled-refresh', 50_000, [])).toEqual({
      action: 'scheduled-refresh',
      completedAt: 50_000,
      targets: [],
      counts: { succeeded: 0, skipped: 0, failed: 0, total: 0 },
    });
  });
});
