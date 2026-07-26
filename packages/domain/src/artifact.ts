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
  | z.infer<typeof MutationReportSchema>;

/** One actionable domain validation problem. */
export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Optional deterministic context for semantic validation. */
export interface ValidationOptions {
  readonly now?: Date;
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

const isUnknownRecord = (input: unknown): input is UnknownRecord =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

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

/**
 * Detects and validates a serialized artifact without filesystem or YAML access.
 */
export const validateArtifact = (
  input: unknown,
  options: ValidationOptions = {},
): ArtifactValidationResult => {
  if (!isUnknownRecord(input)) {
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

  if (input.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return {
      success: false,
      issues: [
        {
          code: 'unsupported_schema_version',
          path: '$.schema_version',
          message: `Unsupported schema version ${String(input.schema_version)}; supported version is ${SUPPORTED_SCHEMA_VERSION}`,
        },
      ],
    };
  }

  if (typeof input.kind !== 'string' || !isArtifactKind(input.kind)) {
    return {
      success: false,
      issues: [
        {
          code: 'unsupported_artifact_kind',
          path: '$.kind',
          message: `Unsupported artifact kind ${String(input.kind)}; expected one of ${ARTIFACT_KINDS.join(', ')}`,
        },
      ],
    };
  }

  const parsed = schemaByKind[input.kind].safeParse(input);
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
  const semanticIssues = findExpiredExceptions(
    artifact,
    options.now ?? new Date(),
  );
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
