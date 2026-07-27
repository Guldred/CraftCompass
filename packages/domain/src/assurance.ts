import { z } from 'zod';

import {
  ArtifactIdSchema,
  ConfidenceSchema,
  EvidenceReferenceListSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RepositoryRelativePathSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueArtifactIdListSchema,
  UniqueStringListSchema,
} from './common.js';
import { ChangeConcernSchema } from './change.js';
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
  targets: UniqueStringListSchema.optional(),
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

/** Human-reviewed classification of mutation debt. */
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

/** Why mutation debt remains, without implying automatic acceptance. */
export type MutationClassification = z.infer<
  typeof MutationClassificationSchema
>;

/** Canonical digest of the mutation provider configuration and selected scope. */
export const MutationConfigurationFingerprintSchema = z
  .string()
  .regex(
    /^sha256:[0-9a-f]{64}$/u,
    'Mutation configuration fingerprint must be lowercase sha256:<64 hex>',
  );

/** Stable provider identity used to decide whether two runs are comparable. */
export const MutationProviderIdentitySchema = z.strictObject({
  id: NonEmptyStringSchema,
  tool_version: NonEmptyStringSchema.optional(),
  normalization_version: NonEmptyStringSchema,
  configuration_fingerprint: MutationConfigurationFingerprintSchema.optional(),
});

/** Provider and normalization versions associated with one mutation run. */
export type MutationProviderIdentity = z.infer<
  typeof MutationProviderIdentitySchema
>;

/** Completeness declaration for one mutation execution or imported report. */
export const MutationRunSchema = z
  .strictObject({
    completeness: z.enum(['complete', 'partial']),
    limitations: UniqueStringListSchema,
  })
  .superRefine((run, context) => {
    if (run.completeness === 'partial' && run.limitations.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A partial mutation run requires at least one limitation',
        path: ['limitations'],
      });
    }
  });

/** Explicit run-completeness metadata; partial data is never a silent pass. */
export type MutationRun = z.infer<typeof MutationRunSchema>;

const MutationLocationSchema = z.strictObject({
  /**
   * Source label emitted by the provider. A basename is not silently promoted
   * to a repository path.
   */
  provider_source: NonEmptyStringSchema,
  /** Resolved repository-relative path, present only when resolution is known. */
  file: RepositoryRelativePathSchema.optional(),
  symbol: NonEmptyStringSchema.optional(),
  // PIT legitimately uses line 0 when no source-line context is available.
  line: z.number().int().nonnegative().optional(),
});

const MutationRecordBaseShape = {
  id: ArtifactIdSchema,
  provider_outcome: NonEmptyStringSchema,
  operator: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  location: MutationLocationSchema,
  evidence: EvidenceReferenceListSchema.min(1),
} as const;

/** Required follow-up retained for every result not killed by a test. */
export const MutationActionSchema = z.strictObject({
  required: z.literal(true),
  category: z.enum([
    'investigate_survivor',
    'add_test_coverage',
    'investigate_timeout',
    'investigate_provider_error',
    'review_equivalent_candidate',
  ]),
  reason: NonEmptyStringSchema,
});

/** A mutation distinguished by at least one test. */
export const KilledMutationSchema = z.strictObject({
  ...MutationRecordBaseShape,
  outcome: z.literal('killed'),
});

/** A survivor or no-coverage result requiring classification or remediation. */
export const MutationDebtRecordSchema = z
  .strictObject({
    ...MutationRecordBaseShape,
    outcome: z.enum(['survived', 'no_coverage']),
    classification: MutationClassificationSchema,
    classification_status: z.enum([
      'unresolved',
      'candidate',
      'confirmed',
      'accepted_exception',
    ]),
    explanation: NonEmptyStringSchema.optional(),
    exception_ref: ArtifactIdSchema.optional(),
    action: MutationActionSchema,
  })
  .superRefine((mutant, context) => {
    const hasHumanDecision = mutant.evidence.some(
      (item) => item.type === 'human_decision',
    );
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
      mutant.classification_status === 'unresolved' &&
      mutant.classification !== 'unknown'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An unresolved classification must remain unknown',
        path: ['classification'],
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
      (mutant.classification !== 'accepted_risk' ||
        mutant.exception_ref === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An accepted exception requires accepted_risk classification and an exception_ref',
        path: ['exception_ref'],
      });
    }
    if (
      mutant.classification_status !== 'accepted_exception' &&
      mutant.exception_ref !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An exception_ref is only valid for an accepted_exception classification',
        path: ['exception_ref'],
      });
    }
    if (
      (mutant.classification_status === 'confirmed' ||
        mutant.classification_status === 'accepted_exception') &&
      !hasHumanDecision
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A confirmed classification or accepted exception requires human-decision evidence',
        path: ['classification_status'],
      });
    }
    if (
      mutant.outcome === 'no_coverage' &&
      mutant.action.category !== 'add_test_coverage'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A no-coverage mutation must require coverage follow-up',
        path: ['action', 'category'],
      });
    }
    if (
      mutant.outcome === 'survived' &&
      mutant.action.category !== 'investigate_survivor' &&
      mutant.action.category !== 'review_equivalent_candidate'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A surviving mutation requires survivor investigation',
        path: ['action', 'category'],
      });
    }
    if (
      mutant.action.category === 'review_equivalent_candidate' &&
      (mutant.classification !== 'equivalent' ||
        mutant.classification_status !== 'candidate')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Equivalent-candidate follow-up requires a candidate equivalent classification',
        path: ['action', 'category'],
      });
    }
  });

/** A timed-out mutation whose outcome remains indeterminate. */
export const TimedOutMutationSchema = z.strictObject({
  ...MutationRecordBaseShape,
  outcome: z.literal('timed_out'),
  action: MutationActionSchema.extend({
    category: z.literal('investigate_timeout'),
  }),
});

/** A provider/tool failure retained as an actionable mutation record. */
export const MutationErrorRecordSchema = z.strictObject({
  ...MutationRecordBaseShape,
  outcome: z.literal('error'),
  error_category: z.enum([
    'non_viable',
    'memory_error',
    'run_error',
    'provider_error',
    'unknown',
  ]),
  action: MutationActionSchema.extend({
    category: z.literal('investigate_provider_error'),
  }),
});

/** One normalized mutation result, including killed and indeterminate outcomes. */
export const MutationRecordSchema = z.discriminatedUnion('outcome', [
  KilledMutationSchema,
  MutationDebtRecordSchema,
  TimedOutMutationSchema,
  MutationErrorRecordSchema,
]);

/** One normalized mutation result from any provider. */
export type MutationRecord = z.infer<typeof MutationRecordSchema>;

/** A survivor or no-coverage result that can be tracked in a baseline. */
export type MutationDebtRecord = z.infer<typeof MutationDebtRecordSchema>;

/**
 * Compatibility name for provider classification APIs.
 *
 * It now covers both survivors and no-coverage mutation debt.
 */
export const SurvivingMutantSchema = MutationDebtRecordSchema;
export type SurvivingMutant = MutationDebtRecord;

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
      run_id: ArtifactIdSchema.optional(),
      configuration_evidence_ref: ArtifactIdSchema.optional(),
      exit_code: z.number().int().optional(),
    })
    .optional(),
});

/** Traceable assurance evidence, optionally including normalized tool execution. */
export type AssuranceEvidence = z.infer<typeof AssuranceEvidenceSchema>;

export const MutationTotalsSchema = z.strictObject({
  generated: z.number().int().nonnegative(),
  killed: z.number().int().nonnegative(),
  survived: z.number().int().nonnegative(),
  no_coverage: z.number().int().nonnegative(),
  timed_out: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

/** Exact outcome totals for one normalized mutation run. */
export type MutationTotals = z.infer<typeof MutationTotalsSchema>;

const MutationRecordListSchema = z
  .array(MutationRecordSchema)
  .max(100_000)
  .superRefine((mutations, context) => {
    duplicateIndexesBy(mutations, (mutation) => mutation.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Mutation record IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
    mutations.forEach((mutation, index) => {
      const previous = mutations[index - 1];
      if (previous !== undefined && previous.id > mutation.id) {
        context.addIssue({
          code: 'custom',
          message: 'Mutation records must be sorted by ID',
          path: [index, 'id'],
        });
      }
    });
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

/** Normalized, traceable output of a mutation-testing provider. */
export const MutationReportSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('mutation_report'),
    id: ArtifactIdSchema,
    project_ref: ArtifactIdSchema,
    assurance_profile_ref: ArtifactIdSchema,
    assurance_plan_ref: ArtifactIdSchema,
    provider: MutationProviderIdentitySchema,
    provider_run_id: ArtifactIdSchema,
    run: MutationRunSchema,
    scope: MutationScopeSchema,
    totals: MutationTotalsSchema,
    mutations: MutationRecordListSchema,
    evidence: AssuranceEvidenceListSchema.min(1),
  })
  .superRefine((report, context) => {
    const count = (outcome: MutationRecord['outcome']): number =>
      report.mutations.filter((mutation) => mutation.outcome === outcome)
        .length;
    const expectedTotals = {
      generated: report.mutations.length,
      killed: count('killed'),
      survived: count('survived'),
      no_coverage: count('no_coverage'),
      timed_out: count('timed_out'),
      errors: count('error'),
    };
    (
      Object.entries(expectedTotals) as readonly [
        keyof typeof expectedTotals,
        number,
      ][]
    ).forEach(([field, expected]) => {
      if (report.totals[field] === expected) {
        return;
      }
      context.addIssue({
        code: 'custom',
        message: `${field} must equal the number of matching mutation records`,
        path: ['totals', field],
      });
    });
    const mutationRunEvidence = report.evidence
      .map((evidence, index) => ({ evidence, index }))
      .filter(({ evidence }) => evidence.type === 'mutation_run');
    if (mutationRunEvidence.length !== 1) {
      context.addIssue({
        code: 'custom',
        message:
          'A mutation report requires exactly one mutation_run evidence record',
        path: ['evidence'],
      });
    }
    mutationRunEvidence.forEach(({ evidence, index }) => {
      const configurationEvidence =
        evidence.execution?.configuration_evidence_ref === undefined
          ? undefined
          : evidence.references.find(
              (reference) =>
                reference.id === evidence.execution?.configuration_evidence_ref,
            );
      if (
        report.provider.configuration_fingerprint !== undefined &&
        (configurationEvidence?.type !== 'build_configuration' ||
          configurationEvidence.provider !== report.provider.id)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'A configuration fingerprint requires an identified build-configuration evidence reference from the same provider',
          path: ['evidence', index, 'execution', 'configuration_evidence_ref'],
        });
      }
      if (
        evidence.execution?.tool !== report.provider.id ||
        evidence.execution.run_id !== report.provider_run_id ||
        (report.provider.tool_version !== undefined &&
          evidence.execution.version !== report.provider.tool_version) ||
        (report.provider.configuration_fingerprint !== undefined &&
          evidence.execution.invocation !==
            report.provider.configuration_fingerprint)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Mutation-run evidence must match provider, version, run ID, and configuration fingerprint',
          path: ['evidence', index, 'execution'],
        });
      }
      if (evidence.status !== 'passed') {
        return;
      }
      if (
        report.run.completeness !== 'complete' ||
        report.totals.generated === 0 ||
        report.totals.survived > 0 ||
        report.totals.no_coverage > 0 ||
        report.totals.timed_out > 0 ||
        report.totals.errors > 0
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Passed mutation evidence requires a complete, non-empty, all-killed run',
          path: ['evidence', index, 'status'],
        });
      }
      if (
        report.provider.tool_version === undefined ||
        report.provider.configuration_fingerprint === undefined ||
        evidence.execution?.tool !== report.provider.id ||
        evidence.execution.version !== report.provider.tool_version ||
        evidence.execution.run_id !== report.provider_run_id ||
        evidence.execution.invocation !==
          report.provider.configuration_fingerprint
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Passed mutation evidence requires matching versioned execution provenance and a configuration-fingerprint binding',
          path: ['evidence', index, 'execution'],
        });
      }
    });
  });

/** A validated, provider-neutral mutation report artifact. */
export type MutationReport = z.infer<typeof MutationReportSchema>;

const ChangeConcernSelectorListSchema = z
  .array(ChangeConcernSchema)
  .superRefine((concerns, context) => {
    duplicateIndexesBy(concerns, (concern) => concern).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Change concern selectors must be unique',
        path: [index],
      });
    });
  });

const ReviewPolicySchema = z.strictObject({
  default_level: ReviewLevelSchema,
  always_review: UniqueStringListSchema.min(1),
  selective_review: UniqueStringListSchema,
  always_review_concerns: ChangeConcernSelectorListSchema.optional(),
  selective_review_concerns: ChangeConcernSelectorListSchema.optional(),
});

const TestingPolicySchema = z.strictObject({
  unit_tests_required: z.boolean(),
  acceptance_tests_required_for: UniqueStringListSchema,
  integration_tests_required_for: UniqueStringListSchema,
  acceptance_concerns: ChangeConcernSelectorListSchema.optional(),
  integration_concerns: ChangeConcernSelectorListSchema.optional(),
});

const ArchitecturePolicySchema = z.strictObject({
  checks_required: z.boolean(),
  baseline_existing_violations: z.boolean(),
  fail_on_new_violations: z.boolean(),
});

const SecurityPolicySchema = z.strictObject({
  dependency_scanning_required: z.boolean(),
  human_review_required_for: UniqueStringListSchema,
  human_review_concerns: ChangeConcernSelectorListSchema.optional(),
});

/** Evidence-backed readiness required before reducing implementation review. */
export const AssuranceReadinessSchema = z.strictObject({
  test_reliability: z.enum(['unknown', 'weak', 'established']),
  architecture_checks: z.enum(['absent', 'partial', 'established']),
  mutation_baseline: z.enum(['missing', 'stale', 'available']),
  impact_analysis: z.enum(['unreliable', 'developing', 'reliable']),
  rollback: z.enum(['unknown', 'unsupported', 'supported']),
  evidence: EvidenceReferenceListSchema.min(1),
});

/** Project maturity evidence used as a prerequisite, never an autonomy score. */
export type AssuranceReadiness = z.infer<typeof AssuranceReadinessSchema>;

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
  readiness: AssuranceReadinessSchema.optional(),
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

/** One evidence-linked deterministic planner decision. */
export const DerivationDecisionSchema = z.strictObject({
  code: ArtifactIdSchema,
  summary: NonEmptyStringSchema,
  evidence_refs: UniqueArtifactIdListSchema.min(1),
});

const DerivationDecisionListSchema = z
  .array(DerivationDecisionSchema)
  .superRefine((decisions, context) => {
    duplicateIndexesBy(decisions, (decision) => decision.code).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Derivation decision codes must be unique',
          path: [index, 'code'],
        });
      },
    );
  });

/** Change-specific list of gates, mutation scope, and human review needs. */
export const AssurancePlanSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('assurance_plan'),
    id: ArtifactIdSchema,
    change_id: NonEmptyStringSchema,
    project_ref: ArtifactIdSchema,
    assurance_profile_ref: ArtifactIdSchema,
    change_context_ref: ArtifactIdSchema.optional(),
    impact_ref: ArtifactIdSchema.optional(),
    risk: RiskAssessmentSchema,
    impacted_flows: UniqueStringListSchema,
    required_gates: QualityGateRequirementListSchema.min(1),
    mutation_scope: MutationScopeSchema.optional(),
    human_review: ReviewRequirementSchema,
    rationale: UniqueStringListSchema.min(1),
    derivation_evidence: EvidenceReferenceListSchema.optional(),
    decision_trace: DerivationDecisionListSchema.optional(),
  })
  .superRefine((plan, context) => {
    if (plan.decision_trace === undefined) {
      return;
    }
    const evidenceIds = new Set([
      ...plan.risk.evidence.map((evidence) => evidence.id),
      ...(plan.derivation_evidence ?? []).map((evidence) => evidence.id),
    ]);
    plan.decision_trace.forEach((decision, decisionIndex) => {
      decision.evidence_refs.forEach((reference, referenceIndex) => {
        if (!evidenceIds.has(reference)) {
          context.addIssue({
            code: 'custom',
            message:
              'Derivation evidence reference must resolve within the assurance plan',
            path: [
              'decision_trace',
              decisionIndex,
              'evidence_refs',
              referenceIndex,
            ],
          });
        }
      });
    });
  });

/** A validated assurance plan for one change. */
export type AssurancePlan = z.infer<typeof AssurancePlanSchema>;
