import type { z } from 'zod';

import {
  AssurancePlanSchema,
  AssuranceProfileSchema,
  MutationReportSchema,
} from './assurance.js';
import { ChangeContextSchema, ChangeImpactSchema } from './change.js';
import { SUPPORTED_SCHEMA_VERSION } from './common.js';
import {
  CraftsmanshipPrincipleSchema,
  PracticeStatementSchema,
} from './knowledge.js';
import { MutationBaselineSchema } from './mutation-baseline.js';
import { ProjectProfileSchema } from './project.js';
import { ProjectRuleSchema } from './rules.js';

/** Every serialized artifact kind supported by the first vertical slice. */
export const ARTIFACT_KINDS = [
  'craftsmanship_principle',
  'practice_statement',
  'project_profile',
  'change_context',
  'change_impact',
  'project_rule',
  'assurance_profile',
  'assurance_plan',
  'mutation_report',
  'mutation_baseline',
] as const;

/** Discriminator for a supported CraftCompass artifact. */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Union of all version-one CraftCompass artifacts. */
export type CraftArtifact =
  | z.infer<typeof CraftsmanshipPrincipleSchema>
  | z.infer<typeof PracticeStatementSchema>
  | z.infer<typeof ProjectProfileSchema>
  | z.infer<typeof ChangeContextSchema>
  | z.infer<typeof ChangeImpactSchema>
  | z.infer<typeof ProjectRuleSchema>
  | z.infer<typeof AssuranceProfileSchema>
  | z.infer<typeof AssurancePlanSchema>
  | z.infer<typeof MutationReportSchema>
  | z.infer<typeof MutationBaselineSchema>;

/** One actionable domain validation problem. */
export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Optional deterministic context for semantic validation. */
export interface ValidationOptions {
  readonly now?: Date;
  /**
   * Preserve structurally valid expired exceptions for a consumer that makes
   * the expiry decision itself. The default validation boundary rejects them.
   */
  readonly preserveExpiredExceptions?: boolean;
}

/** Result of validating an unknown serialized artifact value. */
export type ArtifactValidationResult =
  | {
      readonly success: true;
      readonly artifact: CraftArtifact;
    }
  | {
      readonly success: false;
      readonly issues: readonly ValidationIssue[];
    };

/** Error thrown by `parseArtifact` when the artifact contract is violated. */
export class ArtifactValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('CraftCompass artifact validation failed');
    this.name = 'ArtifactValidationError';
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

const MAX_ARTIFACT_COLLECTION_ITEMS = 100_000;
const MAX_ARTIFACT_OBJECT_PROPERTIES = 256;
const MAX_ARTIFACT_NESTING_DEPTH = 64;
const MAX_ARTIFACT_VALUE_NODES = 5_000_000;
const MAX_ARTIFACT_STRING_UNITS = 1024 * 1024;
const MAX_ARTIFACT_TOTAL_STRING_UNITS = 32 * 1024 * 1024;

type ArtifactInputFailureKind =
  'invalid_artifact_input' | 'input_limit_exceeded';

class ArtifactInputBoundaryError extends Error {
  constructor(
    readonly kind: ArtifactInputFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactInputBoundaryError';
  }
}

interface PendingArtifactValue {
  readonly value: unknown;
  readonly depth: number;
  readonly exiting: boolean;
}

const failArtifactInput = (
  kind: ArtifactInputFailureKind,
  message: string,
): never => {
  throw new ArtifactInputBoundaryError(kind, message);
};

/**
 * Bounds and inspects public in-memory input without evaluating accessors.
 *
 * CLI files have tighter byte/traversal limits, but the domain API also accepts
 * unknown JavaScript values and therefore needs its own total boundary.
 */
const assertBoundedArtifactInput = (input: unknown): void => {
  const pending: PendingArtifactValue[] = [
    { value: input, depth: 0, exiting: false },
  ];
  const active = new WeakSet<object>();
  let scheduledNodes = 1;
  let totalStringUnits = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      failArtifactInput(
        'invalid_artifact_input',
        'Artifact input traversal became inconsistent',
      );
    }
    const { value, depth, exiting } = current as PendingArtifactValue;
    if (typeof value === 'string') {
      if (value.length > MAX_ARTIFACT_STRING_UNITS) {
        failArtifactInput(
          'input_limit_exceeded',
          'Artifact input contains an oversized string',
        );
      }
      totalStringUnits += value.length;
      if (totalStringUnits > MAX_ARTIFACT_TOTAL_STRING_UNITS) {
        failArtifactInput(
          'input_limit_exceeded',
          'Artifact input exceeds the aggregate string limit',
        );
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
      failArtifactInput(
        'invalid_artifact_input',
        'Artifact input must contain only serializable data values',
      );
    }
    if (exiting) {
      active.delete(value);
      continue;
    }
    if (active.has(value)) {
      failArtifactInput(
        'invalid_artifact_input',
        'Artifact input must not contain cyclic values',
      );
    }
    if (depth >= MAX_ARTIFACT_NESTING_DEPTH) {
      failArtifactInput(
        'input_limit_exceeded',
        'Artifact input exceeds the nesting-depth limit',
      );
    }
    active.add(value);
    pending.push({ value, depth, exiting: true });

    if (Array.isArray(value)) {
      if (value.length > MAX_ARTIFACT_COLLECTION_ITEMS) {
        failArtifactInput(
          'input_limit_exceeded',
          'Artifact input collection exceeds the item-count limit',
        );
      }
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        failArtifactInput(
          'invalid_artifact_input',
          'Artifact input must contain only plain data arrays',
        );
      }
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
        ) {
          failArtifactInput(
            'invalid_artifact_input',
            'Artifact input arrays must not contain custom properties',
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          failArtifactInput(
            'invalid_artifact_input',
            'Artifact input arrays must contain only data properties',
          );
        }
      }
      scheduledNodes += value.length;
      if (scheduledNodes > MAX_ARTIFACT_VALUE_NODES) {
        failArtifactInput(
          'input_limit_exceeded',
          'Artifact input exceeds the value-node limit',
        );
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !('value' in descriptor)) {
          failArtifactInput(
            'invalid_artifact_input',
            'Artifact input arrays must not be sparse',
          );
        }
        const valueDescriptor = descriptor as PropertyDescriptor & {
          readonly value: unknown;
        };
        pending.push({
          value: valueDescriptor.value,
          depth: depth + 1,
          exiting: false,
        });
      }
      continue;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      failArtifactInput(
        'invalid_artifact_input',
        'Artifact input must contain only plain data objects',
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_ARTIFACT_OBJECT_PROPERTIES) {
      failArtifactInput(
        'input_limit_exceeded',
        'Artifact input object exceeds the property-count limit',
      );
    }
    scheduledNodes += keys.length;
    if (scheduledNodes > MAX_ARTIFACT_VALUE_NODES) {
      failArtifactInput(
        'input_limit_exceeded',
        'Artifact input exceeds the value-node limit',
      );
    }
    for (const rawKey of keys) {
      if (typeof rawKey !== 'string') {
        failArtifactInput(
          'invalid_artifact_input',
          'Artifact input must not contain symbol properties',
        );
      }
      const key = rawKey as string;
      totalStringUnits += key.length;
      if (
        key.length > MAX_ARTIFACT_STRING_UNITS ||
        totalStringUnits > MAX_ARTIFACT_TOTAL_STRING_UNITS
      ) {
        failArtifactInput(
          'input_limit_exceeded',
          'Artifact input exceeds the string limit',
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        failArtifactInput(
          'invalid_artifact_input',
          'Artifact input must not contain accessor properties',
        );
      }
      const valueDescriptor = descriptor as PropertyDescriptor & {
        readonly value: unknown;
      };
      pending.push({
        value: valueDescriptor.value,
        depth: depth + 1,
        exiting: false,
      });
    }
  }
};

const dataProperty = (input: UnknownRecord, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

const displayDiscriminator = (value: unknown): string => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  ) {
    return value === undefined ? 'undefined' : JSON.stringify(value);
  }
  return `<${typeof value}>`;
};

const isArtifactKind = (input: string): input is ArtifactKind =>
  (ARTIFACT_KINDS as readonly string[]).includes(input);

const schemaByKind: Record<ArtifactKind, z.ZodType> = {
  craftsmanship_principle: CraftsmanshipPrincipleSchema,
  practice_statement: PracticeStatementSchema,
  project_profile: ProjectProfileSchema,
  change_context: ChangeContextSchema,
  change_impact: ChangeImpactSchema,
  project_rule: ProjectRuleSchema,
  assurance_profile: AssuranceProfileSchema,
  assurance_plan: AssurancePlanSchema,
  mutation_report: MutationReportSchema,
  mutation_baseline: MutationBaselineSchema,
};

const formatPath = (path: readonly PropertyKey[]): string => {
  if (path.length === 0) {
    return '$';
  }
  return path.reduce<string>((rendered, segment) => {
    if (typeof segment === 'number') {
      return `${rendered}[${segment}]`;
    }
    return `${rendered}.${String(segment)}`;
  }, '$');
};

const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10);

const findExpiredExceptions = (
  artifact: CraftArtifact,
  now: Date,
): ValidationIssue[] => {
  const policy =
    artifact.kind === 'project_rule'
      ? artifact.exceptions
      : artifact.kind === 'assurance_profile'
        ? artifact.exception_policy
        : undefined;
  if (policy === undefined) {
    return [];
  }

  const today = toDateOnly(now);
  const basePath =
    artifact.kind === 'project_rule' ? '$.exceptions' : '$.exception_policy';
  return policy.active_exceptions.flatMap((exception, index) =>
    exception.expires_on < today
      ? [
          {
            code: 'expired_exception',
            path: `${basePath}.active_exceptions[${index}].expires_on`,
            message: `Exception ${exception.id} expired on ${exception.expires_on}`,
          },
        ]
      : [],
  );
};

const findFutureBaselineDates = (
  artifact: CraftArtifact,
  now: Date,
): ValidationIssue[] => {
  if (artifact.kind !== 'mutation_baseline') {
    return [];
  }
  const issues: ValidationIssue[] = [];
  if (Date.parse(artifact.created_at) > now.getTime()) {
    issues.push({
      code: 'future_baseline_creation',
      path: '$.created_at',
      message: `Mutation baseline creation time ${artifact.created_at} is in the future`,
    });
  }
  const today = toDateOnly(now);
  if (
    artifact.activation !== undefined &&
    artifact.activation.reviewed_on > today
  ) {
    issues.push({
      code: 'future_baseline_activation',
      path: '$.activation.reviewed_on',
      message: `Mutation baseline review date ${artifact.activation.reviewed_on} is in the future`,
    });
  }
  return issues;
};

/**
 * Detects and validates a serialized artifact without filesystem or YAML access.
 */
export const validateArtifact = (
  input: unknown,
  options: ValidationOptions = {},
): ArtifactValidationResult => {
  try {
    assertBoundedArtifactInput(input);
  } catch (error) {
    const boundary =
      error instanceof ArtifactInputBoundaryError ? error : undefined;
    return {
      success: false,
      issues: [
        {
          code: boundary?.kind ?? 'invalid_artifact_input',
          path: '$',
          message:
            boundary?.message ?? 'Artifact input could not be inspected safely',
        },
      ],
    };
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      success: false,
      issues: [
        {
          code: 'invalid_artifact',
          path: '$',
          message: 'Expected an artifact mapping/object',
        },
      ],
    };
  }
  const record = input as UnknownRecord;
  const schemaVersion = dataProperty(record, 'schema_version');
  const kind = dataProperty(record, 'kind');

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      success: false,
      issues: [
        {
          code: 'unsupported_schema_version',
          path: '$.schema_version',
          message: `Unsupported schema version ${displayDiscriminator(schemaVersion)}; supported version is ${SUPPORTED_SCHEMA_VERSION}`,
        },
      ],
    };
  }

  if (typeof kind !== 'string' || !isArtifactKind(kind)) {
    return {
      success: false,
      issues: [
        {
          code: 'unsupported_artifact_kind',
          path: '$.kind',
          message: `Unsupported artifact kind ${displayDiscriminator(kind)}; expected one of ${ARTIFACT_KINDS.join(', ')}`,
        },
      ],
    };
  }

  let parsed;
  try {
    parsed = schemaByKind[kind].safeParse(input);
  } catch {
    return {
      success: false,
      issues: [
        {
          code: 'invalid_artifact_input',
          path: '$',
          message: 'Artifact input could not be validated safely',
        },
      ],
    };
  }
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const artifact = parsed.data as CraftArtifact;
  let now: Date;
  try {
    const requestedNow = options.now ?? new Date();
    const timestamp = Date.prototype.getTime.call(requestedNow);
    if (Number.isNaN(timestamp)) {
      throw new TypeError('Invalid date');
    }
    now = new Date(timestamp);
  } catch {
    return {
      success: false,
      issues: [
        {
          code: 'invalid_validation_time',
          path: '$',
          message: 'Validation time must be a valid Date',
        },
      ],
    };
  }
  const semanticIssues = [
    ...(options.preserveExpiredExceptions === true
      ? []
      : findExpiredExceptions(artifact, now)),
    ...findFutureBaselineDates(artifact, now),
  ];
  if (semanticIssues.length > 0) {
    return {
      success: false,
      issues: semanticIssues,
    };
  }

  return {
    success: true,
    artifact,
  };
};

/** Validates an artifact and throws one structured error on failure. */
export const parseArtifact = (
  input: unknown,
  options: ValidationOptions = {},
): CraftArtifact => {
  const result = validateArtifact(input, options);
  if (!result.success) {
    throw new ArtifactValidationError(result.issues);
  }
  return result.artifact;
};
