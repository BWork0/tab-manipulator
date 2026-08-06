import { MIN_REFRESH_INTERVAL_MS, MIN_ROTATION_INTERVAL_MS } from '@/core/defaults';
import { createStartupRecovery, type StartupRecovery } from '@/core/recovery';
import { parseRuleConfiguration } from '@/core/rule-engine';
import {
  createHybridScheduler,
  type HybridScheduler,
  type ScheduleKind,
  type SchedulerClock,
  type SchedulerDueEvent,
  type SchedulerTimers,
} from '@/core/scheduler';
import { evaluateTabEligibility } from '@/core/tab-eligibility';
import {
  DOMAIN_ERROR_CODES,
  type DomainErrorCode,
  type RefreshSchedule,
  type RotationSession,
  type Settings,
  type Timestamp,
} from '@/core/types';
import {
  createRuntimeMessageListener,
  type Command,
  type CommandErrorResponse,
  type CommandResponse,
  type RuntimeMessageListener,
  type RuntimeMessageSender,
  type TabListItem,
} from '@/messaging/protocol';
import { createBrowserAlarmScheduler, type BrowserAlarmsApiLike } from '@/platform/alarm-scheduler';
import { createBrowserApiAdapter, type BrowserApiAdapter } from '@/platform/browser-api';
import { createRefreshService, type RefreshService } from '@/services/refresh-service';
import { createRotationService, type RotationService } from '@/services/rotation-service';
import { createStatusService, type StatusService } from '@/services/status-service';
import {
  clearRefreshSchedule,
  clearRotationSession,
  getRefreshSchedule,
  getRotationSession,
  setRefreshSchedule,
  setRotationSession,
  updateRefreshSchedule,
  updateRotationSession,
  type RuntimeRecordUpdate,
} from '@/storage/runtime-store';
import { readSettings, updateSettings } from '@/storage/settings-store';
import { browser } from 'wxt/browser';

interface RuntimeMessageEvent {
  addListener(listener: RuntimeMessageListener): void;
}

interface RuntimeVoidEvent<TArguments extends readonly unknown[] = readonly []> {
  addListener(listener: (...arguments_: TArguments) => void): void;
}

export interface BackgroundRuntimeApi {
  onMessage: RuntimeMessageEvent;
  onStartup?: RuntimeVoidEvent;
  onInstalled?: RuntimeVoidEvent<readonly [details: unknown]>;
}

export interface BackgroundAttentionStore {
  updateRotationSession(
    update: RuntimeRecordUpdate<RotationSession>,
  ): Promise<RotationSession | null>;
  updateRefreshSchedule(
    update: RuntimeRecordUpdate<RefreshSchedule>,
  ): Promise<RefreshSchedule | null>;
}

export interface BackgroundSettingsStore {
  updateSettings(settings: Settings): Promise<Settings>;
}

export interface BackgroundApplicationDependencies {
  runtime: BackgroundRuntimeApi;
  browser: Pick<BrowserApiAdapter, 'queryCurrentWindowTabs'>;
  scheduler: HybridScheduler;
  recovery: StartupRecovery;
  rotation: RotationService;
  refresh: RefreshService;
  status: StatusService;
  attentionStore: BackgroundAttentionStore;
  settingsStore: BackgroundSettingsStore;
  clock: SchedulerClock;
}

export interface BackgroundApplication {
  /** Registers all browser listeners and starts recovery without returning a promise. */
  start(): void;
  /** Exposes initialization completion for deterministic integration tests. */
  whenReady(): Promise<void>;
}

export interface DefaultBackgroundApplicationOptions {
  clock?: SchedulerClock;
  timers?: SchedulerTimers;
}

const DOMAIN_ERROR_CODE_SET = new Set<string>(DOMAIN_ERROR_CODES);
const EXPECTED_COMMAND_ERROR_CODES = new Set<DomainErrorCode>([
  'invalid-request',
  'invalid-settings',
  'invalid-interval',
  'insufficient-targets',
  'replacement-confirmation-required',
  'schedule-not-found',
]);

const SYSTEM_CLOCK: SchedulerClock = {
  now: () => Date.now() as Timestamp,
};

const SYSTEM_TIMERS: SchedulerTimers = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(() => void callback(), delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

function errorCodeFrom(error: unknown): DomainErrorCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DOMAIN_ERROR_CODE_SET.has(error.code)
  ) {
    return error.code as DomainErrorCode;
  }

  return 'unexpected-error';
}

function checkedNow(clock: SchedulerClock): Timestamp {
  try {
    const now = clock.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : (Date.now() as Timestamp);
  } catch {
    return Date.now() as Timestamp;
  }
}

function withAttention<TRecord extends RotationSession | RefreshSchedule>(
  record: TRecord,
  reason: DomainErrorCode,
  now: Timestamp,
): TRecord {
  if (record.state === 'needs-attention') {
    return record;
  }

  const { nextRunAt: _nextRunAt, attentionReason: _attentionReason, ...base } = record;
  return {
    ...base,
    state: 'needs-attention',
    attentionReason: reason,
    updatedAt: Math.max(now, record.createdAt, record.updatedAt, record.lastRunAt ?? 0),
  } as TRecord;
}

function commandAttentionKinds(command: Command): readonly ScheduleKind[] {
  switch (command.type) {
    case 'start-rotation':
    case 'pause-rotation':
    case 'resume-rotation':
    case 'stop-rotation':
      return ['rotation'];

    case 'start-refresh':
    case 'stop-refresh':
    case 'refresh-now':
      return ['refresh'];

    case 'update-settings':
    case 'get-snapshot':
      return ['rotation', 'refresh'];

    case 'get-tab-list':
      return [];
  }
}

function validateSettings(settings: Settings): void {
  if (
    settings.rotationIntervalMs < MIN_ROTATION_INTERVAL_MS ||
    settings.refreshIntervalMs < MIN_REFRESH_INTERVAL_MS ||
    !parseRuleConfiguration(settings.allowlist, settings.blocklist).valid
  ) {
    throw Object.assign(new Error('Invalid settings.'), {
      code: 'invalid-settings' satisfies DomainErrorCode,
    });
  }
}

function tabListItems(
  tabs: Awaited<ReturnType<BrowserApiAdapter['queryCurrentWindowTabs']>>,
): readonly TabListItem[] {
  if (!tabs.ok) {
    throw tabs.error;
  }

  return tabs.value.map((tab) => ({
    key: tab.key,
    ...(tab.tabId === undefined ? {} : { tabId: tab.tabId }),
    ...(tab.windowId === undefined ? {} : { windowId: tab.windowId }),
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.favIconUrl === undefined ? {} : { favIconUrl: tab.favIconUrl }),
    index: tab.index,
    pinned: tab.pinned,
    active: tab.active,
    eligibility: evaluateTabEligibility(tab.url),
  }));
}

function createScheduleId(): string {
  return globalThis.crypto.randomUUID();
}

/** Coordinates browser events and application services without owning product behavior. */
export function createBackgroundApplication({
  runtime,
  browser: browserApi,
  scheduler,
  recovery,
  rotation,
  refresh,
  status,
  attentionStore,
  settingsStore,
  clock,
}: BackgroundApplicationDependencies): BackgroundApplication {
  let started = false;
  let ready: Promise<void> | undefined;

  async function persistAttention(
    kinds: readonly ScheduleKind[],
    reason: DomainErrorCode,
  ): Promise<void> {
    const now = checkedNow(clock);

    await Promise.allSettled(
      kinds.map(async (kind) => {
        try {
          if (kind === 'rotation') {
            await attentionStore.updateRotationSession((record) =>
              record === null ? null : withAttention(record, reason, now),
            );
          } else {
            await attentionStore.updateRefreshSchedule((record) =>
              record === null ? null : withAttention(record, reason, now),
            );
          }
        } finally {
          try {
            await scheduler.cancel(kind);
          } catch {
            // Persisted attention state makes any stale scheduler delivery harmless.
          }
        }
      }),
    );
  }

  async function syncToolbarSafely(): Promise<void> {
    try {
      await status.syncToolbar();
    } catch {
      // Toolbar updates are always non-fatal to automation and command handling.
    }
  }

  function ensureReady(): Promise<void> {
    ready ??= (async () => {
      try {
        await recovery.recover();
      } catch (error) {
        await persistAttention(['rotation', 'refresh'], errorCodeFrom(error));
      }

      await syncToolbarSafely();
    })();

    return ready;
  }

  async function snapshotAfterMutation() {
    return (await status.syncToolbar()).snapshot;
  }

  async function dispatch(command: Command): Promise<CommandResponse> {
    await ensureReady();

    try {
      switch (command.type) {
        case 'get-snapshot':
          return { ok: true, command: command.type, data: await status.getSnapshot() };

        case 'get-tab-list':
          return {
            ok: true,
            command: command.type,
            data: tabListItems(await browserApi.queryCurrentWindowTabs()),
          };

        case 'start-rotation':
          await rotation.start(command);
          return { ok: true, command: command.type, data: await snapshotAfterMutation() };

        case 'pause-rotation':
          await rotation.pause();
          return { ok: true, command: command.type, data: await snapshotAfterMutation() };

        case 'resume-rotation':
          await rotation.resume();
          return { ok: true, command: command.type, data: await snapshotAfterMutation() };

        case 'stop-rotation':
          await rotation.stop();
          return { ok: true, command: command.type, data: await snapshotAfterMutation() };

        case 'start-refresh':
          await refresh.start(command);
          return { ok: true, command: command.type, data: await snapshotAfterMutation() };

        case 'stop-refresh':
          await refresh.stop();
          return { ok: true, command: command.type, data: await snapshotAfterMutation() };

        case 'refresh-now': {
          const result = await refresh.refreshNow(command);
          return {
            ok: true,
            command: command.type,
            data: { snapshot: await snapshotAfterMutation(), result },
          };
        }

        case 'update-settings': {
          validateSettings(command.settings);
          const settings = await settingsStore.updateSettings(command.settings);
          return {
            ok: true,
            command: command.type,
            data: { snapshot: await snapshotAfterMutation(), settings },
          };
        }
      }
    } catch (error) {
      const code = errorCodeFrom(error);

      if (!EXPECTED_COMMAND_ERROR_CODES.has(code)) {
        await persistAttention(commandAttentionKinds(command), code);
        await syncToolbarSafely();
      }

      return {
        ok: false,
        command: command.type,
        error: { code },
      } as CommandErrorResponse;
    }
  }

  async function handleDue(event: SchedulerDueEvent): Promise<void> {
    await ensureReady();

    try {
      if (event.kind === 'rotation') {
        await rotation.handleDueTick(event);
      } else {
        await refresh.handleDueRun(event);
      }
    } catch (error) {
      await persistAttention([event.kind], errorCodeFrom(error));
    }

    await syncToolbarSafely();
  }

  const messageListener = createRuntimeMessageListener(
    (command: Command, _sender: RuntimeMessageSender) => dispatch(command),
  );

  function start(): void {
    if (started) {
      return;
    }

    started = true;
    scheduler.onDue((event) => handleDue(event));
    runtime.onMessage.addListener(messageListener);
    runtime.onStartup?.addListener(() => void ensureReady());
    runtime.onInstalled?.addListener(() => void ensureReady());
    void ensureReady();
  }

  return {
    start,
    whenReady: ensureReady,
  };
}

/** Composes the production application. Call only from the WXT background main function. */
export function createDefaultBackgroundApplication({
  clock = SYSTEM_CLOCK,
  timers = SYSTEM_TIMERS,
}: DefaultBackgroundApplicationOptions = {}): BackgroundApplication {
  const browserApi = createBrowserApiAdapter();
  const alarmScheduler = createBrowserAlarmScheduler(
    browser.alarms as unknown as BrowserAlarmsApiLike,
  );
  const scheduler = createHybridScheduler({ clock, timers, alarms: alarmScheduler });
  const runtimeStore = {
    getRotationSession,
    setRotationSession,
    clearRotationSession,
    getRefreshSchedule,
    setRefreshSchedule,
    clearRefreshSchedule,
  };
  const rotation = createRotationService({
    browser: browserApi,
    clock,
    scheduler,
    store: runtimeStore,
    readSettings,
    createId: createScheduleId,
  });
  const refresh = createRefreshService({
    browser: browserApi,
    clock,
    scheduler,
    store: runtimeStore,
    readSettings,
    createId: createScheduleId,
  });
  const status = createStatusService({ browser: browserApi, store: runtimeStore, readSettings });
  const recovery = createStartupRecovery({
    browser: browserApi,
    clock,
    scheduler,
    store: runtimeStore,
  });

  return createBackgroundApplication({
    runtime: browser.runtime as unknown as BackgroundRuntimeApi,
    browser: browserApi,
    scheduler,
    recovery,
    rotation,
    refresh,
    status,
    attentionStore: { updateRotationSession, updateRefreshSchedule },
    settingsStore: { updateSettings },
    clock,
  });
}
