import { DEFAULT_SETTINGS } from '@/core/defaults';
import type {
  ActionResultSummary,
  AutomationStatus,
  RefreshSchedule,
  RotationSession,
  Timestamp,
} from '@/core/types';
import type { AutomationSnapshot } from '@/messaging/protocol';
import {
  commandErrorMessage,
  formatNextRun,
  popupSnapshotModel,
} from '@/entrypoints/popup/status-view';
import { describe, expect, it } from 'vitest';

const NOW = 1_800_000_000_000 as Timestamp;

const AVAILABLE_CAPABILITIES: AutomationSnapshot['capabilities'] = {
  currentWindowTabQuery: 'available',
  allWindowTabQuery: 'available',
  tabActivation: 'available',
  tabReload: 'available',
  toolbarState: 'available',
  optionsPage: 'available',
};

function rotation(state: 'running' | 'paused' | 'needs-attention'): RotationSession {
  const base = {
    schemaVersion: 1 as const,
    id: 'rotation-1',
    targets: [],
    sourceWindowId: 1,
    intervalMs: 30_000,
    direction: 'forward' as const,
    cursor: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };

  if (state === 'running') {
    return { ...base, state, nextRunAt: (NOW + 30_000) as Timestamp };
  }

  if (state === 'paused') {
    return { ...base, state };
  }

  return { ...base, state, attentionReason: 'ambiguous-recovery' };
}

function refresh(): RefreshSchedule {
  return {
    schemaVersion: 1,
    id: 'refresh-1',
    state: 'running',
    targets: [],
    sourceWindowId: 1,
    intervalMs: 30_000,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: (NOW + 30_000) as Timestamp,
  };
}

function snapshot(status: AutomationStatus): AutomationSnapshot {
  const rotationByStatus =
    status === 'rotating' || status === 'rotating-and-refreshing'
      ? rotation('running')
      : status === 'rotation-paused'
        ? rotation('paused')
        : status === 'needs-attention'
          ? rotation('needs-attention')
          : null;
  const refreshByStatus =
    status === 'refreshing' || status === 'rotating-and-refreshing' ? refresh() : null;

  return {
    status,
    settings: DEFAULT_SETTINGS,
    rotation: rotationByStatus,
    refresh: refreshByStatus,
    capabilities: AVAILABLE_CAPABILITIES,
    ...(status === 'rotating' || status === 'refreshing' || status === 'rotating-and-refreshing'
      ? { nextRunAt: (NOW + 30_000) as Timestamp }
      : {}),
  };
}

describe('popup status view', () => {
  it.each([
    ['idle', 'Idle', 'neutral'],
    ['rotating', 'Rotating', 'running'],
    ['rotation-paused', 'Rotation paused', 'paused'],
    ['refreshing', 'Refreshing', 'running'],
    ['rotating-and-refreshing', 'Rotating + refreshing', 'running'],
    ['needs-attention', 'Needs attention', 'attention'],
  ] satisfies readonly [AutomationStatus, string, string][])(
    'renders %s with text and a matching tone',
    (status, label, tone) => {
      expect(popupSnapshotModel(snapshot(status)).status).toMatchObject({ label, tone });
    },
  );

  it('identifies the next due action, including simultaneous schedules', () => {
    expect(popupSnapshotModel(snapshot('rotating')).nextAction).toEqual({
      label: 'Rotation',
      at: NOW + 30_000,
    });
    expect(popupSnapshotModel(snapshot('refreshing')).nextAction).toEqual({
      label: 'Refresh',
      at: NOW + 30_000,
    });
    expect(popupSnapshotModel(snapshot('rotating-and-refreshing')).nextAction).toEqual({
      label: 'Rotation and refresh',
      at: NOW + 30_000,
    });
  });

  it('summarizes recent results without relying on color', () => {
    const lastResult: ActionResultSummary = {
      action: 'scheduled-refresh',
      completedAt: NOW,
      targets: [],
      counts: { succeeded: 2, skipped: 1, failed: 1, total: 4 },
    };

    expect(popupSnapshotModel({ ...snapshot('refreshing'), lastResult }).lastResult).toEqual({
      text: 'Last action: 2 succeeded, 1 skipped, 1 failed.',
      tone: 'attention',
    });
  });

  it('names unavailable capabilities in user-readable language', () => {
    const model = popupSnapshotModel({
      ...snapshot('idle'),
      capabilities: {
        ...AVAILABLE_CAPABILITIES,
        tabActivation: 'unavailable',
        tabReload: 'unavailable',
      },
    });

    expect(model.unavailableFeatures).toEqual(['tab rotation', 'tab refresh']);
  });

  it('provides readable command errors and safe due-time fallbacks', () => {
    expect(commandErrorMessage('ambiguous-recovery')).toContain('could not be matched safely');
    expect(formatNextRun(NOW, NOW)).toBe('Due now');
    expect(formatNextRun(Number.NaN, NOW)).toBe('Time unavailable');
  });
});
