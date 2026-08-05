import {
  DEFAULT_SETTINGS,
  MIN_REFRESH_INTERVAL_MS,
  MIN_ROTATION_INTERVAL_MS,
} from '@/core/defaults';
import {
  RUNTIME_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  type ActionResultSummary,
  type RotationSession,
  type Settings,
} from '@/core/types';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('domain model', () => {
  it('exports the documented settings defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      schemaVersion: 1,
      rotationIntervalMs: 10_000,
      rotationDirection: 'forward',
      refreshIntervalMs: 300_000,
      includePinned: false,
      allowlist: [],
      blocklist: [],
    });
    expect(MIN_ROTATION_INTERVAL_MS).toBe(10_000);
    expect(MIN_REFRESH_INTERVAL_MS).toBe(30_000);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });

  it('uses explicit schema versions for settings and runtime records', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
    expect(RUNTIME_SCHEMA_VERSION).toBe(1);
    expectTypeOf(DEFAULT_SETTINGS).toMatchTypeOf<Settings>();
  });

  it('models safe aggregate and persisted running-state results', () => {
    const lastResult: ActionResultSummary = {
      action: 'rotation',
      completedAt: 20_000,
      targets: [
        { targetKey: 'target-1', status: 'success' },
        { targetKey: 'target-2', status: 'skipped', reason: 'missing-tab' },
        {
          targetKey: 'target-3',
          status: 'failure',
          errorCode: 'tab-activation-failed',
        },
      ],
      counts: { succeeded: 1, skipped: 1, failed: 1, total: 3 },
    };
    const session: RotationSession = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id: 'rotation-1',
      state: 'running',
      targets: [
        {
          key: 'target-1',
          tabId: 4,
          windowId: 2,
          url: 'https://example.test/',
          title: 'Example',
          index: 0,
          pinned: false,
        },
      ],
      sourceWindowId: 2,
      intervalMs: 10_000,
      direction: 'forward',
      cursor: 0,
      createdAt: 10_000,
      updatedAt: 20_000,
      lastRunAt: 20_000,
      nextRunAt: 30_000,
      lastResult,
    };

    expect(session.lastResult?.counts).toEqual({
      succeeded: 1,
      skipped: 1,
      failed: 1,
      total: 3,
    });
    expectTypeOf(session).toMatchTypeOf<RotationSession>();
  });
});
