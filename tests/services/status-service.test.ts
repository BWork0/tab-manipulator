import { DEFAULT_SETTINGS } from '@/core/defaults';
import {
  RUNTIME_SCHEMA_VERSION,
  type ActionResultSummary,
  type RefreshSchedule,
  type RotationSession,
  type RunState,
} from '@/core/types';
import type { BrowserCapabilities } from '@/platform/capabilities';
import type { BrowserOperationResult } from '@/platform/browser-api';
import {
  TOOLBAR_BADGE_COLORS,
  createStatusService,
  type StatusServiceBrowser,
  type StatusServiceLogger,
  type StatusServiceStore,
} from '@/services/status-service';
import { describe, expect, it, vi } from 'vitest';

const CAPABILITIES: BrowserCapabilities = Object.freeze({
  currentWindowTabQuery: 'available',
  allWindowTabQuery: 'available',
  tabActivation: 'available',
  tabReload: 'available',
  toolbarState: 'available',
  optionsPage: 'available',
});

function actionResult(
  completedAt: number,
  failed = 0,
  action: ActionResultSummary['action'] = 'rotation',
): ActionResultSummary {
  return {
    action,
    completedAt,
    targets: Array.from({ length: failed }, (_, index) => ({
      status: 'failure' as const,
      targetKey: `target-${index}`,
      errorCode: 'browser-operation-failed' as const,
    })),
    counts: { succeeded: 0, skipped: 0, failed, total: failed },
  };
}

function runtimeState(state: RunState, nextRunAt: number) {
  if (state === 'running') {
    return { state, nextRunAt } as const;
  }

  if (state === 'needs-attention') {
    return { state, attentionReason: 'ambiguous-recovery' } as const;
  }

  return { state } as const;
}

function rotation(
  state: RunState,
  options: { nextRunAt?: number; lastResult?: ActionResultSummary } = {},
): RotationSession {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: 'rotation-1',
    targets: [],
    sourceWindowId: 1,
    intervalMs: 10_000,
    direction: 'forward',
    cursor: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...runtimeState(state, options.nextRunAt ?? 12_000),
    ...(options.lastResult === undefined ? {} : { lastResult: options.lastResult }),
  };
}

function refresh(
  state: RunState,
  options: { nextRunAt?: number; lastResult?: ActionResultSummary } = {},
): RefreshSchedule {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: 'refresh-1',
    targets: [],
    sourceWindowId: 1,
    intervalMs: 30_000,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...runtimeState(state, options.nextRunAt ?? 32_000),
    ...(options.lastResult === undefined ? {} : { lastResult: options.lastResult }),
  };
}

function success<T>(value: T): BrowserOperationResult<T> {
  return { ok: true, value };
}

function fixture(
  initial: {
    rotation?: RotationSession | null;
    refresh?: RefreshSchedule | null;
    updateResult?: BrowserOperationResult<void>;
  } = {},
) {
  let storedRotation = initial.rotation ?? null;
  let storedRefresh = initial.refresh ?? null;
  const updateToolbarState = vi.fn(async () => initial.updateResult ?? success(undefined));
  const browser: StatusServiceBrowser = { capabilities: CAPABILITIES, updateToolbarState };
  const store: StatusServiceStore = {
    getRotationSession: vi.fn(async () => storedRotation),
    getRefreshSchedule: vi.fn(async () => storedRefresh),
  };
  const logger: StatusServiceLogger = { warn: vi.fn() };
  const service = createStatusService({
    browser,
    store,
    readSettings: vi.fn(async () => DEFAULT_SETTINGS),
    logger,
  });

  return {
    logger,
    service,
    updateToolbarState,
    setRotation(value: RotationSession | null) {
      storedRotation = value;
    },
    setRefresh(value: RefreshSchedule | null) {
      storedRefresh = value;
    },
  };
}

type StateFixture = 'absent' | RunState;

function rotationFor(state: StateFixture): RotationSession | null {
  return state === 'absent' ? null : rotation(state);
}

function refreshFor(state: StateFixture): RefreshSchedule | null {
  return state === 'absent' ? null : refresh(state);
}

describe('automation snapshot and badge service', () => {
  it.each<[StateFixture, StateFixture, string, string, string, string]>([
    ['absent', 'absent', 'idle', '', TOOLBAR_BADGE_COLORS.idle, 'Tab Manipulator: Idle'],
    [
      'running',
      'absent',
      'rotating',
      'ON',
      TOOLBAR_BADGE_COLORS.running,
      'Tab Manipulator: Rotating',
    ],
    [
      'paused',
      'absent',
      'rotation-paused',
      'II',
      TOOLBAR_BADGE_COLORS.paused,
      'Tab Manipulator: Rotation paused',
    ],
    [
      'needs-attention',
      'absent',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
    [
      'absent',
      'running',
      'refreshing',
      'ON',
      TOOLBAR_BADGE_COLORS.running,
      'Tab Manipulator: Refreshing',
    ],
    [
      'absent',
      'paused',
      'rotation-paused',
      'II',
      TOOLBAR_BADGE_COLORS.paused,
      'Tab Manipulator: Rotation paused',
    ],
    [
      'absent',
      'needs-attention',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
    [
      'running',
      'running',
      'rotating-and-refreshing',
      'ON',
      TOOLBAR_BADGE_COLORS.running,
      'Tab Manipulator: Rotating + refreshing',
    ],
    [
      'running',
      'paused',
      'rotating',
      'ON',
      TOOLBAR_BADGE_COLORS.running,
      'Tab Manipulator: Rotating',
    ],
    [
      'paused',
      'running',
      'refreshing',
      'ON',
      TOOLBAR_BADGE_COLORS.running,
      'Tab Manipulator: Refreshing',
    ],
    [
      'paused',
      'paused',
      'rotation-paused',
      'II',
      TOOLBAR_BADGE_COLORS.paused,
      'Tab Manipulator: Rotation paused',
    ],
    [
      'needs-attention',
      'running',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
    [
      'running',
      'needs-attention',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
    [
      'needs-attention',
      'paused',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
    [
      'paused',
      'needs-attention',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
    [
      'needs-attention',
      'needs-attention',
      'needs-attention',
      '!',
      TOOLBAR_BADGE_COLORS.attention,
      'Tab Manipulator: Needs attention',
    ],
  ])(
    'maps rotation %s and refresh %s deterministically',
    async (rotationState, refreshState, status, text, backgroundColor, title) => {
      const test = fixture({
        rotation: rotationFor(rotationState),
        refresh: refreshFor(refreshState),
      });

      const result = await test.service.syncToolbar();

      expect(result.snapshot.status).toBe(status);
      expect(result.toolbarUpdate).toEqual({
        ok: true,
        state: { text, backgroundColor, title },
      });
      expect(test.updateToolbarState).toHaveBeenCalledWith({ text, backgroundColor, title });
    },
  );

  it('combines settings, capabilities, earliest due time, and the newest persisted result', async () => {
    const older = actionResult(4_000);
    const newer = actionResult(5_000, 0, 'scheduled-refresh');
    const test = fixture({
      rotation: rotation('running', { nextRunAt: 9_000, lastResult: older }),
      refresh: refresh('running', { nextRunAt: 8_000, lastResult: newer }),
    });

    const snapshot = await test.service.getSnapshot();

    expect(snapshot).toMatchObject({
      status: 'rotating-and-refreshing',
      settings: DEFAULT_SETTINGS,
      capabilities: CAPABILITIES,
      nextRunAt: 8_000,
      lastResult: newer,
    });
  });

  it('uses the newest overall result when deciding whether the badge reports a failure', async () => {
    const test = fixture({
      rotation: rotation('running', { lastResult: actionResult(4_000, 1) }),
      refresh: refresh('running', {
        lastResult: actionResult(5_000, 0, 'scheduled-refresh'),
      }),
    });

    await expect(test.service.syncToolbar()).resolves.toMatchObject({
      snapshot: { status: 'rotating-and-refreshing', lastResult: { completedAt: 5_000 } },
      toolbarUpdate: { ok: true, state: { text: 'ON' } },
    });
  });

  it('shows a failed most-recent action as attention without changing the popup run status', async () => {
    const test = fixture({
      rotation: rotation('running', { lastResult: actionResult(5_000, 2) }),
    });

    await expect(test.service.syncToolbar()).resolves.toMatchObject({
      snapshot: { status: 'rotating' },
      toolbarUpdate: {
        ok: true,
        state: {
          text: '!',
          backgroundColor: TOOLBAR_BADGE_COLORS.attention,
          title: 'Tab Manipulator: Rotating. Last action failed for 2 targets',
        },
      },
    });
  });

  it('clears the badge after the final persisted schedule is removed', async () => {
    const test = fixture({ rotation: rotation('running') });

    await test.service.syncToolbar();
    test.setRotation(null);
    await test.service.syncToolbar();

    expect(test.updateToolbarState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: 'ON' }),
    );
    expect(test.updateToolbarState).toHaveBeenNthCalledWith(2, {
      text: '',
      backgroundColor: TOOLBAR_BADGE_COLORS.idle,
      title: 'Tab Manipulator: Idle',
    });
  });

  it('returns and logs badge failures without rejecting the successful automation snapshot', async () => {
    const updateFailure: BrowserOperationResult<void> = {
      ok: false,
      error: { code: 'browser-operation-failed', operation: 'update-toolbar-state' },
    };
    const test = fixture({ rotation: rotation('running'), updateResult: updateFailure });

    const result = await test.service.syncToolbar();

    expect(result).toMatchObject({
      snapshot: { status: 'rotating', rotation: { id: 'rotation-1' } },
      toolbarUpdate: {
        ok: false,
        state: { text: 'ON' },
        error: updateFailure.error,
      },
    });
    expect(test.logger.warn).toHaveBeenCalledWith({
      level: 'warning',
      event: 'toolbar-update-failed',
      status: 'rotating',
      toolbarState: {
        text: 'ON',
        backgroundColor: TOOLBAR_BADGE_COLORS.running,
        title: 'Tab Manipulator: Rotating',
      },
      error: updateFailure.error,
    });
  });

  it('converts an unexpected toolbar rejection and a failing logger to a non-fatal result', async () => {
    const test = fixture({ refresh: refresh('running') });
    test.updateToolbarState.mockRejectedValueOnce(new Error('browser detail'));
    vi.mocked(test.logger.warn).mockImplementationOnce(() => {
      throw new Error('observer detail');
    });

    await expect(test.service.syncToolbar()).resolves.toMatchObject({
      snapshot: { status: 'refreshing' },
      toolbarUpdate: {
        ok: false,
        error: { code: 'browser-operation-failed', operation: 'update-toolbar-state' },
      },
    });
  });
});
