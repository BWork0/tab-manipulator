import { MIN_REFRESH_INTERVAL_MS, MIN_ROTATION_INTERVAL_MS } from '@/core/defaults';
import type { RotationDirection } from '@/core/types';

function validatedIntervalMs(value: unknown, minimumMs: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimumMs ? (value as number) : null;
}

/** Returns a valid rotation interval or null for a malformed or too-small value. */
export function validateRotationIntervalMs(value: unknown): number | null {
  return validatedIntervalMs(value, MIN_ROTATION_INTERVAL_MS);
}

/** Returns a valid refresh interval or null for a malformed or too-small value. */
export function validateRefreshIntervalMs(value: unknown): number | null {
  return validatedIntervalMs(value, MIN_REFRESH_INTERVAL_MS);
}

/** Converts a numeric seconds input to an exact millisecond value. */
export function intervalSecondsToMs(value: string): number | null {
  if (value.trim() === '') {
    return null;
  }

  const seconds = Number(value);
  const intervalMs = seconds * 1_000;
  return Number.isFinite(seconds) && Number.isSafeInteger(intervalMs) ? intervalMs : null;
}

export function isRotationDirection(value: unknown): value is RotationDirection {
  return value === 'forward' || value === 'backward' || value === 'random';
}
