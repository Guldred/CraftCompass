import { z } from 'zod';

import { duplicateIndexesBy } from './schema-helpers.js';

/** The only artifact schema version understood by this release. */
export const SUPPORTED_SCHEMA_VERSION = 1 as const;

export const NonEmptyStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim().length > 0,
    'Must contain non-whitespace text',
  );

export const ArtifactIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'Must start with an alphanumeric character and contain only letters, numbers, ., _, :, or -',
  );

export const UniqueArtifactIdListSchema = z
  .array(ArtifactIdSchema)
  .superRefine((values, context) => {
    duplicateIndexesBy(values, (value) => value).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Artifact references must be unique',
        path: [index],
      });
    });
  });

export const ConfidenceSchema = z
  .number()
  .min(0, 'Confidence must be at least 0')
  .max(1, 'Confidence must be at most 1');

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date in YYYY-MM-DD form')
  .refine((value) => {
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(timestamp) &&
      new Date(timestamp).toISOString().startsWith(value)
    );
  }, 'Expected a real calendar date');

export const IsoDateTimeSchema = z.iso.datetime({
  offset: true,
  precision: 0,
});

export const UniqueStringListSchema = z
  .array(NonEmptyStringSchema)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: 'custom',
          message: 'Entries must be unique',
          path: [index],
        });
      }
      seen.add(value);
    });
  });

/** Attribution metadata for a published or otherwise identifiable source. */
export const SourceReferenceSchema = z.strictObject({
  id: ArtifactIdSchema,
  type: z.enum([
    'book',
    'article',
    'talk',
    'social_post',
    'documentation',
    'standard',
    'project_document',
    'other',
  ]),
  title: NonEmptyStringSchema,
  author: NonEmptyStringSchema.optional(),
  url: z.url().optional(),
  published_on: IsoDateSchema.optional(),
  retrieved_on: IsoDateSchema,
  locator: NonEmptyStringSchema.optional(),
});

export const SourceReferenceListSchema = z
  .array(SourceReferenceSchema)
  .superRefine((references, context) => {
    duplicateIndexesBy(references, (reference) => reference.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Source reference IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** Source metadata attached to knowledge without embedding copied source text. */
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

/** A stable pointer to observed project or assurance evidence. */
export const EvidenceReferenceSchema = z.strictObject({
  id: ArtifactIdSchema,
  type: z.enum([
    'source_file',
    'build_configuration',
    'project_documentation',
    'architecture_decision',
    'code_graph',
    'git_change',
    'test_result',
    'quality_gate_result',
    'human_decision',
    'external_requirement',
    'other',
  ]),
  description: NonEmptyStringSchema,
  location: NonEmptyStringSchema,
  captured_at: IsoDateTimeSchema.optional(),
  provider: NonEmptyStringSchema.optional(),
  source_ref: ArtifactIdSchema.optional(),
});

export const EvidenceReferenceListSchema = z
  .array(EvidenceReferenceSchema)
  .superRefine((references, context) => {
    duplicateIndexesBy(references, (reference) => reference.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Evidence reference IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** A provider-neutral reference to evidence; it never claims what the evidence means. */
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
