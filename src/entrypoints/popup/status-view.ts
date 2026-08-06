import type { AutomationStatus, DomainErrorCode } from '@/core/types';
import type { AutomationSnapshot } from '@/messaging/protocol';
import type { BrowserCapabilities } from '@/platform/capabilities';

export type StatusTone = 'neutral' | 'running' | 'paused' | 'attention';

export interface PopupStatusModel {
  label: string;
  description: string;
  tone: StatusTone;
}

export interface PopupNextActionModel {
  label: string;
  at: number;
}

export interface PopupResultModel {
  text: string;
  tone: 'neutral' | 'attention';
}

export interface PopupSnapshotModel {
  status: PopupStatusModel;
  nextAction?: PopupNextActionModel;
  lastResult?: PopupResultModel;
  unavailableFeatures: readonly string[];
}

const STATUS_MODELS: Readonly<Record<AutomationStatus, PopupStatusModel>> = Object.freeze({
  idle: {
    label: 'Idle',
    description: 'No automation is running.',
    tone: 'neutral',
  },
  rotating: {
    label: 'Rotating',
    description: 'Tab rotation is active.',
    tone: 'running',
  },
  'rotation-paused': {
    label: 'Rotation paused',
    description: 'Your rotation targets are saved. Resume when you are ready.',
    tone: 'paused',
  },
  refreshing: {
    label: 'Refreshing',
    description: 'Scheduled tab refresh is active.',
    tone: 'running',
  },
  'rotating-and-refreshing': {
    label: 'Rotating + refreshing',
    description: 'Tab rotation and scheduled refresh are active.',
    tone: 'running',
  },
  'needs-attention': {
    label: 'Needs attention',
    description: 'Automation is stopped until you review its targets.',
    tone: 'attention',
  },
});

const CAPABILITY_LABELS: Readonly<Record<keyof BrowserCapabilities, string>> = Object.freeze({
  currentWindowTabQuery: 'current-window tab access',
  allWindowTabQuery: 'restart recovery',
  tabActivation: 'tab rotation',
  tabReload: 'tab refresh',
  toolbarState: 'toolbar status',
  optionsPage: 'advanced settings',
});

const COMMAND_ERROR_MESSAGES: Readonly<Record<DomainErrorCode, string>> = Object.freeze({
  'invalid-request': 'The browser rejected the status request. Reopen the popup and try again.',
  'invalid-settings': 'Saved settings could not be read safely.',
  'invalid-interval': 'A saved automation interval is invalid.',
  'insufficient-targets': 'There are not enough eligible tabs for this automation.',
  'replacement-confirmation-required':
    'An existing schedule needs confirmation before replacement.',
  'schedule-not-found': 'The requested schedule no longer exists.',
  'browser-api-unavailable': 'This browser does not provide an API required by the extension.',
  'browser-operation-failed': 'The browser could not return the current automation status.',
  'tab-activation-failed': 'The browser could not activate a scheduled tab.',
  'tab-reload-failed': 'The browser could not refresh a scheduled tab.',
  'storage-read-failed': 'Saved automation state could not be read.',
  'storage-write-failed': 'Saved automation state could not be updated.',
  'unsupported-schema-version': 'Saved automation state was created by an unsupported version.',
  'corrupt-stored-data': 'Saved automation state is damaged and needs review.',
  'ambiguous-recovery': 'Saved tabs could not be matched safely after restart.',
  'unexpected-error': 'Something went wrong while loading the automation status.',
});

function nextActionFor(snapshot: AutomationSnapshot): PopupNextActionModel | undefined {
  const at = snapshot.nextRunAt;

  if (at === undefined) {
    return undefined;
  }

  const rotationDue = snapshot.rotation?.state === 'running' && snapshot.rotation.nextRunAt === at;
  const refreshDue = snapshot.refresh?.state === 'running' && snapshot.refresh.nextRunAt === at;
  const label =
    rotationDue && refreshDue ? 'Rotation and refresh' : rotationDue ? 'Rotation' : 'Refresh';

  return { label, at };
}

function lastResultFor(snapshot: AutomationSnapshot): PopupResultModel | undefined {
  const counts = snapshot.lastResult?.counts;

  if (counts === undefined) {
    return undefined;
  }

  const parts = [
    `${counts.succeeded} succeeded`,
    `${counts.skipped} skipped`,
    `${counts.failed} failed`,
  ];

  return {
    text: `Last action: ${parts.join(', ')}.`,
    tone: counts.failed > 0 ? 'attention' : 'neutral',
  };
}

/** Converts a persisted background snapshot into display-only popup content. */
export function popupSnapshotModel(snapshot: AutomationSnapshot): PopupSnapshotModel {
  const nextAction = nextActionFor(snapshot);
  const lastResult = lastResultFor(snapshot);
  const unavailableFeatures = Object.entries(snapshot.capabilities)
    .filter(([, state]) => state === 'unavailable')
    .map(([capability]) => CAPABILITY_LABELS[capability as keyof BrowserCapabilities]);

  return {
    status: STATUS_MODELS[snapshot.status],
    ...(nextAction === undefined ? {} : { nextAction }),
    ...(lastResult === undefined ? {} : { lastResult }),
    unavailableFeatures,
  };
}

export function commandErrorMessage(code: DomainErrorCode): string {
  return COMMAND_ERROR_MESSAGES[code];
}

export function formatNextRun(at: number, now = Date.now()): string {
  const date = new Date(at);

  if (!Number.isFinite(at) || Number.isNaN(date.getTime())) {
    return 'Time unavailable';
  }

  const differenceMs = at - now;

  if (differenceMs <= 1_000 && differenceMs >= -1_000) {
    return 'Due now';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}
