import { z } from 'zod';

import {
  ArtifactIdSchema,
  IsoDateSchema,
  NonEmptyStringSchema,
  SourceReferenceListSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueStringListSchema,
} from './common.js';

/** Canonical knowledge maturity/source category for the first artifact version. */
export const KnowledgeMaturitySchema = z.enum([
  'foundational',
  'established_practice',
  'current_position',
  'emerging_experiment',
  'product_decision',
]);

/** How established, current, experimental, disputed, or product-owned knowledge is. */
export type KnowledgeMaturity = z.infer<typeof KnowledgeMaturitySchema>;

/** Lifecycle state kept separate from a knowledge statement's maturity/category. */
export const KnowledgeLifecycleSchema = z.enum([
  'active',
  'contested',
  'superseded',
]);

/** Whether knowledge is active, contested, or superseded. */
export type KnowledgeLifecycle = z.infer<typeof KnowledgeLifecycleSchema>;

const PracticeMaturitySchema = z.enum([
  'established_practice',
  'current_position',
  'emerging_experiment',
  'product_decision',
]);

export const ApplicabilitySchema = z.strictObject({
  contexts: UniqueStringListSchema.min(1),
  preconditions: UniqueStringListSchema,
  exclusions: UniqueStringListSchema,
});

export const EnforcementOptionSchema = z.strictObject({
  mechanism: z.enum([
    'deterministic_check',
    'ai_review',
    'human_review',
    'documentation',
  ]),
  suitability: z.enum(['strong', 'limited', 'contextual']),
  description: NonEmptyStringSchema,
});

/** A long-lived principle whose application still requires project context. */
export const CraftsmanshipPrincipleSchema = z.strictObject({
  schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
  kind: z.literal('craftsmanship_principle'),
  id: ArtifactIdSchema,
  maturity: z.literal('foundational'),
  lifecycle: KnowledgeLifecycleSchema,
  title: NonEmptyStringSchema,
  category: NonEmptyStringSchema,
  statement: NonEmptyStringSchema,
  rationale: NonEmptyStringSchema,
  warning_signals: UniqueStringListSchema.min(1),
  positive_signals: UniqueStringListSchema.min(1),
  counter_indications: UniqueStringListSchema,
  applicability: ApplicabilitySchema,
  enforcement_options: z.array(EnforcementOptionSchema).min(1),
  limitations: UniqueStringListSchema.min(1),
  source_references: SourceReferenceListSchema.min(1),
  product_interpretation: NonEmptyStringSchema,
});

/** A validated foundational craftsmanship principle artifact. */
export type CraftsmanshipPrinciple = z.infer<
  typeof CraftsmanshipPrincipleSchema
>;

/**
 * Attributed practice, position, experiment, disputed idea, or product decision.
 *
 * Foundational knowledge intentionally uses `CraftsmanshipPrinciple` instead.
 */
export const PracticeStatementSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('practice_statement'),
    id: ArtifactIdSchema,
    maturity: PracticeMaturitySchema,
    lifecycle: KnowledgeLifecycleSchema,
    title: NonEmptyStringSchema,
    author: NonEmptyStringSchema.optional(),
    statement: NonEmptyStringSchema,
    rationale: NonEmptyStringSchema,
    observed_on: IsoDateSchema.optional(),
    warning_signals: UniqueStringListSchema,
    positive_signals: UniqueStringListSchema,
    scope: UniqueStringListSchema.min(1),
    prerequisites: UniqueStringListSchema,
    supporting_mechanisms: UniqueStringListSchema,
    limitations: UniqueStringListSchema.min(1),
    must_not_be_interpreted_as: UniqueStringListSchema.min(1),
    source_references: SourceReferenceListSchema.min(1),
    product_interpretation: NonEmptyStringSchema,
  })
  .superRefine((statement, context) => {
    if (
      statement.maturity === 'current_position' &&
      (statement.author === undefined ||
        !statement.source_references.some(
          (reference) => reference.author === statement.author,
        ))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A current position requires an author and a matching authored source reference',
        path: ['author'],
      });
    }
  });

/** A validated, attributed non-foundational knowledge artifact. */
export type PracticeStatement = z.infer<typeof PracticeStatementSchema>;
