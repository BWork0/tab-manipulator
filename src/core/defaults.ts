import { SETTINGS_SCHEMA_VERSION, type RotationDirection, type Settings } from './types';

export const MIN_ROTATION_INTERVAL_MS = 10_000;
export const MIN_REFRESH_INTERVAL_MS = 30_000;

export const DEFAULT_ROTATION_INTERVAL_MS = 30_000;
export const DEFAULT_ROTATION_DIRECTION: RotationDirection = 'forward';
export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_INCLUDE_PINNED = false;
export const DEFAULT_ALLOWLIST = Object.freeze([]) as readonly string[];
export const DEFAULT_BLOCKLIST = Object.freeze([]) as readonly string[];

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  rotationIntervalMs: DEFAULT_ROTATION_INTERVAL_MS,
  rotationDirection: DEFAULT_ROTATION_DIRECTION,
  refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
  includePinned: DEFAULT_INCLUDE_PINNED,
  allowlist: DEFAULT_ALLOWLIST,
  blocklist: DEFAULT_BLOCKLIST,
}) satisfies Readonly<Settings>;
