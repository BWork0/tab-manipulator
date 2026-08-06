import { createPopupOperationGate } from '@/entrypoints/popup/operation-gate';
import { describe, expect, it, vi } from 'vitest';

describe('popup operation gate', () => {
  it('allows one pending operation and notifies every command-control subscriber', () => {
    const gate = createPopupOperationGate();
    const firstSubscriber = vi.fn();
    const secondSubscriber = vi.fn();
    gate.subscribe(firstSubscriber);
    gate.subscribe(secondSubscriber);

    const release = gate.tryAcquire();

    expect(release).not.toBeNull();
    expect(gate.isPending()).toBe(true);
    expect(gate.tryAcquire()).toBeNull();
    expect(firstSubscriber).toHaveBeenLastCalledWith(true);
    expect(secondSubscriber).toHaveBeenLastCalledWith(true);

    release?.();
    release?.();
    expect(gate.isPending()).toBe(false);
    expect(firstSubscriber).toHaveBeenLastCalledWith(false);
    expect(secondSubscriber).toHaveBeenLastCalledWith(false);
    expect(firstSubscriber).toHaveBeenCalledTimes(2);
  });
});
