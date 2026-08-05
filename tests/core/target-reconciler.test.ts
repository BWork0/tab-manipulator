import { parseRuleConfiguration, type RuleConfiguration } from '@/core/rule-engine';
import {
  evaluateTargetFilter,
  reconcileTargets,
  type CurrentTabSnapshot,
  type TargetFilterPolicy,
} from '@/core/target-reconciler';
import type { TabDescriptor } from '@/core/types';
import { describe, expect, it } from 'vitest';

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

function capturedTarget(overrides: Partial<TabDescriptor> = {}): TabDescriptor {
  return {
    key: 'target-1',
    tabId: 10,
    windowId: 3,
    url: 'https://example.test/dashboard',
    title: 'Captured title',
    index: 0,
    pinned: false,
    ...overrides,
  };
}

function currentTab(overrides: Partial<CurrentTabSnapshot> = {}): CurrentTabSnapshot {
  return {
    tabId: 10,
    windowId: 3,
    url: 'https://example.test/dashboard',
    title: 'Current title',
    index: 0,
    pinned: false,
    ...overrides,
  };
}

describe('target filtering', () => {
  it('combines URL eligibility, the pinned preference, and allow/block rules', () => {
    const filteredPolicy = policy({
      rules: rules('example.test', 'https://private.example.test/*'),
    });

    expect(
      evaluateTargetFilter({ url: 'chrome://settings/', pinned: false }, filteredPolicy),
    ).toEqual({
      eligible: false,
      reason: 'ineligible-url',
      detail: 'browser-internal-url',
    });
    expect(
      evaluateTargetFilter({ url: 'https://example.test/', pinned: true }, filteredPolicy),
    ).toEqual({ eligible: false, reason: 'pinned-tab-excluded' });
    expect(
      evaluateTargetFilter(
        { url: 'https://private.example.test/report', pinned: false },
        filteredPolicy,
      ),
    ).toEqual({ eligible: false, reason: 'filtered-out', detail: 'block-match' });
    expect(
      evaluateTargetFilter({ url: 'https://unlisted.test/', pinned: false }, filteredPolicy),
    ).toEqual({ eligible: false, reason: 'filtered-out', detail: 'no-allow-match' });
    expect(
      evaluateTargetFilter(
        { url: 'https://sub.example.test/report', pinned: false },
        filteredPolicy,
      ),
    ).toEqual({ eligible: true });
  });

  it('allows a pinned target when the shared preference includes it', () => {
    expect(
      evaluateTargetFilter(
        { url: 'https://example.test/', pinned: true },
        policy({ includePinned: true }),
      ),
    ).toEqual({ eligible: true });
  });
});

describe('target reconciliation', () => {
  it('updates current metadata and orders captured targets by current tab index', () => {
    const capturedTargets = [
      capturedTarget({ key: 'first', tabId: 10, index: 0 }),
      capturedTarget({ key: 'second', tabId: 11, url: 'https://second.test/', index: 1 }),
    ];
    const currentTabs = [
      currentTab({ tabId: 10, index: 7, title: 'Updated first' }),
      currentTab({
        tabId: 11,
        url: 'https://second.test/',
        index: 2,
        title: 'Updated second',
      }),
      currentTab({
        tabId: 12,
        url: 'https://new.test/',
        index: 0,
        title: 'Not captured',
      }),
    ];

    const result = reconcileTargets({
      capturedTargets,
      currentTabs,
      sourceWindowId: 3,
      policy: policy(),
    });

    expect(result.targets).toEqual([
      {
        key: 'second',
        tabId: 11,
        windowId: 3,
        url: 'https://second.test/',
        title: 'Updated second',
        index: 2,
        pinned: false,
      },
      {
        key: 'first',
        tabId: 10,
        windowId: 3,
        url: 'https://example.test/dashboard',
        title: 'Updated first',
        index: 7,
        pinned: false,
      },
    ]);
    expect(result.outcomes.map(({ status, targetKey }) => ({ status, targetKey }))).toEqual([
      { status: 'eligible', targetKey: 'first' },
      { status: 'eligible', targetKey: 'second' },
    ]);
  });

  it('reports closed, moved-window, mismatched-ID, and newly ineligible targets explicitly', () => {
    const capturedTargets = [
      capturedTarget({ key: 'closed', tabId: 10 }),
      capturedTarget({ key: 'moved', tabId: 11, url: 'https://moved.test/' }),
      capturedTarget({ key: 'reused-id', tabId: 12, url: 'https://old.test/' }),
      capturedTarget({ key: 'pinned', tabId: 13, url: 'https://pinned.test/' }),
      capturedTarget({ key: 'blocked', tabId: 14, url: 'https://blocked.test/' }),
      capturedTarget({ key: 'unsupported', tabId: 15, url: 'chrome://settings/' }),
    ];
    const currentTabs = [
      currentTab({ tabId: 11, windowId: 8, url: 'https://moved.test/' }),
      currentTab({ tabId: 12, url: 'https://new-owner.test/' }),
      currentTab({ tabId: 13, url: 'https://pinned.test/', pinned: true }),
      currentTab({ tabId: 14, url: 'https://blocked.test/' }),
      currentTab({ tabId: 15, url: 'chrome://settings/' }),
    ];

    const result = reconcileTargets({
      capturedTargets,
      currentTabs,
      sourceWindowId: 3,
      policy: policy({ rules: rules('', 'blocked.test') }),
    });

    expect(result.targets).toEqual([]);
    expect(result.outcomes).toEqual([
      { status: 'skipped', targetKey: 'closed', reason: 'missing-tab' },
      { status: 'skipped', targetKey: 'moved', reason: 'moved-to-another-window' },
      { status: 'skipped', targetKey: 'reused-id', reason: 'url-mismatch' },
      { status: 'skipped', targetKey: 'pinned', reason: 'pinned-tab-excluded' },
      { status: 'skipped', targetKey: 'blocked', reason: 'filtered-out' },
      { status: 'skipped', targetKey: 'unsupported', reason: 'ineligible-url' },
    ]);
  });

  it('accepts duplicate URLs only when each captured target retains its own matching ID', () => {
    const sharedUrl = 'https://example.test/shared';
    const result = reconcileTargets({
      capturedTargets: [
        capturedTarget({ key: 'one', tabId: 21, url: sharedUrl }),
        capturedTarget({ key: 'two', tabId: 22, url: sharedUrl }),
      ],
      currentTabs: [
        currentTab({ tabId: 21, url: sharedUrl, index: 4 }),
        currentTab({ tabId: 22, url: sharedUrl, index: 5 }),
      ],
      sourceWindowId: 3,
      policy: policy(),
    });

    expect(result.targets.map(({ key, tabId }) => ({ key, tabId }))).toEqual([
      { key: 'one', tabId: 21 },
      { key: 'two', tabId: 22 },
    ]);
  });

  it('does not reattach a captured URL under a different numeric ID', () => {
    const result = reconcileTargets({
      capturedTargets: [capturedTarget({ tabId: 30 })],
      currentTabs: [currentTab({ tabId: 31 })],
      sourceWindowId: 3,
      policy: policy(),
    });

    expect(result).toEqual({
      targets: [],
      outcomes: [{ status: 'skipped', targetKey: 'target-1', reason: 'missing-tab' }],
    });
  });

  it('handles absent descriptor and snapshot IDs or URLs without guessing identity', () => {
    const result = reconcileTargets({
      capturedTargets: [
        capturedTarget({ key: 'missing-captured-id', tabId: undefined }),
        capturedTarget({ key: 'missing-current-url', tabId: 40 }),
        capturedTarget({ key: 'missing-current-id', tabId: 41 }),
      ],
      currentTabs: [currentTab({ tabId: 40, url: undefined }), currentTab({ tabId: undefined })],
      sourceWindowId: 3,
      policy: policy(),
    });

    expect(result).toEqual({
      targets: [],
      outcomes: [
        { status: 'skipped', targetKey: 'missing-captured-id', reason: 'missing-tab' },
        { status: 'skipped', targetKey: 'missing-current-url', reason: 'url-mismatch' },
        { status: 'skipped', targetKey: 'missing-current-id', reason: 'missing-tab' },
      ],
    });
  });

  it('rejects a reused numeric ID whose current URL differs from the descriptor', () => {
    const result = reconcileTargets({
      capturedTargets: [capturedTarget({ tabId: 30, url: 'https://captured.test/' })],
      currentTabs: [currentTab({ tabId: 30, url: 'https://replacement.test/' })],
      sourceWindowId: 3,
      policy: policy(),
    });

    expect(result).toEqual({
      targets: [],
      outcomes: [{ status: 'skipped', targetKey: 'target-1', reason: 'url-mismatch' }],
    });
  });

  it('prevents duplicate captured IDs from producing duplicate actions', () => {
    const result = reconcileTargets({
      capturedTargets: [capturedTarget({ key: 'first' }), capturedTarget({ key: 'duplicate' })],
      currentTabs: [currentTab()],
      sourceWindowId: 3,
      policy: policy(),
    });

    expect(result.targets.map(({ key }) => key)).toEqual(['first']);
    expect(result.outcomes[1]).toEqual({
      status: 'skipped',
      targetKey: 'duplicate',
      reason: 'duplicate-target',
    });
  });
});
