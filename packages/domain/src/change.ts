import { z } from 'zod';

import {
  ArtifactIdSchema,
  ConfidenceSchema,
  EvidenceReferenceListSchema,
  NonEmptyStringSchema,
  RepositoryRelativePathSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueStringListSchema,
} from './common.js';
import { duplicateIndexesBy } from './schema-helpers.js';

/** Stable, machine-readable concerns used by assurance planning. */
export const ChangeConcernSchema = z.enum([
  'documentation',
  'internal_rename',
  'internal_refactoring',
  'business_rule',
  'externally_observable_behavior',
  'public_api',
  'authorization',
  'sensitive_data',
  'data_migration',
  'persistence',
  'messaging',
  'external_service',
  'new_external_entry_point',
  'dependency',
  'build_tooling',
  'security',
  'unknown',
]);

/** A structured concern; planners must not infer it from prose or filenames. */
export type ChangeConcern = z.infer<typeof ChangeConcernSchema>;

/** Unique, non-empty list of structured change concerns. */
export const ChangeConcernListSchema = z
  .array(ChangeConcernSchema)
  .min(1)
  .superRefine((concerns, context) => {
    duplicateIndexesBy(concerns, (concern) => concern).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Change concerns must be unique',
        path: [index],
      });
    });
  });

/** Whether the change is intended to preserve or alter observable behavior. */
export const ChangeNatureSchema = z.enum([
  'behavior_preserving',
  'behavior_changing',
  'unknown',
]);

/** Provider-neutral symbol identity and its evidence. */
export const CodeSymbolSchema = z.strictObject({
  qualified_name: NonEmptyStringSchema,
  kind: z.enum([
    'class',
    'interface',
    'function',
    'method',
    'module',
    'file',
    'unknown',
  ]),
  role: z.enum([
    'production',
    'test',
    'generated',
    'configuration',
    'documentation',
    'unknown',
  ]),
  file: RepositoryRelativePathSchema.optional(),
  /** Provider-ready class/module target; no string parsing is required downstream. */
  target: NonEmptyStringSchema.optional(),
  confidence: ConfidenceSchema,
  evidence: EvidenceReferenceListSchema.min(1),
});

/** One normalized changed or impacted symbol. */
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

const CodeSymbolListSchema = z
  .array(CodeSymbolSchema)
  .superRefine((symbols, context) => {
    duplicateIndexesBy(symbols, (symbol) => symbol.qualified_name).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Symbol qualified names must be unique',
          path: [index, 'qualified_name'],
        });
      },
    );
  });

/** One file known to participate in a change. */
export const ChangedFileSchema = z
  .strictObject({
    path: RepositoryRelativePathSchema,
    change_type: z.enum(['added', 'modified', 'deleted', 'renamed']),
    previous_path: RepositoryRelativePathSchema.optional(),
    role: z.enum([
      'production',
      'test',
      'generated',
      'configuration',
      'documentation',
      'unknown',
    ]),
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((file, context) => {
    if (file.change_type === 'renamed' && file.previous_path === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A renamed file requires previous_path',
        path: ['previous_path'],
      });
    }
    if (file.change_type !== 'renamed' && file.previous_path !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'previous_path is only valid for a renamed file',
        path: ['previous_path'],
      });
    }
    if (
      file.change_type === 'renamed' &&
      file.previous_path !== undefined &&
      file.previous_path === file.path
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A renamed file must change its path',
        path: ['previous_path'],
      });
    }
  });

/** One normalized changed file. */
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

const ChangedFileListSchema = z
  .array(ChangedFileSchema)
  .superRefine((files, context) => {
    duplicateIndexesBy(files, (file) => file.path).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Changed file paths must be unique',
        path: [index, 'path'],
      });
    });
  });

/**
 * Evidence-backed description of a change.
 *
 * Concerns are supplied explicitly; CraftCompass never guesses security,
 * business, or migration intent from naming alone.
 */
export const ChangeContextSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('change_context'),
    id: ArtifactIdSchema,
    project_ref: ArtifactIdSchema,
    summary: NonEmptyStringSchema,
    nature: ChangeNatureSchema,
    concerns: ChangeConcernListSchema,
    agent_generated_code_share: z
      .enum(['none', 'low', 'medium', 'high'])
      .optional(),
    changed_files: ChangedFileListSchema,
    changed_symbols: CodeSymbolListSchema,
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((change, context) => {
    if (
      change.changed_files.length === 0 &&
      change.changed_symbols.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A change requires at least one changed file or symbol',
        path: ['changed_files'],
      });
    }
  });

/** A validated, structured input for change-impact and assurance planning. */
export type ChangeContext = z.infer<typeof ChangeContextSchema>;

/** One directly impacted symbol. Distance is exactly one graph relationship. */
export const DirectImpactSchema = z.strictObject({
  symbol: CodeSymbolSchema,
  distance: z.literal(1),
  relationships: UniqueStringListSchema.min(1),
});

/** One indirectly impacted symbol at graph distance two or greater. */
export const IndirectImpactSchema = z.strictObject({
  symbol: CodeSymbolSchema,
  distance: z.number().int().min(2),
  relationships: UniqueStringListSchema.min(1),
});

const DirectImpactListSchema = z
  .array(DirectImpactSchema)
  .superRefine((impacts, context) => {
    duplicateIndexesBy(
      impacts,
      (impact) => impact.symbol.qualified_name,
    ).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Directly impacted symbols must be unique',
        path: [index, 'symbol', 'qualified_name'],
      });
    });
  });

const IndirectImpactListSchema = z
  .array(IndirectImpactSchema)
  .superRefine((impacts, context) => {
    duplicateIndexesBy(
      impacts,
      (impact) => impact.symbol.qualified_name,
    ).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Indirectly impacted symbols must be unique',
        path: [index, 'symbol', 'qualified_name'],
      });
    });
  });

/** Execution flow affected by a change, without implying architectural quality. */
export const ImpactedFlowSchema = z.strictObject({
  id: ArtifactIdSchema,
  name: NonEmptyStringSchema,
  symbol_refs: UniqueStringListSchema,
  evidence: EvidenceReferenceListSchema.min(1),
});

const ImpactedFlowListSchema = z
  .array(ImpactedFlowSchema)
  .superRefine((flows, context) => {
    duplicateIndexesBy(flows, (flow) => flow.id).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Impacted flow IDs must be unique',
        path: [index, 'id'],
      });
    });
  });

/**
 * Functional-cluster signal from a graph provider.
 *
 * Signals are retained as evidence and are never themselves defect verdicts.
 */
export const FunctionalClusterSignalSchema = z.strictObject({
  id: ArtifactIdSchema,
  name: NonEmptyStringSchema,
  symbol_refs: UniqueStringListSchema,
  signals: UniqueStringListSchema,
  evidence: EvidenceReferenceListSchema.min(1),
});

const FunctionalClusterSignalListSchema = z
  .array(FunctionalClusterSignalSchema)
  .superRefine((clusters, context) => {
    duplicateIndexesBy(clusters, (cluster) => cluster.id).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Functional cluster IDs must be unique',
        path: [index, 'id'],
      });
    });
  });

/** Provider-neutral payload returned for an available or degraded graph query. */
export const CodeGraphImpactDataSchema = z
  .strictObject({
    completeness: z.enum(['partial', 'unknown']),
    changed_symbols: CodeSymbolListSchema,
    direct_impacts: DirectImpactListSchema,
    indirect_impacts: IndirectImpactListSchema,
    impacted_flows: ImpactedFlowListSchema,
    functional_clusters: FunctionalClusterSignalListSchema,
    candidate_tests: CodeSymbolListSchema,
    confidence: ConfidenceSchema,
    limitations: UniqueStringListSchema,
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((impact, context) => {
    const directNames = new Set(
      impact.direct_impacts.map((item) => item.symbol.qualified_name),
    );
    impact.indirect_impacts.forEach((item, index) => {
      if (directNames.has(item.symbol.qualified_name)) {
        context.addIssue({
          code: 'custom',
          message: 'A symbol cannot be both directly and indirectly impacted',
          path: ['indirect_impacts', index, 'symbol', 'qualified_name'],
        });
      }
    });
    impact.candidate_tests.forEach((test, index) => {
      if (test.role !== 'test') {
        context.addIssue({
          code: 'custom',
          message: 'A candidate test must have the test role',
          path: ['candidate_tests', index, 'role'],
        });
      }
    });
  });

/** Normalized impact data before it receives artifact identity and provenance. */
export type CodeGraphImpactData = z.infer<typeof CodeGraphImpactDataSchema>;

/** Persisted, provider-neutral impact result used by assurance planning. */
export const ChangeImpactSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('change_impact'),
    id: ArtifactIdSchema,
    project_ref: ArtifactIdSchema,
    change_ref: ArtifactIdSchema,
    status: z.enum(['available', 'degraded']),
    source: z.enum(['code_graph', 'diff_fallback']),
    completeness: z.enum(['partial', 'unknown']),
    provider: z.strictObject({
      id: NonEmptyStringSchema,
      evidence_kind: z.enum(['observed', 'synthetic']),
    }),
    evidence_use: z.enum(['decision', 'synthetic_test_only']),
    changed_symbols: CodeSymbolListSchema.min(1),
    direct_impacts: DirectImpactListSchema,
    indirect_impacts: IndirectImpactListSchema,
    impacted_flows: ImpactedFlowListSchema,
    functional_clusters: FunctionalClusterSignalListSchema,
    candidate_tests: CodeSymbolListSchema,
    confidence: ConfidenceSchema,
    limitations: UniqueStringListSchema,
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((impact, context) => {
    if (impact.status === 'degraded' && impact.limitations.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A degraded impact result requires at least one limitation',
        path: ['limitations'],
      });
    }
    if (
      impact.provider.evidence_kind === 'synthetic' &&
      impact.evidence_use !== 'synthetic_test_only'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Synthetic graph evidence cannot be decision evidence',
        path: ['evidence_use'],
      });
    }
    if (impact.source === 'diff_fallback') {
      if (impact.status !== 'degraded' || impact.completeness !== 'unknown') {
        context.addIssue({
          code: 'custom',
          message:
            'Diff fallback impact must be degraded with unknown completeness',
          path: ['source'],
        });
      }
      if (
        impact.direct_impacts.length > 0 ||
        impact.indirect_impacts.length > 0 ||
        impact.impacted_flows.length > 0 ||
        impact.functional_clusters.length > 0
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Diff fallback cannot claim graph-derived impact',
          path: ['source'],
        });
      }
    }
    const directNames = new Set(
      impact.direct_impacts.map((item) => item.symbol.qualified_name),
    );
    impact.indirect_impacts.forEach((item, index) => {
      if (directNames.has(item.symbol.qualified_name)) {
        context.addIssue({
          code: 'custom',
          message: 'A symbol cannot be both directly and indirectly impacted',
          path: ['indirect_impacts', index, 'symbol', 'qualified_name'],
        });
      }
    });
    impact.candidate_tests.forEach((test, index) => {
      if (test.role !== 'test') {
        context.addIssue({
          code: 'custom',
          message: 'A candidate test must have the test role',
          path: ['candidate_tests', index, 'role'],
        });
      }
    });
  });

/** Validated impact artifact; completeness is always qualified. */
export type ChangeImpact = z.infer<typeof ChangeImpactSchema>;
