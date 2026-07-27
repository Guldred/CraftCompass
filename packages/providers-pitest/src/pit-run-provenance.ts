import type { PitMutationRun } from './types.js';

const parsedRuns = new WeakSet<object>();

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (!isObject(value) || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    deepFreeze(Reflect.get(value, key), seen);
  });
  Object.freeze(value);
  return value;
};

/**
 * Marks one completed parser result as authentic after making the full object
 * graph immutable. This module is intentionally not part of the package API.
 */
export const registerParsedPitRun = (run: PitMutationRun): PitMutationRun => {
  const immutableRun = deepFreeze(run);
  parsedRuns.add(immutableRun);
  return immutableRun;
};

/** Checks object identity against runs created by this module instance. */
export const isParsedPitRun = (value: unknown): value is PitMutationRun =>
  isObject(value) && parsedRuns.has(value) && Object.isFrozen(value);
