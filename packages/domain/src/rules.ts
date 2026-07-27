import { z } from 'zod';

import {
  ArtifactIdSchema,
  ConfidenceSchema,
  EvidenceReferenceListSchema,
  IsoDateSchema,
  NonEmptyStringSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueArtifactIdListSchema,
  UniqueStringListSchema,
} from './common.js';
import { duplicateIndexesBy } from './schema-helpers.js';

/** Contextual outcome of adapting a principle to a specific project. */
export const RuleLevelSchema = z.enum([
  'mandatory',
  'recommended',
  'contextual',
  'aspirational',
  'not_applicable',
  'requires_decision',
]);

/** A rule's contextual force; it is not inherited automatically from a source. */
export type RuleLevel = z.infer<typeof RuleLevelSchema>;

/** The code and debt boundary to which a project rule applies. */
export const RuleScopeSchema = z.strictObject({
  change_types: z
    .array(z.enum(['new_code', 'modified_code', 'existing_code']))
    .min(1),
  include: UniqueStringListSchema.min(1),
  exclude: UniqueStringListSchema,
  existing_violations: z.enum(['forbidden', 'baseline', 'allowed']),
});

/** Explicit applicability boundary for a project-specific rule. */
export type RuleScope = z.infer<typeof RuleScopeSchema>;

/** One deterministic or judgment-based way to enforce a rule. */
export const EnforcementConfigurationSchema = z.strictObject({
  mechanism: z.enum([
    'deterministic_check',
    'ai_review',
    'human_review',
    'documentation',
  ]),
  blocking: z.boolean(),
  description: NonEmptyStringSchema,
  authorization_decision_ref: ArtifactIdSchema.optional(),
  configuration: z.record(z.string(), NonEmptyStringSchema).optional(),
});

/** Provider-neutral enforcement intent; adapters decide how to realize it. */
export type EnforcementConfiguration = z.infer<
  typeof EnforcementConfigurationSchema
>;

/** An incremental path from current state toward a rule. */
export const MigrationStrategySchema = z.strictObject({
  approach: z.enum([
    'immediate',
    'baseline_and_ratcheting',
    'phased',
    'advisory',
  ]),
  rationale: NonEmptyStringSchema,
  steps: UniqueStringListSchema.min(1),
  target_date: IsoDateSchema.optional(),
});

/** A documented, proportionate rule-adoption strategy. */
export type MigrationStrategy = z.infer<typeof MigrationStrategySchema>;

/** Machine-readable exception boundary used when prose scope is insufficient. */
export const ExceptionApplicabilitySchema = z
  .strictObject({
    artifact_refs: UniqueArtifactIdListSchema,
    mutation_ids: UniqueArtifactIdListSchema,
  })
  .superRefine((applicability, context) => {
    if (
      applicability.artifact_refs.length === 0 &&
      applicability.mutation_ids.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Exception applicability requires at least one selector',
      });
    }
  });

export const RuleExceptionSchema = z
  .strictObject({
    id: ArtifactIdSchema,
    reason: NonEmptyStringSchema,
    owner: NonEmptyStringSchema,
    scope: NonEmptyStringSchema,
    applies_to: ExceptionApplicabilitySchema.optional(),
    expires_on: IsoDateSchema,
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((exception, context) => {
    if (!exception.evidence.some((item) => item.type === 'human_decision')) {
      context.addIssue({
        code: 'custom',
        message: 'An active rule exception requires human-decision evidence',
        path: ['evidence'],
      });
    }
  });

const RuleExceptionListSchema = z
  .array(RuleExceptionSchema)
  .superRefine((exceptions, context) => {
    duplicateIndexesBy(exceptions, (exception) => exception.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Exception IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** Requirements and active records governing rule exceptions. */
export const ExceptionPolicySchema = z
  .strictObject({
    allowed: z.boolean(),
    reason_required: z.literal(true),
    owner_required: z.literal(true),
    expiration_required: z.literal(true),
    active_exceptions: RuleExceptionListSchema,
  })
  .superRefine((policy, context) => {
    if (!policy.allowed && policy.active_exceptions.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Active exceptions are not allowed by this policy',
        path: ['active_exceptions'],
      });
    }
  });

/** Exception governance, including explicit ownership and expiration. */
export type ExceptionPolicy = z.infer<typeof ExceptionPolicySchema>;

/** Traceable project-specific interpretation of one or more principles. */
export const ProjectRuleSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('project_rule'),
    id: ArtifactIdSchema,
    project_ref: ArtifactIdSchema,
    title: NonEmptyStringSchema,
    status: z.enum(['candidate', 'active', 'retired']),
    level: RuleLevelSchema,
    statement: NonEmptyStringSchema,
    principle_refs: UniqueArtifactIdListSchema.min(1),
    observation_refs: UniqueArtifactIdListSchema.min(1),
    module_refs: UniqueStringListSchema,
    evidence: EvidenceReferenceListSchema.min(1),
    risk: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    scope: RuleScopeSchema,
    enforcement: z.array(EnforcementConfigurationSchema).min(1),
    migration: MigrationStrategySchema.optional(),
    exceptions: ExceptionPolicySchema,
  })
  .superRefine((rule, context) => {
    if (
      rule.status === 'active' &&
      !rule.evidence.some((item) => item.type === 'human_decision')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An active project rule requires human-decision evidence',
        path: ['evidence'],
      });
    }
    if (
      (rule.level !== 'mandatory' || rule.status !== 'active') &&
      rule.enforcement.some((item) => item.blocking)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Blocking enforcement requires an active rule at the mandatory level',
        path: ['enforcement'],
      });
    }
    rule.enforcement.forEach((item, index) => {
      if (
        item.mechanism === 'ai_review' &&
        item.blocking &&
        (item.authorization_decision_ref === undefined ||
          !rule.evidence.some(
            (evidence) =>
              evidence.type === 'human_decision' &&
              evidence.id === item.authorization_decision_ref,
          ))
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Blocking AI review requires authorization_decision_ref to matching human-decision evidence',
          path: ['enforcement', index, 'authorization_decision_ref'],
        });
      }
    });
  });

/** A validated, explainable project-rule artifact. */
export type ProjectRule = z.infer<typeof ProjectRuleSchema>;
