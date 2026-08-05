import { DEFAULT_SETTINGS } from '@/core/defaults';
import { SETTINGS_SCHEMA_VERSION, type Settings } from '@/core/types';
import {
  SETTINGS_STORAGE_KEY,
  readSettings,
  updateSettings,
  watchSettings,
} from '@/storage/settings-store';
import { browser } from 'wxt/browser';
import { describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = SETTINGS_STORAGE_KEY.slice('local:'.length);

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe.sequential('settings store', () => {
  it('returns the documented defaults when settings are missing', async () => {
    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('updates settings atomically and normalizes rule lists', async () => {
    const updated = await updateSettings({
      rotationIntervalMs: 30_000,
      rotationDirection: 'backward',
      refreshIntervalMs: 60_000,
      includePinned: true,
      allowlist: [' Example.COM ', 'example.com'],
      blocklist: ['https://*.ads.example/*'],
    });

    expect(updated).toEqual(
      settings({
        rotationIntervalMs: 30_000,
        rotationDirection: 'backward',
        refreshIntervalMs: 60_000,
        includePinned: true,
        allowlist: ['example.com'],
        blocklist: ['https://*.ads.example/*'],
      }),
    );
    await expect(readSettings()).resolves.toEqual(updated);
  });

  it('repairs corrupt fields without discarding valid fields', async () => {
    await browser.storage.local.set({
      [STORAGE_KEY]: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        rotationIntervalMs: 9_999,
        rotationDirection: 'sideways',
        refreshIntervalMs: Number.NaN,
        includePinned: 'yes',
        allowlist: ['valid.example', 'not a domain'],
        blocklist: [' Blocked.Example ', 'blocked.example'],
      },
    });

    const repaired = await readSettings();

    expect(repaired).toEqual(
      settings({
        blocklist: ['blocked.example'],
      }),
    );
    await expect(browser.storage.local.get(STORAGE_KEY)).resolves.toEqual({
      [STORAGE_KEY]: repaired,
    });
  });

  it('falls back safely for unknown schema versions and malformed updates', async () => {
    await browser.storage.local.set({
      [STORAGE_KEY]: settings({ schemaVersion: 2 as never, includePinned: true }),
    });

    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(updateSettings(null as never)).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(
      updateSettings({
        rotationIntervalMs: -1,
        refreshIntervalMs: 'fast' as never,
        includePinned: 'yes' as never,
        allowlist: ['not a domain'],
      }),
    ).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('survives a simulated background module reload', async () => {
    const expected = await updateSettings({
      rotationDirection: 'random',
      includePinned: true,
      allowlist: ['dashboards.example'],
    });

    vi.resetModules();
    const reloadedStore = await import('@/storage/settings-store');

    await expect(reloadedStore.readSettings()).resolves.toEqual(expected);
  });

  it('watches normalized settings changes and can unsubscribe', async () => {
    const watcher = vi.fn();
    const unwatch = watchSettings(watcher);

    const updated = await updateSettings({ includePinned: true });

    expect(watcher).toHaveBeenCalledWith(updated, DEFAULT_SETTINGS);

    await browser.storage.local.set({
      [STORAGE_KEY]: {
        ...updated,
        rotationIntervalMs: 1,
      },
    });

    expect(watcher).toHaveBeenLastCalledWith(settings({ includePinned: true }), updated);

    unwatch();
    await updateSettings({ rotationDirection: 'backward' });
    expect(watcher).toHaveBeenCalledTimes(2);
  });
});
