import {
  DEFAULT_ALLOWLIST,
  DEFAULT_BLOCKLIST,
  DEFAULT_INCLUDE_PINNED,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_ROTATION_DIRECTION,
  DEFAULT_ROTATION_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  MIN_ROTATION_INTERVAL_MS,
} from '@/core/defaults';
import { parseRuleList } from '@/core/rule-engine';
import { SETTINGS_SCHEMA_VERSION, type RotationDirection, type Settings } from '@/core/types';
import { storage } from 'wxt/utils/storage';

export const SETTINGS_STORAGE_KEY = 'local:settings' as const;

export type SettingsUpdate = Partial<Omit<Settings, 'schemaVersion'>>;
export type SettingsWatcher = (settings: Settings, previousSettings: Settings) => void;
export type UnwatchSettings = () => void;

type Migration = (oldValue: unknown) => unknown;

/** Add the migration for version N here before increasing SETTINGS_SCHEMA_VERSION to N. */
const SETTINGS_MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

let updateQueue: Promise<void> = Promise.resolve();
let settingsItem: ReturnType<typeof defineSettingsItem> | undefined;

function defineSettingsItem() {
  return storage.defineItem<unknown>(SETTINGS_STORAGE_KEY, {
    fallback: createDefaultSettings(),
    version: SETTINGS_SCHEMA_VERSION,
    migrations: SETTINGS_MIGRATIONS,
  });
}

function getSettingsItem(): ReturnType<typeof defineSettingsItem> {
  settingsItem ??= defineSettingsItem();
  return settingsItem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInterval(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isRotationDirection(value: unknown): value is RotationDirection {
  return value === 'forward' || value === 'backward' || value === 'random';
}

function normalizeRuleList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((rule) => typeof rule !== 'string')) {
    return [...fallback];
  }

  const parsed = parseRuleList(value as string[]);
  return parsed.valid ? [...parsed.normalized] : [...fallback];
}

function createSettings(settings: Settings): Settings {
  return Object.freeze({
    ...settings,
    allowlist: Object.freeze([...settings.allowlist]),
    blocklist: Object.freeze([...settings.blocklist]),
  });
}

function createDefaultSettings(): Settings {
  return createSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    rotationIntervalMs: DEFAULT_ROTATION_INTERVAL_MS,
    rotationDirection: DEFAULT_ROTATION_DIRECTION,
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    includePinned: DEFAULT_INCLUDE_PINNED,
    allowlist: DEFAULT_ALLOWLIST,
    blocklist: DEFAULT_BLOCKLIST,
  });
}

function normalizeSettings(value: unknown): Settings {
  if (!isRecord(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return createDefaultSettings();
  }

  return createSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    rotationIntervalMs: isInterval(value.rotationIntervalMs, MIN_ROTATION_INTERVAL_MS)
      ? value.rotationIntervalMs
      : DEFAULT_ROTATION_INTERVAL_MS,
    rotationDirection: isRotationDirection(value.rotationDirection)
      ? value.rotationDirection
      : DEFAULT_ROTATION_DIRECTION,
    refreshIntervalMs: isInterval(value.refreshIntervalMs, MIN_REFRESH_INTERVAL_MS)
      ? value.refreshIntervalMs
      : DEFAULT_REFRESH_INTERVAL_MS,
    includePinned:
      typeof value.includePinned === 'boolean' ? value.includePinned : DEFAULT_INCLUDE_PINNED,
    allowlist: normalizeRuleList(value.allowlist, DEFAULT_ALLOWLIST),
    blocklist: normalizeRuleList(value.blocklist, DEFAULT_BLOCKLIST),
  });
}

function settingsEqual(left: unknown, right: Settings): boolean {
  if (!isRecord(left)) {
    return false;
  }

  return (
    Object.keys(left).length === 7 &&
    left.schemaVersion === right.schemaVersion &&
    left.rotationIntervalMs === right.rotationIntervalMs &&
    left.rotationDirection === right.rotationDirection &&
    left.refreshIntervalMs === right.refreshIntervalMs &&
    left.includePinned === right.includePinned &&
    Array.isArray(left.allowlist) &&
    left.allowlist.length === right.allowlist.length &&
    left.allowlist.every((rule, index) => rule === right.allowlist[index]) &&
    Array.isArray(left.blocklist) &&
    left.blocklist.length === right.blocklist.length &&
    left.blocklist.every((rule, index) => rule === right.blocklist[index])
  );
}

async function readAndRepairSettings(): Promise<Settings> {
  const settingsItem = getSettingsItem();
  const storedValue = await settingsItem.getValue();
  const settings = normalizeSettings(storedValue);

  if (!settingsEqual(storedValue, settings)) {
    await settingsItem.setValue(settings);
  }

  return settings;
}

function enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = updateQueue.then(operation, operation);
  updateQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Reads a complete, validated settings snapshot and repairs corrupt persisted fields. */
export function readSettings(): Promise<Settings> {
  return readAndRepairSettings();
}

/** Applies a partial update as one complete storage write after boundary validation. */
export function updateSettings(update: SettingsUpdate): Promise<Settings> {
  return enqueueUpdate(async () => {
    const settingsItem = getSettingsItem();
    const currentSettings = await readAndRepairSettings();
    const candidate = isRecord(update)
      ? { ...currentSettings, ...update, schemaVersion: SETTINGS_SCHEMA_VERSION }
      : currentSettings;
    const settings = normalizeSettings(candidate);

    await settingsItem.setValue(settings);
    return settings;
  });
}

/** Watches the settings item while preventing corrupt raw values from reaching consumers. */
export function watchSettings(watcher: SettingsWatcher): UnwatchSettings {
  return getSettingsItem().watch((newValue, oldValue) => {
    watcher(normalizeSettings(newValue), normalizeSettings(oldValue));
  });
}
