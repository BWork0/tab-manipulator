import type { TabIneligibilityReason } from '@/core/tab-eligibility';
import type {
  ActionResultSummary,
  AutomationStatus,
  DomainErrorCode,
  RefreshSchedule,
  RotationDirection,
  RotationSession,
  Settings,
  Timestamp,
} from '@/core/types';
import type { BrowserCapabilities } from '@/platform/capabilities';

export const COMMAND_TYPES = [
  'get-snapshot',
  'get-tab-list',
  'start-rotation',
  'pause-rotation',
  'resume-rotation',
  'stop-rotation',
  'start-refresh',
  'stop-refresh',
  'refresh-now',
  'update-settings',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export interface GetSnapshotCommand {
  type: 'get-snapshot';
}

export interface GetTabListCommand {
  type: 'get-tab-list';
}

export interface StartRotationCommand {
  type: 'start-rotation';
  targetKeys: readonly string[];
  intervalMs: number;
  direction: RotationDirection;
  replaceExisting: boolean;
}

export interface PauseRotationCommand {
  type: 'pause-rotation';
}

export interface ResumeRotationCommand {
  type: 'resume-rotation';
}

export interface StopRotationCommand {
  type: 'stop-rotation';
}

export interface StartRefreshCommand {
  type: 'start-refresh';
  targetKeys: readonly string[];
  intervalMs: number;
  replaceExisting: boolean;
}

export interface StopRefreshCommand {
  type: 'stop-refresh';
}

export interface RefreshNowCommand {
  type: 'refresh-now';
  targetKeys: readonly string[];
}

export interface UpdateSettingsCommand {
  type: 'update-settings';
  settings: Settings;
}

export type Command =
  | GetSnapshotCommand
  | GetTabListCommand
  | StartRotationCommand
  | PauseRotationCommand
  | ResumeRotationCommand
  | StopRotationCommand
  | StartRefreshCommand
  | StopRefreshCommand
  | RefreshNowCommand
  | UpdateSettingsCommand;

export interface AutomationSnapshot {
  status: AutomationStatus;
  settings: Settings;
  rotation: RotationSession | null;
  refresh: RefreshSchedule | null;
  capabilities: BrowserCapabilities;
  nextRunAt?: Timestamp;
  lastResult?: ActionResultSummary;
}

export interface TabListItem {
  key: string;
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  index: number;
  pinned: boolean;
  active: boolean;
  eligibility: { eligible: true } | { eligible: false; reason: TabIneligibilityReason };
}

export interface RefreshNowResult {
  snapshot: AutomationSnapshot;
  result: ActionResultSummary;
}

export interface SettingsUpdateResult {
  snapshot: AutomationSnapshot;
  settings: Settings;
}

export interface CommandResultMap {
  'get-snapshot': AutomationSnapshot;
  'get-tab-list': readonly TabListItem[];
  'start-rotation': AutomationSnapshot;
  'pause-rotation': AutomationSnapshot;
  'resume-rotation': AutomationSnapshot;
  'stop-rotation': AutomationSnapshot;
  'start-refresh': AutomationSnapshot;
  'stop-refresh': AutomationSnapshot;
  'refresh-now': RefreshNowResult;
  'update-settings': SettingsUpdateResult;
}

export interface CommandError {
  code: DomainErrorCode;
}

export type CommandSuccessResponse<C extends Command = Command> = C extends Command
  ? {
      ok: true;
      command: C['type'];
      data: CommandResultMap[C['type']];
    }
  : never;

export type CommandErrorResponse<C extends Command = Command> = C extends Command
  ? {
      ok: false;
      command: C['type'];
      error: CommandError;
    }
  : never;

export type CommandResponse<C extends Command = Command> =
  CommandSuccessResponse<C> | CommandErrorResponse<C>;

export interface InvalidMessageResponse {
  ok: false;
  command: null;
  error: {
    code: 'invalid-request';
  };
}

export type RuntimeMessageResponse = CommandResponse | InvalidMessageResponse;

export interface RuntimeMessageSender {
  id?: string;
  url?: string;
  tab?: unknown;
}

export type SendResponse = (response: RuntimeMessageResponse) => void;
export type CommandHandler = (
  command: Command,
  sender: RuntimeMessageSender,
) => CommandResponse | Promise<CommandResponse>;
export type RuntimeMessageListener = (
  message: unknown,
  sender: RuntimeMessageSender,
  sendResponse: SendResponse,
) => true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRotationDirection(value: unknown): value is RotationDirection {
  return value === 'forward' || value === 'backward' || value === 'random';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSettings(value: unknown): value is Settings {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'rotationIntervalMs',
      'rotationDirection',
      'refreshIntervalMs',
      'includePinned',
      'allowlist',
      'blocklist',
    ]) &&
    value.schemaVersion === 1 &&
    isPositiveSafeInteger(value.rotationIntervalMs) &&
    isRotationDirection(value.rotationDirection) &&
    isPositiveSafeInteger(value.refreshIntervalMs) &&
    typeof value.includePinned === 'boolean' &&
    isStringArray(value.allowlist) &&
    isStringArray(value.blocklist)
  );
}

/** Validates the complete wire shape before a message can reach an application handler. */
export function isCommand(value: unknown): value is Command {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'get-snapshot':
    case 'get-tab-list':
    case 'pause-rotation':
    case 'resume-rotation':
    case 'stop-rotation':
    case 'stop-refresh':
      return hasExactKeys(value, ['type']);

    case 'start-rotation':
      return (
        hasExactKeys(value, ['type', 'targetKeys', 'intervalMs', 'direction', 'replaceExisting']) &&
        isStringArray(value.targetKeys) &&
        isPositiveSafeInteger(value.intervalMs) &&
        isRotationDirection(value.direction) &&
        typeof value.replaceExisting === 'boolean'
      );

    case 'start-refresh':
      return (
        hasExactKeys(value, ['type', 'targetKeys', 'intervalMs', 'replaceExisting']) &&
        isStringArray(value.targetKeys) &&
        isPositiveSafeInteger(value.intervalMs) &&
        typeof value.replaceExisting === 'boolean'
      );

    case 'refresh-now':
      return hasExactKeys(value, ['type', 'targetKeys']) && isStringArray(value.targetKeys);

    case 'update-settings':
      return hasExactKeys(value, ['type', 'settings']) && isSettings(value.settings);

    default:
      return false;
  }
}

const INVALID_MESSAGE_RESPONSE: InvalidMessageResponse = Object.freeze({
  ok: false,
  command: null,
  error: Object.freeze({ code: 'invalid-request' }),
});

/**
 * Adapts an async command handler to the callback response contract shared by Chromium,
 * Firefox, and WXT's fake browser. The listener never returns a promise.
 */
export function createRuntimeMessageListener(handler: CommandHandler): RuntimeMessageListener {
  return (message, sender, sendResponse) => {
    if (!isCommand(message)) {
      queueMicrotask(() => sendResponse(INVALID_MESSAGE_RESPONSE));
      return true;
    }

    Promise.resolve()
      .then(() => handler(message, sender))
      .then(sendResponse)
      .catch(() => {
        sendResponse({
          ok: false,
          command: message.type,
          error: { code: 'unexpected-error' },
        } as CommandErrorResponse);
      });

    return true;
  };
}
