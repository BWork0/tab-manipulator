import type { DomainErrorCode, RotationDirection, TabDescriptor } from './types';

export type RandomSource = () => number;

export interface SelectNextRotationTargetInput {
  /** Reconciled eligible targets. Input order is not trusted; current browser indices decide order. */
  targets: readonly TabDescriptor[];
  direction: RotationDirection;
  /** The browser index selected by the preceding successful rotation tick. */
  cursor: number;
  /** Identifies the preceding target across tab reordering when it is still eligible. */
  currentTargetKey?: TabDescriptor['key'];
}

export type RotationStopReason = Extract<DomainErrorCode, 'insufficient-targets'>;

export type RotationTargetSelection =
  | {
      status: 'selected';
      target: TabDescriptor;
      /** Persist this current browser index as the next session cursor. */
      cursor: number;
    }
  | {
      status: 'stop';
      reason: RotationStopReason;
    };

/**
 * Selects one target for a due rotation tick without mutating the target snapshot. The caller may
 * inject its random source so random mode remains deterministic in tests.
 */
export function selectNextRotationTarget(
  input: SelectNextRotationTargetInput,
  random: RandomSource = Math.random,
): RotationTargetSelection {
  const targets = orderByCurrentIndex(input.targets);

  if (targets.length < 2) {
    return { status: 'stop', reason: 'insufficient-targets' };
  }

  const currentTarget = resolveCurrentTarget(targets, input.currentTargetKey, input.cursor);

  if (input.direction === 'random') {
    const candidates = currentTarget
      ? targets.filter(({ key }) => key !== currentTarget.key)
      : targets;
    const target = candidates[randomIndex(random(), candidates.length)];

    if (!target) {
      return { status: 'stop', reason: 'insufficient-targets' };
    }

    return selected(target);
  }

  const effectiveCursor = currentTarget?.index ?? input.cursor;
  const target =
    input.direction === 'forward'
      ? (targets.find(({ index }) => index > effectiveCursor) ?? targets[0])
      : (findLastBefore(targets, effectiveCursor) ?? targets[targets.length - 1]);

  if (!target) {
    return { status: 'stop', reason: 'insufficient-targets' };
  }

  return selected(target);
}

function orderByCurrentIndex(targets: readonly TabDescriptor[]): TabDescriptor[] {
  return targets
    .map((target, inputOrder) => ({ inputOrder, target }))
    .sort(
      (left, right) => left.target.index - right.target.index || left.inputOrder - right.inputOrder,
    )
    .map(({ target }) => target);
}

function resolveCurrentTarget(
  targets: readonly TabDescriptor[],
  currentTargetKey: TabDescriptor['key'] | undefined,
  cursor: number,
): TabDescriptor | undefined {
  if (currentTargetKey !== undefined) {
    return targets.find(({ key }) => key === currentTargetKey);
  }

  return targets.find(({ index }) => index === cursor);
}

function findLastBefore(
  targets: readonly TabDescriptor[],
  cursor: number,
): TabDescriptor | undefined {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];

    if (target && target.index < cursor) {
      return target;
    }
  }

  return undefined;
}

function randomIndex(value: number, length: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return length - 1;
  }

  return Math.floor(value * length);
}

function selected(target: TabDescriptor): RotationTargetSelection {
  return { status: 'selected', target, cursor: target.index };
}
