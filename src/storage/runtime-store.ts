import {
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_ROTATION_DIRECTION,
  DEFAULT_ROTATION_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  MIN_ROTATION_INTERVAL_MS,
} from '@/core/defaults';
import {
  DOMAIN_ERROR_CODES,
  RUNTIME_SCHEMA_VERSION,
  TARGET_SKIP_REASONS,
  type ActionResultSummary,
  type DomainErrorCode,
  type RefreshSchedule,
  type RotationDirection,
  type RotationSession,
  type TabDescriptor,
  type TargetActionResult,
  type TargetSkipReason,
} from '@/core/types';
import { storage } from 'wxt/utils/storage';

export const ROTATION_RUNTIME_STORAGE_KEY = 'local:runtime-rotation' as const;
export const REFRESH_RUNTIME_STORAGE_KEY = 'local:runtime-refresh' as const;
export const CORRUPT_ROTATION_RUNTIME_STORAGE_KEY = 'local:runtime-rotation-corrupt' as const;
export const CORRUPT_REFRESH_RUNTIME_STORAGE_KEY = 'local:runtime-refresh-corrupt' as const;

export type RuntimeRecordUpdate<T> = (current: T | null) => T | null | Promise<T | null>;

type RuntimeRecordKind = 'rotation' | 'refresh';
type RuntimeRecordFor<TKind extends RuntimeRecordKind> = TKind extends 'rotation'
  ? RotationSession
  : RefreshSchedule;
type RuntimeValidationErrorCode = Extract<
  DomainErrorCode,
  'corrupt-stored-data' | 'unsupported-schema-version'
>;
type RuntimeStorageItem = ReturnType<typeof defineRuntimeStorageItem>;

interface ParsedRuntimeBase {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  id: string;
  targets: readonly TabDescriptor[];
  sourceWindowId: number;
  intervalMs: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastResult?: ActionResultSummary;
}

type ParsedRuntimeState =
  | { state: 'running'; nextRunAt: number }
  | { state: 'paused' }
  | { state: 'needs-attention'; attentionReason: DomainErrorCode };

type ParseResult<T> =
  { valid: true; record: T } | { valid: false; errorCode: RuntimeValidationErrorCode };

const RUNTIME_MIGRATIONS = Object.freeze({});
const DOMAIN_ERROR_CODE_SET = new Set<string>(DOMAIN_ERROR_CODES);
const TARGET_SKIP_REASON_SET = new Set<string>(TARGET_SKIP_REASONS);

let rotationItem: RuntimeStorageItem | undefined;
let refreshItem: RuntimeStorageItem | undefined;
let corruptRotationItem: RuntimeStorageItem | undefined;
let corruptRefreshItem: RuntimeStorageItem | undefined;
let rotationQueue: Promise<unknown> = Promise.resolve();
let refreshQueue: Promise<unknown> = Promise.resolve();

function defineRuntimeStorageItem(key: `local:${string}`, versioned: boolean) {
  return storage.defineItem<unknown>(key, {
    fallback: null,
    ...(versioned
      ? { version: RUNTIME_SCHEMA_VERSION, migrations: RUNTIME_MIGRATIONS }
      : undefined),
  });
}

function getRuntimeStorageItem(kind: RuntimeRecordKind): RuntimeStorageItem {
  if (kind === 'rotation') {
    rotationItem ??= defineRuntimeStorageItem(ROTATION_RUNTIME_STORAGE_KEY, true);
    return rotationItem;
  }

  refreshItem ??= defineRuntimeStorageItem(REFRESH_RUNTIME_STORAGE_KEY, true);
  return refreshItem;
}

function getCorruptRuntimeStorageItem(kind: RuntimeRecordKind): RuntimeStorageItem {
  if (kind === 'rotation') {
    corruptRotationItem ??= defineRuntimeStorageItem(CORRUPT_ROTATION_RUNTIME_STORAGE_KEY, false);
    return corruptRotationItem;
  }

  corruptRefreshItem ??= defineRuntimeStorageItem(CORRUPT_REFRESH_RUNTIME_STORAGE_KEY, false);
  return corruptRefreshItem;
}

function enqueueRuntimeOperation<T>(
  kind: RuntimeRecordKind,
  operation: () => Promise<T>,
): Promise<T> {
  const queue = kind === 'rotation' ? rotationQueue : refreshQueue;
  const result = queue.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  if (kind === 'rotation') {
    rotationQueue = settled;
  } else {
    refreshQueue = settled;
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function isInterval(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isRotationDirection(value: unknown): value is RotationDirection {
  return value === 'forward' || value === 'backward' || value === 'random';
}

function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return typeof value === 'string' && DOMAIN_ERROR_CODE_SET.has(value);
}

function hasValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function parseTargetDescriptor(value: unknown): TabDescriptor | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.key) ||
    !isNonEmptyString(value.url) ||
    !hasValidUrl(value.url) ||
    !isNonNegativeInteger(value.index) ||
    typeof value.pinned !== 'boolean' ||
    (value.tabId !== undefined && !isNonNegativeInteger(value.tabId)) ||
    (value.windowId !== undefined && !isNonNegativeInteger(value.windowId)) ||
    (value.title !== undefined && typeof value.title !== 'string')
  ) {
    return null;
  }

  return Object.freeze({
    key: value.key,
    ...(value.tabId === undefined ? undefined : { tabId: value.tabId }),
    ...(value.windowId === undefined ? undefined : { windowId: value.windowId }),
    url: value.url,
    ...(value.title === undefined ? undefined : { title: value.title }),
    index: value.index,
    pinned: value.pinned,
  });
}

function parseTargets(value: unknown): readonly TabDescriptor[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const targets: TabDescriptor[] = [];
  const keys = new Set<string>();

  for (const candidate of value) {
    const target = parseTargetDescriptor(candidate);

    if (target === null || keys.has(target.key)) {
      return null;
    }

    keys.add(target.key);
    targets.push(target);
  }

  return Object.freeze(targets);
}

function parseTargetActionResult(value: unknown): TargetActionResult | null {
  if (!isRecord(value) || !isNonEmptyString(value.targetKey)) {
    return null;
  }

  if (value.status === 'success') {
    return Object.freeze({ targetKey: value.targetKey, status: 'success' });
  }

  if (
    value.status === 'skipped' &&
    typeof value.reason === 'string' &&
    TARGET_SKIP_REASON_SET.has(value.reason)
  ) {
    return Object.freeze({
      targetKey: value.targetKey,
      status: 'skipped',
      reason: value.reason as TargetSkipReason,
    });
  }

  if (value.status === 'failure' && isDomainErrorCode(value.errorCode)) {
    return Object.freeze({
      targetKey: value.targetKey,
      status: 'failure',
      errorCode: value.errorCode,
    });
  }

  return null;
}

function parseActionResultSummary(value: unknown): ActionResultSummary | null {
  if (
    !isRecord(value) ||
    (value.action !== 'rotation' &&
      value.action !== 'scheduled-refresh' &&
      value.action !== 'refresh-now') ||
    !isTimestamp(value.completedAt) ||
    !Array.isArray(value.targets) ||
    !isRecord(value.counts)
  ) {
    return null;
  }

  const targets: TargetActionResult[] = [];

  for (const candidate of value.targets) {
    const target = parseTargetActionResult(candidate);

    if (target === null) {
      return null;
    }

    targets.push(target);
  }

  const succeeded = targets.filter(({ status }) => status === 'success').length;
  const skipped = targets.filter(({ status }) => status === 'skipped').length;
  const failed = targets.filter(({ status }) => status === 'failure').length;

  if (
    value.counts.succeeded !== succeeded ||
    value.counts.skipped !== skipped ||
    value.counts.failed !== failed ||
    value.counts.total !== targets.length
  ) {
    return null;
  }

  return Object.freeze({
    action: value.action,
    completedAt: value.completedAt,
    targets: Object.freeze(targets),
    counts: Object.freeze({ succeeded, skipped, failed, total: targets.length }),
  });
}

function parseRuntimeState(value: Record<string, unknown>): ParsedRuntimeState | null {
  if (
    value.state === 'running' &&
    isTimestamp(value.nextRunAt) &&
    value.attentionReason === undefined
  ) {
    return { state: 'running', nextRunAt: value.nextRunAt };
  }

  if (
    value.state === 'paused' &&
    value.nextRunAt === undefined &&
    value.attentionReason === undefined
  ) {
    return { state: 'paused' };
  }

  if (
    value.state === 'needs-attention' &&
    value.nextRunAt === undefined &&
    isDomainErrorCode(value.attentionReason)
  ) {
    return { state: 'needs-attention', attentionReason: value.attentionReason };
  }

  return null;
}

function parseRuntimeBase(
  value: Record<string, unknown>,
  minimumInterval: number,
): (ParsedRuntimeBase & ParsedRuntimeState) | null {
  const targets = parseTargets(value.targets);
  const state = parseRuntimeState(value);
  const lastResult =
    value.lastResult === undefined ? undefined : parseActionResultSummary(value.lastResult);

  if (
    value.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    !isNonEmptyString(value.id) ||
    targets === null ||
    !isNonNegativeInteger(value.sourceWindowId) ||
    !isInterval(value.intervalMs, minimumInterval) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.createdAt > value.updatedAt ||
    (value.lastRunAt !== undefined &&
      (!isTimestamp(value.lastRunAt) || value.lastRunAt > value.updatedAt)) ||
    (value.lastResult !== undefined && lastResult === null) ||
    state === null
  ) {
    return null;
  }

  const base: ParsedRuntimeBase = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: value.id,
    targets,
    sourceWindowId: value.sourceWindowId,
    intervalMs: value.intervalMs,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.lastRunAt === undefined ? undefined : { lastRunAt: value.lastRunAt }),
    ...(lastResult === undefined || lastResult === null ? undefined : { lastResult }),
  };

  return { ...base, ...state };
}

function parseRuntimeRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
  value: unknown,
): ParseResult<RuntimeRecordFor<TKind>> {
  if (
    isRecord(value) &&
    value.schemaVersion !== undefined &&
    value.schemaVersion !== RUNTIME_SCHEMA_VERSION
  ) {
    return { valid: false, errorCode: 'unsupported-schema-version' };
  }

  if (!isRecord(value)) {
    return { valid: false, errorCode: 'corrupt-stored-data' };
  }

  const base = parseRuntimeBase(
    value,
    kind === 'rotation' ? MIN_ROTATION_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS,
  );

  if (base === null) {
    return { valid: false, errorCode: 'corrupt-stored-data' };
  }

  if (kind === 'rotation') {
    if (!isRotationDirection(value.direction) || !isNonNegativeInteger(value.cursor)) {
      return { valid: false, errorCode: 'corrupt-stored-data' };
    }

    const record = Object.freeze({
      ...base,
      direction: value.direction,
      cursor: value.cursor,
    }) as RuntimeRecordFor<TKind>;
    return { valid: true, record };
  }

  return {
    valid: true,
    record: Object.freeze(base) as RuntimeRecordFor<TKind>,
  };
}

function createSafeAttentionRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
  attentionReason: RuntimeValidationErrorCode,
): RuntimeRecordFor<TKind> {
  const base = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: `invalid-${kind}-runtime-record`,
    state: 'needs-attention' as const,
    targets: Object.freeze([]) as readonly TabDescriptor[],
    sourceWindowId: 0,
    intervalMs: kind === 'rotation' ? DEFAULT_ROTATION_INTERVAL_MS : DEFAULT_REFRESH_INTERVAL_MS,
    createdAt: 0,
    updatedAt: 0,
    attentionReason,
  };

  return Object.freeze(
    kind === 'rotation' ? { ...base, direction: DEFAULT_ROTATION_DIRECTION, cursor: 0 } : base,
  ) as RuntimeRecordFor<TKind>;
}

async function readAndRepairRuntimeRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
): Promise<RuntimeRecordFor<TKind> | null> {
  const item = getRuntimeStorageItem(kind);
  const storedValue = await item.getValue();

  if (storedValue === null || storedValue === undefined) {
    return null;
  }

  const parsed = parseRuntimeRecord(kind, storedValue);

  if (parsed.valid) {
    return parsed.record;
  }

  const safeRecord = createSafeAttentionRecord(kind, parsed.errorCode);
  await getCorruptRuntimeStorageItem(kind).setValue(storedValue);
  await item.setValue(safeRecord);
  return safeRecord;
}

async function setRuntimeRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
  candidate: RuntimeRecordFor<TKind>,
): Promise<RuntimeRecordFor<TKind>> {
  const parsed = parseRuntimeRecord(kind, candidate);

  if (!parsed.valid) {
    throw new TypeError(`Invalid ${kind} runtime record: ${parsed.errorCode}.`);
  }

  await getRuntimeStorageItem(kind).setValue(parsed.record);
  await getCorruptRuntimeStorageItem(kind).removeValue();
  return parsed.record;
}

async function clearRuntimeRecord(kind: RuntimeRecordKind): Promise<void> {
  await Promise.all([
    getRuntimeStorageItem(kind).removeValue(),
    getCorruptRuntimeStorageItem(kind).removeValue(),
  ]);
}

function getRuntimeRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
): Promise<RuntimeRecordFor<TKind> | null> {
  return enqueueRuntimeOperation(kind, () => readAndRepairRuntimeRecord(kind));
}

function replaceRuntimeRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
  record: RuntimeRecordFor<TKind>,
): Promise<RuntimeRecordFor<TKind>> {
  return enqueueRuntimeOperation(kind, () => setRuntimeRecord(kind, record));
}

function updateRuntimeRecord<TKind extends RuntimeRecordKind>(
  kind: TKind,
  update: RuntimeRecordUpdate<RuntimeRecordFor<TKind>>,
): Promise<RuntimeRecordFor<TKind> | null> {
  return enqueueRuntimeOperation(kind, async () => {
    const current = await readAndRepairRuntimeRecord(kind);
    const updated = await update(current);

    if (updated === null) {
      await clearRuntimeRecord(kind);
      return null;
    }

    return setRuntimeRecord(kind, updated);
  });
}

function removeRuntimeRecord(kind: RuntimeRecordKind): Promise<void> {
  return enqueueRuntimeOperation(kind, () => clearRuntimeRecord(kind));
}

/** Returns the persisted rotation session, repairing invalid data to a safe attention state. */
export function getRotationSession(): Promise<RotationSession | null> {
  return getRuntimeRecord('rotation');
}

/** Replaces the complete rotation session after validating the storage boundary. */
export function setRotationSession(session: RotationSession): Promise<RotationSession> {
  return replaceRuntimeRecord('rotation', session);
}

/** Serializes a read-modify-write transition for the rotation session. */
export function updateRotationSession(
  update: RuntimeRecordUpdate<RotationSession>,
): Promise<RotationSession | null> {
  return updateRuntimeRecord('rotation', update);
}

/** Removes the live rotation session and any preserved corrupt copy. */
export function clearRotationSession(): Promise<void> {
  return removeRuntimeRecord('rotation');
}

/** Returns the persisted refresh schedule, repairing invalid data to a safe attention state. */
export function getRefreshSchedule(): Promise<RefreshSchedule | null> {
  return getRuntimeRecord('refresh');
}

/** Replaces the complete refresh schedule after validating the storage boundary. */
export function setRefreshSchedule(schedule: RefreshSchedule): Promise<RefreshSchedule> {
  return replaceRuntimeRecord('refresh', schedule);
}

/** Serializes a read-modify-write transition for the refresh schedule. */
export function updateRefreshSchedule(
  update: RuntimeRecordUpdate<RefreshSchedule>,
): Promise<RefreshSchedule | null> {
  return updateRuntimeRecord('refresh', update);
}

/** Removes the live refresh schedule and any preserved corrupt copy. */
export function clearRefreshSchedule(): Promise<void> {
  return removeRuntimeRecord('refresh');
}
