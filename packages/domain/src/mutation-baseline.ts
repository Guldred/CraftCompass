import { z } from 'zod';

import {
  MutationDebtRecordSchema,
  MutationProviderIdentitySchema,
  MutationScopeSchema,
  MutationTotalsSchema,
} from './assurance.js';
import {
  ArtifactIdSchema,
  EvidenceReferenceListSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueStringListSchema,
} from './common.js';
import { duplicateIndexesBy } from './schema-helpers.js';

const MutationBaselineEntryListSchema = z
  .array(MutationDebtRecordSchema)
  .max(100_000)
  .superRefine((entries, context) => {
    duplicateIndexesBy(entries, (entry) => entry.id).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Mutation baseline entry IDs must be unique',
        path: [index, 'id'],
      });
    });
    entries.forEach((entry, index) => {
      const previous = entries[index - 1];
      if (previous !== undefined && previous.id > entry.id) {
        context.addIssue({
          code: 'custom',
          message: 'Mutation baseline entries must be sorted by ID',
          path: [index, 'id'],
        });
      }
    });
  });

/** Snapshot of the report properties that determine baseline eligibility. */
export const MutationBaselineSourceRunSchema = z
  .strictObject({
    completeness: z.enum(['complete', 'partial']),
    totals: MutationTotalsSchema,
    limitations: UniqueStringListSchema,
  })
  .superRefine((run, context) => {
    if (run.completeness === 'partial' && run.limitations.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A partial baseline source run requires a limitation',
        path: ['limitations'],
      });
    }
  });

/** Explicit human authorization required before a baseline can affect a gate. */
export const MutationBaselineActivationSchema = z
  .strictObject({
    owner: NonEmptyStringSchema,
    reviewed_on: IsoDateSchema,
    decision_ref: ArtifactIdSchema,
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((activation, context) => {
    if (
      !activation.evidence.some(
        (evidence) =>
          evidence.id === activation.decision_ref &&
          evidence.type === 'human_decision',
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Baseline decision_ref must identify matching human-decision evidence',
        path: ['decision_ref'],
      });
    }
  });

/**
 * Stored mutation debt used only for like-for-like, no-new-debt comparison.
 *
 * Automatically generated baselines remain candidates. Only an eligible
 * complete run plus explicit human activation can authorize comparison.
 */
export const MutationBaselineSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('mutation_baseline'),
    id: ArtifactIdSchema,
    project_ref: ArtifactIdSchema,
    assurance_profile_ref: ArtifactIdSchema,
    source_report_ref: ArtifactIdSchema,
    status: z.enum(['candidate', 'active', 'superseded']),
    provider: MutationProviderIdentitySchema,
    scope: MutationScopeSchema,
    source_run: MutationBaselineSourceRunSchema,
    entries: MutationBaselineEntryListSchema,
    created_at: IsoDateTimeSchema,
    activation: MutationBaselineActivationSchema.optional(),
    superseded_by: ArtifactIdSchema.optional(),
  })
  .superRefine((baseline, context) => {
    if (
      baseline.activation !== undefined &&
      baseline.activation.reviewed_on < baseline.created_at.slice(0, 10)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A mutation baseline cannot be reviewed before it is created',
        path: ['activation', 'reviewed_on'],
      });
    }
    const sourceTotals = baseline.source_run.totals;
    if (
      sourceTotals.generated !==
      sourceTotals.killed +
        sourceTotals.survived +
        sourceTotals.no_coverage +
        sourceTotals.timed_out +
        sourceTotals.errors
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Baseline source totals must partition every generated mutation',
        path: ['source_run', 'totals', 'generated'],
      });
    }
    const survivedEntries = baseline.entries.filter(
      (entry) => entry.outcome === 'survived',
    ).length;
    const noCoverageEntries = baseline.entries.filter(
      (entry) => entry.outcome === 'no_coverage',
    ).length;
    if (survivedEntries !== sourceTotals.survived) {
      context.addIssue({
        code: 'custom',
        message:
          'Baseline survived total must equal the number of surviving entries',
        path: ['source_run', 'totals', 'survived'],
      });
    }
    if (noCoverageEntries !== sourceTotals.no_coverage) {
      context.addIssue({
        code: 'custom',
        message:
          'Baseline no-coverage total must equal the number of no-coverage entries',
        path: ['source_run', 'totals', 'no_coverage'],
      });
    }
    if (baseline.status === 'candidate') {
      if (baseline.activation !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A candidate baseline cannot carry activation',
          path: ['activation'],
        });
      }
      if (baseline.superseded_by !== undefined) {
        context.addIssue({
          code: 'custom',
          message:
            'A candidate baseline cannot be superseded_by another baseline',
          path: ['superseded_by'],
        });
      }
      return;
    }
    if (baseline.status === 'active') {
      if (baseline.activation === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'An active mutation baseline requires human activation',
          path: ['activation'],
        });
      }
      if (baseline.provider.tool_version === undefined) {
        context.addIssue({
          code: 'custom',
          message:
            'An active mutation baseline requires an exact provider tool_version',
          path: ['provider', 'tool_version'],
        });
      }
      if (baseline.provider.configuration_fingerprint === undefined) {
        context.addIssue({
          code: 'custom',
          message:
            'An active mutation baseline requires an exact provider configuration_fingerprint',
          path: ['provider', 'configuration_fingerprint'],
        });
      }
      if (baseline.source_run.completeness !== 'complete') {
        context.addIssue({
          code: 'custom',
          message: 'An active mutation baseline requires a complete source run',
          path: ['source_run', 'completeness'],
        });
      }
      if (
        baseline.source_run.totals.timed_out > 0 ||
        baseline.source_run.totals.errors > 0
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'An active mutation baseline cannot contain timed-out or error outcomes',
          path: ['source_run', 'totals'],
        });
      }
      if (baseline.source_run.totals.generated === 0) {
        context.addIssue({
          code: 'custom',
          message:
            'An active mutation baseline requires at least one generated mutation',
          path: ['source_run', 'totals', 'generated'],
        });
      }
      if (baseline.superseded_by !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'An active baseline cannot declare superseded_by',
          path: ['superseded_by'],
        });
      }
      return;
    }
    if (baseline.superseded_by === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A superseded baseline requires superseded_by',
        path: ['superseded_by'],
      });
    } else if (baseline.superseded_by === baseline.id) {
      context.addIssue({
        code: 'custom',
        message: 'A mutation baseline cannot supersede itself',
        path: ['superseded_by'],
      });
    }
  });

/** A candidate, active, or superseded mutation-debt baseline artifact. */
export type MutationBaseline = z.infer<typeof MutationBaselineSchema>;
