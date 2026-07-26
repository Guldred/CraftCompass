import { z } from 'zod';

import {
  ArtifactIdSchema,
  ConfidenceSchema,
  EvidenceReferenceListSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueArtifactIdListSchema,
  UniqueStringListSchema,
} from './common.js';
import { ExceptionPolicySchema } from './rules.js';
import { duplicateIndexesBy } from './schema-helpers.js';

/** Human review depth supported by the first MVP; Level 3 is not representable. */
export const ReviewLevelSchema = z.union(
  [z.literal(0), z.literal(1), z.literal(2)],
  {
    error: 'Review level must be 0, 1, or 2',
  },
);

/** Review Level 0, 1, or 2. */
export type ReviewLevel = z.infer<typeof ReviewLevelSchema>;

const RiskBandSchema = z.enum(['low', 'medium', 'high', 'critical']);

/** Evidence-backed assessment of the risk posed by a specific change. */
export const RiskAssessmentSchema = z.strictObject({
  overall: RiskBandSchema,
  likelihood: RiskBandSchema,
  impact: RiskBandSchema,
  confidence: ConfidenceSchema,
  factors: UniqueStringListSchema.min(1),
  evidence: EvidenceReferenceListSchema.min(1),
});

/** A validated risk assessment with explicit evidence and uncertainty. */
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const QualityGateTypeSchema = z.enum([
  'compilation',
  'formatting',
  'linting',
  'unit_tests',
  'integration_tests',
  'acceptance_tests',
  'architecture_tests',
  'mutation_tests',
  'dependency_scan',
  'security_tests',
  'api_compatibility',
  'migration_check',
  'performance_tests',
  'other',
]);

/** A required deterministic check and the reason it is required. */
export const QualityGateRequirementSchema = z.strictObject({
  id: ArtifactIdSchema,
  type: QualityGateTypeSchema,
  blocking: z.boolean(),
  reason: NonEmptyStringSchema,
});

/** One normalized quality-gate requirement. */
export type QualityGateRequirement = z.infer<
  typeof QualityGateRequirementSchema
>;

/** Result of a gate without collapsing its underlying evidence into one score. */
export const QualityGateResultSchema = z
  .strictObject({
    requirement_id: ArtifactIdSchema,
    status: z.enum(['passed', 'failed', 'error', 'not_run', 'waived']),
    summary: NonEmptyStringSchema,
    evidence: EvidenceReferenceListSchema.min(1),
    exception_ref: ArtifactIdSchema.optional(),
  })
  .superRefine((result, context) => {
    if (result.status === 'waived' && result.exception_ref === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A waived gate requires an exception_ref',
        path: ['exception_ref'],
      });
    }
  });

/** A normalized quality-gate result linked to supporting evidence. */
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

/** Changed and impacted code selected for a future mutation provider. */
export const MutationScopeSchema = z.strictObject({
  primary_targets: UniqueStringListSchema.min(1),
  supporting_targets: UniqueStringListSchema,
  relevant_tests: UniqueStringListSchema,
  confidence: ConfidenceSchema,
  limitations: UniqueStringListSchema,
});

/** A provider-neutral, confidence-qualified mutation-testing scope. */
export type MutationScope = z.infer<typeof MutationScopeSchema>;

/**
 * First-class mutation policy for changed business behavior.
 *
 * A global score can be reported as context but cannot be the decision strategy.
 */
export const MutationPolicySchema = z.strictObject({
  strategy: z.literal('no_new_unexplained_survivors'),
  changed_business_behavior: z.strictObject({
    new_unexplained_survivors: z.literal('forbidden'),
  }),
  baseline: z.strictObject({
    existing_survivors: z.enum(['classify_and_track', 'not_available']),
    regression: z.literal('forbidden'),
  }),
  score: z
    .strictObject({
      report: z.boolean(),
      decision_role: z.literal('context_only'),
    })
    .optional(),
});

/** Mutation policy that treats survivors as evidence rather than proof or a score. */
export type MutationPolicy = z.infer<typeof MutationPolicySchema>;

/** Human-reviewed classification of a surviving mutant. */
export const MutationClassificationSchema = z.enum([
  'test_gap',
  'equivalent',
  'irrelevant_generated_code',
  'unreachable_code',
  'invalid_mutation',
  'tool_limitation',
  'accepted_risk',
  'unknown',
]);

/** Why a mutant may have survived, without implying automatic acceptance. */
export type MutationClassification = z.infer<
  typeof MutationClassificationSchema
>;

/** One mutation that the relevant tests did not kill. */
export const SurvivingMutantSchema = z
  .strictObject({
    id: ArtifactIdSchema,
    operator: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    location: z.strictObject({
      file: NonEmptyStringSchema,
      symbol: NonEmptyStringSchema.optional(),
      line: z.number().int().positive().optional(),
    }),
    classification: MutationClassificationSchema,
    classification_status: z.enum([
      'unresolved',
      'candidate',
      'confirmed',
      'accepted_exception',
    ]),
    explanation: NonEmptyStringSchema.optional(),
    exception_ref: ArtifactIdSchema.optional(),
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((mutant, context) => {
    if (
      mutant.classification === 'unknown' &&
      mutant.classification_status !== 'unresolved'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An unknown classification must remain unresolved',
        path: ['classification_status'],
      });
    }
    if (
      mutant.classification === 'accepted_risk' &&
      (mutant.classification_status !== 'accepted_exception' ||
        mutant.exception_ref === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An accepted risk requires accepted_exception status and an exception_ref',
        path: ['classification_status'],
      });
    }
    if (
      mutant.classification_status === 'accepted_exception' &&
      mutant.exception_ref === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An accepted exception requires an exception_ref',
        path: ['exception_ref'],
      });
    }
    if (
      mutant.classification === 'equivalent' &&
      mutant.classification_status === 'confirmed' &&
      !mutant.evidence.some((item) => item.type === 'human_decision')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A confirmed equivalent mutant requires human-decision evidence',
        path: ['classification_status'],
      });
    }
  });

/** A surviving mutant with location, status, evidence, and classification state. */
export type SurvivingMutant = z.infer<typeof SurvivingMutantSchema>;

/** Evidence retained for an assurance or merge decision. */
export const AssuranceEvidenceSchema = z.strictObject({
  id: ArtifactIdSchema,
  type: z.enum([
    'quality_gate',
    'mutation_run',
    'review',
    'specification',
    'human_decision',
    'other',
  ]),
  status: z.enum(['passed', 'failed', 'conditional', 'informational']),
  summary: NonEmptyStringSchema,
  captured_at: IsoDateTimeSchema,
  references: EvidenceReferenceListSchema.min(1),
  execution: z
    .strictObject({
      tool: NonEmptyStringSchema,
      version: NonEmptyStringSchema.optional(),
      invocation: NonEmptyStringSchema.optional(),
      exit_code: z.number().int().optional(),
    })
    .optional(),
});

/** Traceable assurance evidence, optionally including normalized tool execution. */
export type AssuranceEvidence = z.infer<typeof AssuranceEvidenceSchema>;

const MutationTotalsSchema = z.strictObject({
  generated: z.number().int().nonnegative(),
  killed: z.number().int().nonnegative(),
  survived: z.number().int().nonnegative(),
  no_coverage: z.number().int().nonnegative(),
  timed_out: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

const SurvivingMutantListSchema = z
  .array(SurvivingMutantSchema)
  .superRefine((survivors, context) => {
    duplicateIndexesBy(survivors, (survivor) => survivor.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Surviving mutant IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

const AssuranceEvidenceListSchema = z
  .array(AssuranceEvidenceSchema)
  .superRefine((evidenceItems, context) => {
    duplicateIndexesBy(evidenceItems, (evidence) => evidence.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Assurance evidence IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** Normalized output of any future mutation-testing provider. */
export const MutationReportSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('mutation_report'),
    id: ArtifactIdSchema,
    provider: NonEmptyStringSchema,
    scope: MutationScopeSchema,
    totals: MutationTotalsSchema,
    survivors: SurvivingMutantListSchema,
    baseline_comparison: z
      .strictObject({
        baseline_ref: ArtifactIdSchema,
        new_survivors: z.number().int().nonnegative(),
        new_survivor_ids: UniqueArtifactIdListSchema,
        resolved_survivors: z.number().int().nonnegative(),
        resolved_survivor_ids: UniqueArtifactIdListSchema,
      })
      .optional(),
    evidence: AssuranceEvidenceListSchema.min(1),
  })
  .superRefine((report, context) => {
    const accountedFor =
      report.totals.killed +
      report.totals.survived +
      report.totals.no_coverage +
      report.totals.timed_out +
      report.totals.errors;
    if (report.totals.generated !== accountedFor) {
      context.addIssue({
        code: 'custom',
        message:
          'generated must equal killed + survived + no_coverage + timed_out + errors',
        path: ['totals', 'generated'],
      });
    }
    if (report.totals.survived !== report.survivors.length) {
      context.addIssue({
        code: 'custom',
        message: 'survived must equal the number of survivor records',
        path: ['totals', 'survived'],
      });
    }
    if (
      report.baseline_comparison !== undefined &&
      report.baseline_comparison.new_survivors > report.totals.survived
    ) {
      context.addIssue({
        code: 'custom',
        message: 'new_survivors cannot exceed the report survivor count',
        path: ['baseline_comparison', 'new_survivors'],
      });
    }
    if (
      report.baseline_comparison !== undefined &&
      report.baseline_comparison.new_survivors !==
        report.baseline_comparison.new_survivor_ids.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'new_survivors must equal the number of new_survivor_ids',
        path: ['baseline_comparison', 'new_survivors'],
      });
    }
    if (
      report.baseline_comparison !== undefined &&
      report.baseline_comparison.resolved_survivors !==
        report.baseline_comparison.resolved_survivor_ids.length
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'resolved_survivors must equal the number of resolved_survivor_ids',
        path: ['baseline_comparison', 'resolved_survivors'],
      });
    }
    if (report.baseline_comparison !== undefined) {
      const currentSurvivorIds = new Set(
        report.survivors.map((survivor) => survivor.id),
      );
      report.baseline_comparison.new_survivor_ids.forEach((id, index) => {
        if (!currentSurvivorIds.has(id)) {
          context.addIssue({
            code: 'custom',
            message: 'A new survivor ID must identify a current survivor',
            path: ['baseline_comparison', 'new_survivor_ids', index],
          });
        }
      });
      report.baseline_comparison.resolved_survivor_ids.forEach((id, index) => {
        if (currentSurvivorIds.has(id)) {
          context.addIssue({
            code: 'custom',
            message:
              'A resolved survivor ID cannot remain in current survivors',
            path: ['baseline_comparison', 'resolved_survivor_ids', index],
          });
        }
      });
    }
  });

/** A validated, provider-neutral mutation report artifact. */
export type MutationReport = z.infer<typeof MutationReportSchema>;

const ReviewPolicySchema = z.strictObject({
  default_level: ReviewLevelSchema,
  always_review: UniqueStringListSchema.min(1),
  selective_review: UniqueStringListSchema,
});

const TestingPolicySchema = z.strictObject({
  unit_tests_required: z.boolean(),
  acceptance_tests_required_for: UniqueStringListSchema,
  integration_tests_required_for: UniqueStringListSchema,
});

const ArchitecturePolicySchema = z.strictObject({
  checks_required: z.boolean(),
  baseline_existing_violations: z.boolean(),
  fail_on_new_violations: z.boolean(),
});

const SecurityPolicySchema = z.strictObject({
  dependency_scanning_required: z.boolean(),
  human_review_required_for: UniqueStringListSchema,
});

/** Project-wide defaults from which change-specific assurance plans can be derived. */
export const AssuranceProfileSchema = z.strictObject({
  schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
  kind: z.literal('assurance_profile'),
  id: ArtifactIdSchema,
  project_ref: ArtifactIdSchema,
  project_criticality: RiskBandSchema,
  agent_generated_code_share: z.enum(['none', 'low', 'medium', 'high']),
  review_policy: ReviewPolicySchema,
  testing_policy: TestingPolicySchema,
  architecture_policy: ArchitecturePolicySchema,
  mutation_policy: MutationPolicySchema,
  security_policy: SecurityPolicySchema,
  exception_policy: ExceptionPolicySchema,
});

/** A validated project assurance-profile artifact. */
export type AssuranceProfile = z.infer<typeof AssuranceProfileSchema>;

const ReviewRequirementSchema = z.strictObject({
  level: ReviewLevelSchema,
  targets: UniqueStringListSchema.min(1),
  rationale: UniqueStringListSchema.min(1),
});

const QualityGateRequirementListSchema = z
  .array(QualityGateRequirementSchema)
  .superRefine((requirements, context) => {
    duplicateIndexesBy(requirements, (requirement) => requirement.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Quality gate requirement IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** Change-specific list of gates, mutation scope, and human review needs. */
export const AssurancePlanSchema = z.strictObject({
  schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
  kind: z.literal('assurance_plan'),
  id: ArtifactIdSchema,
  change_id: NonEmptyStringSchema,
  project_ref: ArtifactIdSchema,
  risk: RiskAssessmentSchema,
  impacted_flows: UniqueStringListSchema,
  required_gates: QualityGateRequirementListSchema.min(1),
  mutation_scope: MutationScopeSchema.optional(),
  human_review: ReviewRequirementSchema,
  rationale: UniqueStringListSchema.min(1),
});

/** A validated assurance plan for one change. */
export type AssurancePlan = z.infer<typeof AssurancePlanSchema>;
