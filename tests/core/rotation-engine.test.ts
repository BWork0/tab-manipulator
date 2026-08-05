import {
  selectNextRotationTarget,
  type RandomSource,
  type RotationTargetSelection,
} from '@/core/rotation-engine';
import type { RotationDirection, TabDescriptor } from '@/core/types';
import { describe, expect, it, vi } from 'vitest';

function target(key: string, index: number): TabDescriptor {
  return {
    key,
    tabId: index + 10,
    windowId: 3,
    url: `https://${key}.test/`,
    index,
    pinned: false,
  };
}

function select(
  targets: readonly TabDescriptor[],
  direction: RotationDirection,
  cursor: number,
  currentTargetKey?: string,
  random?: RandomSource,
): RotationTargetSelection {
  return selectNextRotationTarget({ targets, direction, cursor, currentTargetKey }, random);
}

function selectedTarget(result: RotationTargetSelection): TabDescriptor {
  if (result.status !== 'selected') {
    throw new Error(`Expected a selected target, received ${result.reason}.`);
  }

  return result.target;
}

describe('rotation next-target selection', () => {
  const targets = [target('first', 2), target('second', 7), target('third', 10)];

  it('selects the next current index in forward mode', () => {
    expect(select(targets, 'forward', 2)).toEqual({
      status: 'selected',
      target: targets[1],
      cursor: 7,
    });
  });

  it('wraps from the final current index in forward mode', () => {
    expect(select(targets, 'forward', 10)).toEqual({
      status: 'selected',
      target: targets[0],
      cursor: 2,
    });
  });

  it('selects the preceding current index in backward mode', () => {
    expect(select(targets, 'backward', 10)).toEqual({
      status: 'selected',
      target: targets[1],
      cursor: 7,
    });
  });

  it('wraps from the first current index in backward mode', () => {
    expect(select(targets, 'backward', 2)).toEqual({
      status: 'selected',
      target: targets[2],
      cursor: 10,
    });
  });

  it('orders targets by their current indices without mutating the snapshot', () => {
    const unordered = [target('third', 10), target('first', 2), target('second', 7)];

    expect(select(unordered, 'forward', 2)).toEqual({
      status: 'selected',
      target: unordered[2],
      cursor: 7,
    });
    expect(unordered.map(({ key }) => key)).toEqual(['third', 'first', 'second']);
  });

  it('follows the same logical cursor target after tabs are reordered', () => {
    const reordered = [target('second', 1), target('third', 5), target('first', 9)];

    expect(select(reordered, 'forward', 2, 'first')).toEqual({
      status: 'selected',
      target: reordered[0],
      cursor: 1,
    });
    expect(select(reordered, 'backward', 2, 'first')).toEqual({
      status: 'selected',
      target: reordered[1],
      cursor: 5,
    });
  });

  it('uses the stored index as a deterministic boundary after the cursor target is removed', () => {
    const remaining = [target('before', 1), target('after', 5)];

    expect(select(remaining, 'forward', 3, 'removed')).toEqual({
      status: 'selected',
      target: remaining[1],
      cursor: 5,
    });
    expect(select(remaining, 'backward', 3, 'removed')).toEqual({
      status: 'selected',
      target: remaining[0],
      cursor: 1,
    });
  });

  it('injects random selection and never immediately repeats the current target', () => {
    const random = vi.fn<RandomSource>().mockReturnValue(0.99);

    expect(select(targets, 'random', 7, 'second', random)).toEqual({
      status: 'selected',
      target: targets[2],
      cursor: 10,
    });
    expect(random).toHaveBeenCalledOnce();
  });

  it('uses the cursor index to prevent a random repeat when no key is supplied', () => {
    expect(select(targets, 'random', 7, undefined, () => 0)).toEqual({
      status: 'selected',
      target: targets[0],
      cursor: 2,
    });
  });

  it('makes every alternative reachable through the injected random source', () => {
    expect(selectedTarget(select(targets, 'random', 7, 'second', () => 0))).toBe(targets[0]);
    expect(selectedTarget(select(targets, 'random', 7, 'second', () => 0.5))).toBe(targets[2]);
  });

  it('stops with a typed reason when fewer than two eligible targets remain', () => {
    for (const insufficientTargets of [[], [target('only', 4)]]) {
      const random = vi.fn<RandomSource>();

      expect(select(insufficientTargets, 'random', 4, 'only', random)).toEqual({
        status: 'stop',
        reason: 'insufficient-targets',
      });
      expect(random).not.toHaveBeenCalled();
    }
  });
});
