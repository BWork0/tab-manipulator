export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const RUNTIME_SCHEMA_VERSION = 1 as const;

export type SettingsSchemaVersion = typeof SETTINGS_SCHEMA_VERSION;
export type RuntimeSchemaVersion = typeof RUNTIME_SCHEMA_VERSION;

export type Timestamp = number;
export type Milliseconds = number;

export type RotationDirection = 'forward' | 'backward' | 'random';
export type RunState = 'running' | 'paused' | 'needs-attention';
export type AutomationStatus =
  | 'idle'
  | 'rotating'
  | 'rotation-paused'
  | 'refreshing'
  | 'rotating-and-refreshing'
  | 'needs-attention';

export type CapabilityState = 'available' | 'unavailable';

export interface Settings {
  schemaVersion: SettingsSchemaVersion;
  rotationIntervalMs: Milliseconds;
  rotationDirection: RotationDirection;
  refreshIntervalMs: Milliseconds;
  includePinned: boolean;
  allowlist: readonly string[];
  blocklist: readonly string[];
}

export interface TabDescriptor {
  /** This opaque key identifies the target without exposing its page metadata in results. */
  key: string;
  /** Browser tab identifiers must be revalidated before every action and after recovery. */
  tabId?: number;
  /** Browser window identifiers must be revalidated before every action and after recovery. */
  windowId?: number;
  url: string;
  title?: string;
  index: number;
  pinned: boolean;
}

export const DOMAIN_ERROR_CODES = [
  'invalid-request',
  'invalid-settings',
  'invalid-interval',
  'insufficient-targets',
  'replacement-confirmation-required',
  'schedule-not-found',
  'browser-api-unavailable',
  'browser-operation-failed',
  'tab-activation-failed',
  'tab-reload-failed',
  'storage-read-failed',
  'storage-write-failed',
  'unsupported-schema-version',
  'corrupt-stored-data',
  'ambiguous-recovery',
  'unexpected-error',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export const TARGET_SKIP_REASONS = [
  'missing-tab',
  'moved-to-another-window',
  'url-mismatch',
  'ineligible-url',
  'pinned-tab-excluded',
  'filtered-out',
  'duplicate-target',
] as const;

export type TargetSkipReason = (typeof TARGET_SKIP_REASONS)[number];
export type AutomationAction = 'rotation' | 'scheduled-refresh' | 'refresh-now';

interface TargetActionResultBase {
  /** The opaque descriptor key is safe to retain because it contains no page content. */
  targetKey: TabDescriptor['key'];
}

export interface TargetActionSuccess extends TargetActionResultBase {
  status: 'success';
}

export interface TargetActionSkipped extends TargetActionResultBase {
  status: 'skipped';
  reason: TargetSkipReason;
}

export interface TargetActionFailure extends TargetActionResultBase {
  status: 'failure';
  errorCode: DomainErrorCode;
}

export type TargetActionResult = TargetActionSuccess | TargetActionSkipped | TargetActionFailure;

export interface ActionResultCounts {
  succeeded: number;
  skipped: number;
  failed: number;
  total: number;
}

export interface ActionResultSummary {
  action: AutomationAction;
  completedAt: Timestamp;
  targets: readonly TargetActionResult[];
  counts: ActionResultCounts;
}

interface RuntimeRecordBase {
  schemaVersion: RuntimeSchemaVersion;
  id: string;
  targets: readonly TabDescriptor[];
  /** The source window identifier is a recovery hint and must never be trusted without revalidation. */
  sourceWindowId: number;
  intervalMs: Milliseconds;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastRunAt?: Timestamp;
  lastResult?: ActionResultSummary;
}

interface RunningState {
  state: 'running';
  nextRunAt: Timestamp;
  attentionReason?: never;
}

interface PausedState {
  state: 'paused';
  nextRunAt?: never;
  attentionReason?: never;
}

interface NeedsAttentionState {
  state: 'needs-attention';
  nextRunAt?: never;
  attentionReason: DomainErrorCode;
}

type RuntimeState = RunningState | PausedState | NeedsAttentionState;

interface RotationSessionFields {
  direction: RotationDirection;
  cursor: number;
}

export type RotationSession = RuntimeRecordBase & RotationSessionFields & RuntimeState;
export type RefreshSchedule = RuntimeRecordBase & RuntimeState;
