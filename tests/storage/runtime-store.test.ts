import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_ROTATION_INTERVAL_MS } from '@/core/defaults';
import {
  RUNTIME_SCHEMA_VERSION,
  type RefreshSchedule,
  type RotationSession,
  type TabDescriptor,
} from '@/core/types';
import {
  CORRUPT_REFRESH_RUNTIME_STORAGE_KEY,
  CORRUPT_ROTATION_RUNTIME_STORAGE_KEY,
  REFRESH_RUNTIME_STORAGE_KEY,
  ROTATION_RUNTIME_STORAGE_KEY,
  clearRefreshSchedule,
  clearRotationSession,
  getRefreshSchedule,
  getRotationSession,
  setRefreshSchedule,
  setRotationSession,
  updateRefreshSchedule,
  updateRotationSession,
} from '@/storage/runtime-store';
import { browser } from 'wxt/browser';
import { describe, expect, it, vi } from 'vitest';

const storageKey = (key: `local:${string}`): string => key.slice('local:'.length);

const ROTATION_KEY = storageKey(ROTATION_RUNTIME_STORAGE_KEY);
const REFRESH_KEY = storageKey(REFRESH_RUNTIME_STORAGE_KEY);
const CORRUPT_ROTATION_KEY = storageKey(CORRUPT_ROTATION_RUNTIME_STORAGE_KEY);
const CORRUPT_REFRESH_KEY = storageKey(CORRUPT_REFRESH_RUNTIME_STORAGE_KEY);

function target(overrides: Partial<TabDescriptor> = {}): TabDescriptor {
  return {
    key: 'target-1',
    tabId: 11,
    windowId: 3,
    url: 'https://dashboard.example/status',
    title: 'Dashboard',
    index: 0,
    pinned: false,
    ...overrides,
  };
}

function rotation(overrides: Partial<RotationSession> = {}): RotationSession {
  const session: RotationSession = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: 'rotation-1',
    state: 'running',
    targets: [target(), target({ key: 'target-2', tabId: 12, index: 1 })],
    sourceWindowId: 3,
    intervalMs: DEFAULT_ROTATION_INTERVAL_MS,
    direction: 'forward',
    cursor: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    nextRunAt: 11_000,
  };

  return { ...session, ...overrides } as RotationSession;
}

function refresh(overrides: Partial<RefreshSchedule> = {}): RefreshSchedule {
  const schedule: RefreshSchedule = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: 'refresh-1',
    state: 'running',
    targets: [target()],
    sourceWindowId: 3,
    intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    createdAt: 1_000,
    updatedAt: 1_000,
    nextRunAt: 301_000,
  };

  return { ...schedule, ...overrides } as RefreshSchedule;
}

describe.sequential('runtime schedule store', () => {
  it('keeps rotation and refresh records separate', async () => {
    const rotationSession = rotation();
    const refreshSchedule = refresh();

    await Promise.all([setRotationSession(rotationSession), setRefreshSchedule(refreshSchedule)]);

    await expect(getRotationSession()).resolves.toEqual(rotationSession);
    await expect(getRefreshSchedule()).resolves.toEqual(refreshSchedule);
  });

  it('persists lifecycle transitions and serializes concurrent rotation updates', async () => {
    await setRotationSession(rotation());

    const paused = await updateRotationSession((current) => {
      expect(current?.state).toBe('running');
      const { attentionReason: _attentionReason, nextRunAt: _nextRunAt, ...session } = current!;
      return {
        ...session,
        state: 'paused',
        updatedAt: 2_000,
      };
    });

    expect(paused).toMatchObject({ state: 'paused', cursor: 0, updatedAt: 2_000 });

    await Promise.all([
      updateRotationSession(async (current) => {
        await Promise.resolve();
        return { ...current!, cursor: 1, updatedAt: 3_000 };
      }),
      updateRotationSession((current) => ({
        ...current!,
        cursor: current!.cursor + 1,
        updatedAt: 4_000,
      })),
    ]);

    await expect(getRotationSession()).resolves.toMatchObject({
      state: 'paused',
      cursor: 2,
      updatedAt: 4_000,
    });
  });

  it('supports refresh lifecycle transitions and update-to-clear', async () => {
    await setRefreshSchedule(refresh());

    const attention = await updateRefreshSchedule((current) => {
      const { attentionReason: _attentionReason, nextRunAt: _nextRunAt, ...schedule } = current!;
      return {
        ...schedule,
        state: 'needs-attention',
        attentionReason: 'browser-operation-failed',
        updatedAt: 2_000,
      };
    });

    expect(attention).toMatchObject({
      state: 'needs-attention',
      attentionReason: 'browser-operation-failed',
    });
    await expect(updateRefreshSchedule(() => null)).resolves.toBeNull();
    await expect(getRefreshSchedule()).resolves.toBeNull();
  });

  it('uses persisted records as the source of truth after module reinitialization', async () => {
    const expectedRotation = await setRotationSession(
      rotation({ state: 'paused', nextRunAt: undefined, updatedAt: 2_000 }),
    );
    const expectedRefresh = await setRefreshSchedule(refresh({ nextRunAt: 302_000 }));

    vi.resetModules();
    const reloadedStore = await import('@/storage/runtime-store');

    await expect(reloadedStore.getRotationSession()).resolves.toEqual(expectedRotation);
    await expect(reloadedStore.getRefreshSchedule()).resolves.toEqual(expectedRefresh);
  });

  it.each([
    ['invalid interval', { intervalMs: 9_999 }],
    ['invalid timestamp', { updatedAt: -1 }],
    ['invalid state', { state: 'sleeping' }],
    ['contradictory state fields', { state: 'paused', nextRunAt: 20_000 }],
    ['invalid target descriptor', { targets: [target({ url: 'not a URL' })] }],
  ])('preserves and repairs corrupt rotation data with an %s', async (_name, corruption) => {
    const raw = { ...rotation(), ...corruption };
    await browser.storage.local.set({ [ROTATION_KEY]: raw });

    const repaired = await getRotationSession();

    expect(repaired).toEqual({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id: 'invalid-rotation-runtime-record',
      state: 'needs-attention',
      targets: [],
      sourceWindowId: 0,
      intervalMs: DEFAULT_ROTATION_INTERVAL_MS,
      createdAt: 0,
      updatedAt: 0,
      attentionReason: 'corrupt-stored-data',
      direction: 'forward',
      cursor: 0,
    });
    await expect(browser.storage.local.get([ROTATION_KEY, CORRUPT_ROTATION_KEY])).resolves.toEqual({
      [ROTATION_KEY]: repaired,
      [CORRUPT_ROTATION_KEY]: raw,
    });
  });

  it('distinguishes and preserves an unknown refresh schema before entering attention state', async () => {
    const raw = { ...refresh(), schemaVersion: 2 };
    await browser.storage.local.set({ [REFRESH_KEY]: raw });

    const repaired = await getRefreshSchedule();

    expect(repaired).toEqual({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id: 'invalid-refresh-runtime-record',
      state: 'needs-attention',
      targets: [],
      sourceWindowId: 0,
      intervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      createdAt: 0,
      updatedAt: 0,
      attentionReason: 'unsupported-schema-version',
    });
    await expect(browser.storage.local.get([REFRESH_KEY, CORRUPT_REFRESH_KEY])).resolves.toEqual({
      [REFRESH_KEY]: repaired,
      [CORRUPT_REFRESH_KEY]: raw,
    });
  });

  it('enforces the refresh-specific interval minimum on read', async () => {
    const raw = { ...refresh(), intervalMs: 29_999 };
    await browser.storage.local.set({ [REFRESH_KEY]: raw });

    await expect(getRefreshSchedule()).resolves.toMatchObject({
      state: 'needs-attention',
      attentionReason: 'corrupt-stored-data',
    });
    await expect(browser.storage.local.get(CORRUPT_REFRESH_KEY)).resolves.toEqual({
      [CORRUPT_REFRESH_KEY]: raw,
    });
  });

  it('validates nested results and rejects invalid writes without replacing stored state', async () => {
    const original = await setRotationSession(rotation());
    const invalid = rotation({
      lastResult: {
        action: 'rotation',
        completedAt: 2_000,
        targets: [{ targetKey: 'target-1', status: 'success' }],
        counts: { succeeded: 0, skipped: 0, failed: 0, total: 1 },
      },
      updatedAt: 2_000,
    });

    await expect(setRotationSession(invalid)).rejects.toThrow('Invalid rotation runtime record');
    await expect(getRotationSession()).resolves.toEqual(original);
  });

  it('removes target URLs, titles, and preserved corrupt data when schedules are cleared', async () => {
    await setRotationSession(rotation());
    await setRefreshSchedule(refresh());
    await browser.storage.local.set({
      [CORRUPT_ROTATION_KEY]: { url: 'https://old-rotation.example/', title: 'Old rotation' },
      [CORRUPT_REFRESH_KEY]: { url: 'https://old-refresh.example/', title: 'Old refresh' },
    });

    await Promise.all([clearRotationSession(), clearRefreshSchedule()]);

    await expect(
      browser.storage.local.get([
        ROTATION_KEY,
        REFRESH_KEY,
        CORRUPT_ROTATION_KEY,
        CORRUPT_REFRESH_KEY,
      ]),
    ).resolves.toEqual({});
    await expect(getRotationSession()).resolves.toBeNull();
    await expect(getRefreshSchedule()).resolves.toBeNull();
  });
});
