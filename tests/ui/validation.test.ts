import {
  intervalSecondsToMs,
  isRotationDirection,
  validateRefreshIntervalMs,
  validateRotationIntervalMs,
} from '@/ui/validation';
import { describe, expect, it } from 'vitest';

describe('shared UI validation', () => {
  it('enforces the popup and options rotation minimum', () => {
    expect(validateRotationIntervalMs(9_999)).toBeNull();
    expect(validateRotationIntervalMs(10_000)).toBe(10_000);
    expect(validateRotationIntervalMs(10_000.5)).toBeNull();
    expect(validateRotationIntervalMs(Number.NaN)).toBeNull();
  });

  it('enforces the popup and options refresh minimum', () => {
    expect(validateRefreshIntervalMs(29_999)).toBeNull();
    expect(validateRefreshIntervalMs(30_000)).toBe(30_000);
    expect(validateRefreshIntervalMs(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('converts complete seconds values and validates directions', () => {
    expect(intervalSecondsToMs('')).toBeNull();
    expect(intervalSecondsToMs('10')).toBe(10_000);
    expect(intervalSecondsToMs('10.5')).toBe(10_500);
    expect(intervalSecondsToMs('not-a-number')).toBeNull();
    expect(isRotationDirection('forward')).toBe(true);
    expect(isRotationDirection('sideways')).toBe(false);
  });
});
