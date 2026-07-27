import { Buffer } from 'node:buffer';

import {
  ArtifactIdSchema,
  AssuranceProfileSchema,
  MutationBaselineSchema,
  MutationReportSchema,
  type AssuranceProfile,
  type MutationBaseline,
  type MutationReport,
} from '@craftcompass/domain';

export const MAX_MUTATION_ENGINE_RECORDS = 100_000;

const MAX_COLLECTION_ITEMS = MAX_MUTATION_ENGINE_RECORDS;
const MAX_OBJECT_PROPERTIES = 256;
const MAX_NESTING_DEPTH = 32;
const MAX_VALUE_NODES = 1_000_000;
const MAX_SINGLE_STRING_BYTES = 1024 * 1024;
const MAX_TOTAL_STRING_BYTES = 32 * 1024 * 1024;
const MAX_REPORTED_VALIDATION_ISSUES = 8;

export interface RuntimeValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type RuntimeValidationFailureKind = 'invalid' | 'limit';

export type RuntimeValidationResult<Value> =
  | {
      readonly success: true;
      readonly data: Value;
    }
  | {
      readonly success: false;
      readonly kind: RuntimeValidationFailureKind;
      readonly issues: readonly RuntimeValidationIssue[];
    };

type UnknownRecord = Record<string, unknown>;

class InputBoundaryError extends Error {
  constructor(
    readonly kind: RuntimeValidationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'InputBoundaryError';
  }
}

const failInput = (
  kind: RuntimeValidationFailureKind,
  message: string,
): never => {
  throw new InputBoundaryError(kind, message);
};

const formatPath = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? '$'
    : path.reduce<string>(
        (result, segment) =>
          typeof segment === 'number'
            ? `${result}[${segment}]`
            : `${result}.${String(segment)}`,
        '$',
      );

interface PendingValue {
  readonly value: unknown;
  readonly depth: number;
  readonly exiting: boolean;
}

/**
 * Rejects hostile or unexpectedly large in-memory values before schema
 * validation can recurse, allocate validation issues, or sort collections.
 */
const assertBoundedSerializableInput = (input: unknown): void => {
  const pending: PendingValue[] = [
    {
      value: input,
      depth: 0,
      exiting: false,
    },
  ];
  const active = new WeakSet<object>();
  let scheduledNodes = 1;
  let stringBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      failInput('invalid', 'Input traversal became inconsistent');
    }
    const { value, depth, exiting } = current as PendingValue;

    if (typeof value === 'string') {
      if (value.length > MAX_SINGLE_STRING_BYTES) {
        failInput('limit', 'Input contains an oversized string');
      }
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_SINGLE_STRING_BYTES) {
        failInput('limit', 'Input contains an oversized string');
      }
      stringBytes += bytes;
      if (stringBytes > MAX_TOTAL_STRING_BYTES) {
        failInput('limit', 'Input exceeds the aggregate string-byte limit');
      }
      continue;
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      continue;
    }
    if (typeof value !== 'object') {
      failInput('invalid', 'Input contains a non-serializable value');
    }

    const objectValue = value;
    if (exiting) {
      active.delete(objectValue);
      continue;
    }
    if (active.has(objectValue)) {
      failInput('invalid', 'Input contains a cyclic value');
    }
    if (depth >= MAX_NESTING_DEPTH) {
      failInput('limit', 'Input exceeds the nesting-depth limit');
    }
    active.add(objectValue);
    pending.push({ value, depth, exiting: true });

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        failInput('invalid', 'Input must contain only plain data arrays');
      }
      if (value.length > MAX_COLLECTION_ITEMS) {
        failInput('limit', 'Input collection exceeds the item-count limit');
      }
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
        ) {
          failInput(
            'invalid',
            'Input arrays must not contain custom properties',
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          failInput(
            'invalid',
            'Input arrays must contain only data properties',
          );
        }
      }
      scheduledNodes += value.length;
      if (scheduledNodes > MAX_VALUE_NODES) {
        failInput('limit', 'Input exceeds the value-node limit');
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !('value' in descriptor)) {
          failInput('invalid', 'Input arrays must not be sparse');
        }
        const dataDescriptor = descriptor as PropertyDescriptor & {
          readonly value: unknown;
        };
        pending.push({
          value: dataDescriptor.value,
          depth: depth + 1,
          exiting: false,
        });
      }
      continue;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      failInput('invalid', 'Input must contain only plain data objects');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_OBJECT_PROPERTIES) {
      failInput('limit', 'Input object exceeds the property-count limit');
    }
    scheduledNodes += keys.length;
    if (scheduledNodes > MAX_VALUE_NODES) {
      failInput('limit', 'Input exceeds the value-node limit');
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const rawKey = keys[index];
      if (typeof rawKey !== 'string') {
        failInput('invalid', 'Input must not contain symbol properties');
      }
      const key = rawKey as string;
      const keyBytes = Buffer.byteLength(key, 'utf8');
      if (keyBytes > MAX_SINGLE_STRING_BYTES) {
        failInput('limit', 'Input contains an oversized property name');
      }
      stringBytes += keyBytes;
      if (stringBytes > MAX_TOTAL_STRING_BYTES) {
        failInput('limit', 'Input exceeds the aggregate string-byte limit');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        failInput('invalid', 'Input must not contain accessor properties');
      }
      const dataDescriptor = descriptor as PropertyDescriptor & {
        readonly value: unknown;
      };
      pending.push({
        value: dataDescriptor.value,
        depth: depth + 1,
        exiting: false,
      });
    }
  }
};

interface RuntimeSchema<Value> {
  safeParse(input: unknown):
    | {
        readonly success: true;
        readonly data: Value;
      }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly path: readonly PropertyKey[];
            readonly message: string;
          }[];
        };
      };
}

const parseBounded = <Value>(
  input: unknown,
  schema: RuntimeSchema<Value>,
): RuntimeValidationResult<Value> => {
  try {
    assertBoundedSerializableInput(input);
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      return parsed;
    }
    const reported = parsed.error.issues
      .slice(0, MAX_REPORTED_VALIDATION_ISSUES)
      .map((validationIssue) => ({
        path: formatPath(validationIssue.path),
        message: validationIssue.message,
      }));
    if (parsed.error.issues.length > MAX_REPORTED_VALIDATION_ISSUES) {
      reported.push({
        path: '$',
        message: `${parsed.error.issues.length - MAX_REPORTED_VALIDATION_ISSUES} additional validation issue(s) omitted`,
      });
    }
    return {
      success: false,
      kind: 'invalid',
      issues: reported,
    };
  } catch (error) {
    if (error instanceof InputBoundaryError) {
      return {
        success: false,
        kind: error.kind,
        issues: [{ path: '$', message: error.message }],
      };
    }
    return {
      success: false,
      kind: 'invalid',
      issues: [{ path: '$', message: 'Input could not be validated safely' }],
    };
  }
};

export const validateMutationReportInput = (
  input: unknown,
): RuntimeValidationResult<MutationReport> =>
  parseBounded(input, MutationReportSchema);

export const validateMutationBaselineInput = (
  input: unknown,
): RuntimeValidationResult<MutationBaseline> =>
  parseBounded(input, MutationBaselineSchema);

export const validateAssuranceProfileInput = (
  input: unknown,
): RuntimeValidationResult<AssuranceProfile> =>
  parseBounded(input, AssuranceProfileSchema);

export const validateArtifactIdInput = (
  input: unknown,
): RuntimeValidationResult<string> => parseBounded(input, ArtifactIdSchema);

/**
 * Reads a small public request envelope without evaluating accessors or
 * accepting class instances. Nested artifact values are validated separately.
 */
export const readRequestEnvelope = (
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): RuntimeValidationResult<UnknownRecord> => {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      failInput('invalid', 'Request must be a plain object');
    }
    const requestObject = input as object;
    const prototype: unknown = Object.getPrototypeOf(requestObject);
    if (prototype !== Object.prototype && prototype !== null) {
      failInput('invalid', 'Request must be a plain object');
    }
    const keys = Reflect.ownKeys(requestObject);
    if (
      keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
    ) {
      failInput('invalid', 'Request contains an unknown property');
    }
    const result: UnknownRecord = {};
    keys.forEach((rawKey) => {
      if (typeof rawKey !== 'string') {
        failInput('invalid', 'Request must not contain symbol properties');
      }
      const key = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(requestObject, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        failInput('invalid', 'Request must not contain accessor properties');
      }
      const dataDescriptor = descriptor as PropertyDescriptor & {
        readonly value: unknown;
      };
      result[key] = dataDescriptor.value;
    });
    if (requiredKeys.some((key) => !Object.hasOwn(result, key))) {
      failInput('invalid', 'Request is missing a required property');
    }
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    if (error instanceof InputBoundaryError) {
      return {
        success: false,
        kind: error.kind,
        issues: [{ path: '$', message: error.message }],
      };
    }
    return {
      success: false,
      kind: 'invalid',
      issues: [{ path: '$', message: 'Request could not be inspected safely' }],
    };
  }
};

export const artifactIdOrFallback = (
  input: unknown,
  fallback: string,
): string => {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fallback;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, 'id');
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 1024
    ) {
      return fallback;
    }
    const parsed = ArtifactIdSchema.safeParse(descriptor.value);
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
};
