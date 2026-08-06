import type { AutomationStatus, RefreshSchedule, RotationSession, Settings } from '@/core/types';
import type { AutomationSnapshot } from '@/messaging/protocol';
import type {
  BrowserApiAdapter,
  BrowserOperationError,
  BrowserOperationResult,
  ToolbarState,
} from '@/platform/browser-api';

export const TOOLBAR_BADGE_COLORS = Object.freeze({
  idle: '#000000',
  running: '#1D4ED8',
  paused: '#B45309',
  attention: '#B91C1C',
});

const STATUS_TITLES: Readonly<Record<AutomationStatus, string>> = Object.freeze({
  idle: 'Tab Manipulator: Idle',
  rotating: 'Tab Manipulator: Rotating',
  'rotation-paused': 'Tab Manipulator: Rotation paused',
  refreshing: 'Tab Manipulator: Refreshing',
  'rotating-and-refreshing': 'Tab Manipulator: Rotating + refreshing',
  'needs-attention': 'Tab Manipulator: Needs attention',
});

export interface StatusServiceStore {
  getRotationSession(): Promise<RotationSession | null>;
  getRefreshSchedule(): Promise<RefreshSchedule | null>;
}

export type StatusServiceBrowser = Pick<BrowserApiAdapter, 'capabilities' | 'updateToolbarState'>;

export interface ToolbarUpdateFailureLog {
  level: 'warning';
  event: 'toolbar-update-failed';
  status: AutomationStatus;
  toolbarState: ToolbarState;
  error: BrowserOperationError;
}

export interface StatusServiceLogger {
  warn(entry: ToolbarUpdateFailureLog): void;
}

export type ToolbarUpdateReport =
  | { ok: true; state: ToolbarState }
  | { ok: false; state: ToolbarState; error: BrowserOperationError };

export interface StatusSyncResult {
  snapshot: AutomationSnapshot;
  toolbarUpdate: ToolbarUpdateReport;
}

export interface StatusServiceDependencies {
  browser: StatusServiceBrowser;
  store: StatusServiceStore;
  readSettings(): Promise<Settings>;
  logger?: StatusServiceLogger;
}

export interface StatusService {
  getSnapshot(): Promise<AutomationSnapshot>;
  syncToolbar(snapshot?: AutomationSnapshot): Promise<StatusSyncResult>;
}

const NOOP_LOGGER: StatusServiceLogger = { warn: () => undefined };

function isAttention(
  record: RotationSession | RefreshSchedule | null,
): record is (RotationSession | RefreshSchedule) & { state: 'needs-attention' } {
  return record?.state === 'needs-attention';
}

function isRunning(
  record: RotationSession | RefreshSchedule | null,
): record is (RotationSession | RefreshSchedule) & { state: 'running' } {
  return record?.state === 'running';
}

function isPaused(
  record: RotationSession | RefreshSchedule | null,
): record is (RotationSession | RefreshSchedule) & { state: 'paused' } {
  return record?.state === 'paused';
}

/** Reduces persisted schedule states to the six status labels defined by the popup contract. */
export function deriveAutomationStatus(
  rotation: RotationSession | null,
  refresh: RefreshSchedule | null,
): AutomationStatus {
  if (isAttention(rotation) || isAttention(refresh)) {
    return 'needs-attention';
  }

  if (isRunning(rotation) && isRunning(refresh)) {
    return 'rotating-and-refreshing';
  }

  if (isRunning(rotation)) {
    return 'rotating';
  }

  if (isRunning(refresh)) {
    return 'refreshing';
  }

  if (isPaused(rotation) || isPaused(refresh)) {
    return 'rotation-paused';
  }

  return 'idle';
}

function nextRunAt(
  rotation: RotationSession | null,
  refresh: RefreshSchedule | null,
): number | undefined {
  const dueTimes = [rotation, refresh].filter(isRunning).map((record) => record.nextRunAt);

  return dueTimes.length === 0 ? undefined : Math.min(...dueTimes);
}

function latestResult(
  rotation: RotationSession | null,
  refresh: RefreshSchedule | null,
): AutomationSnapshot['lastResult'] {
  const rotationResult = rotation?.lastResult;
  const refreshResult = refresh?.lastResult;

  if (rotationResult === undefined) {
    return refreshResult;
  }

  if (refreshResult === undefined) {
    return rotationResult;
  }

  // Equal completion timestamps prefer rotation so the tie is stable across reads.
  return refreshResult.completedAt > rotationResult.completedAt ? refreshResult : rotationResult;
}

function failureTitle(title: string, failed: number): string {
  const targetLabel = failed === 1 ? 'target' : 'targets';
  return `${title}. Last action failed for ${failed} ${targetLabel}`;
}

/** Maps a popup snapshot to the cross-browser toolbar adapter's complete state. */
export function toolbarStateFor(snapshot: AutomationSnapshot): ToolbarState {
  const failed = snapshot.lastResult?.counts.failed ?? 0;

  if (snapshot.status === 'needs-attention') {
    return {
      text: '!',
      backgroundColor: TOOLBAR_BADGE_COLORS.attention,
      title: STATUS_TITLES['needs-attention'],
    };
  }

  if (failed > 0) {
    return {
      text: '!',
      backgroundColor: TOOLBAR_BADGE_COLORS.attention,
      title: failureTitle(STATUS_TITLES[snapshot.status], failed),
    };
  }

  if (snapshot.status === 'idle') {
    return {
      text: '',
      backgroundColor: TOOLBAR_BADGE_COLORS.idle,
      title: STATUS_TITLES.idle,
    };
  }

  if (snapshot.status === 'rotation-paused') {
    return {
      text: 'II',
      backgroundColor: TOOLBAR_BADGE_COLORS.paused,
      title: STATUS_TITLES['rotation-paused'],
    };
  }

  return {
    text: 'ON',
    backgroundColor: TOOLBAR_BADGE_COLORS.running,
    title: STATUS_TITLES[snapshot.status],
  };
}

function unexpectedToolbarFailure(): BrowserOperationResult<void> {
  return {
    ok: false,
    error: { code: 'browser-operation-failed', operation: 'update-toolbar-state' },
  };
}

/** Builds popup snapshots from persisted state and synchronizes the toolbar without blocking actions. */
export function createStatusService({
  browser,
  store,
  readSettings,
  logger = NOOP_LOGGER,
}: StatusServiceDependencies): StatusService {
  async function getSnapshot(): Promise<AutomationSnapshot> {
    const [settings, rotation, refresh] = await Promise.all([
      readSettings(),
      store.getRotationSession(),
      store.getRefreshSchedule(),
    ]);
    const status = deriveAutomationStatus(rotation, refresh);
    const dueAt = nextRunAt(rotation, refresh);
    const result = latestResult(rotation, refresh);

    return Object.freeze({
      status,
      settings,
      rotation,
      refresh,
      capabilities: browser.capabilities,
      ...(dueAt === undefined ? {} : { nextRunAt: dueAt }),
      ...(result === undefined ? {} : { lastResult: result }),
    });
  }

  function reportFailure(
    snapshot: AutomationSnapshot,
    state: ToolbarState,
    error: BrowserOperationError,
  ): ToolbarUpdateReport {
    try {
      logger.warn({
        level: 'warning',
        event: 'toolbar-update-failed',
        status: snapshot.status,
        toolbarState: state,
        error,
      });
    } catch {
      // Diagnostic observers must not turn a toolbar failure into an automation failure.
    }

    return { ok: false, state, error };
  }

  async function syncToolbar(snapshot?: AutomationSnapshot): Promise<StatusSyncResult> {
    const currentSnapshot = snapshot ?? (await getSnapshot());
    const state = toolbarStateFor(currentSnapshot);
    let update: BrowserOperationResult<void>;

    try {
      update = await browser.updateToolbarState(state);
    } catch {
      update = unexpectedToolbarFailure();
    }

    return {
      snapshot: currentSnapshot,
      toolbarUpdate: update.ok
        ? { ok: true, state }
        : reportFailure(currentSnapshot, state, update.error),
    };
  }

  return { getSnapshot, syncToolbar };
}
