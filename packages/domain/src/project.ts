import { z } from 'zod';

import {
  ArtifactIdSchema,
  ConfidenceSchema,
  EvidenceReferenceListSchema,
  NonEmptyStringSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueStringListSchema,
} from './common.js';
import { duplicateIndexesBy } from './schema-helpers.js';

/** The epistemic status of a project observation. */
export const ObservationTypeSchema = z.enum([
  'fact',
  'interpretation',
  'assumption',
  'uncertainty',
  'decision',
  'known_debt',
]);

/** A fact, judgment, assumption, uncertainty, decision, or known debt item. */
export type ObservationType = z.infer<typeof ObservationTypeSchema>;

/** One evidence-linked statement about the project. */
export const ProjectObservationSchema = z
  .strictObject({
    id: ArtifactIdSchema,
    type: ObservationTypeSchema,
    statement: NonEmptyStringSchema,
    confidence: ConfidenceSchema,
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((observation, context) => {
    if (
      observation.type === 'decision' &&
      !observation.evidence.some(
        (evidence) => evidence.type === 'human_decision',
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A decision observation requires human-decision evidence',
        path: ['evidence'],
      });
    }
  });

/** A project statement that preserves its epistemic status and evidence. */
export type ProjectObservation = z.infer<typeof ProjectObservationSchema>;

const ProjectObservationListSchema = z
  .array(ProjectObservationSchema)
  .superRefine((observations, context) => {
    duplicateIndexesBy(observations, (observation) => observation.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Observation IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** A constraint that must shape project-specific guidance. */
export const ProjectConstraintSchema = z.strictObject({
  id: ArtifactIdSchema,
  category: z.enum([
    'business',
    'technical',
    'operational',
    'regulatory',
    'migration',
  ]),
  statement: NonEmptyStringSchema,
  status: z.enum(['confirmed', 'provisional']),
  evidence: EvidenceReferenceListSchema.min(1),
});

/** A confirmed or provisional project constraint with its basis. */
export type ProjectConstraint = z.infer<typeof ProjectConstraintSchema>;

const ProjectConstraintListSchema = z
  .array(ProjectConstraintSchema)
  .superRefine((constraints, context) => {
    duplicateIndexesBy(constraints, (constraint) => constraint.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Constraint IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** An unresolved project question whose impact remains visible. */
export const ProjectUncertaintySchema = z.strictObject({
  id: ArtifactIdSchema,
  statement: NonEmptyStringSchema,
  impact: NonEmptyStringSchema,
  resolution_required: z.boolean(),
  evidence: EvidenceReferenceListSchema.min(1),
});

/** An explicit uncertainty, including its consequence and available evidence. */
export type ProjectUncertainty = z.infer<typeof ProjectUncertaintySchema>;

const ProjectUncertaintyListSchema = z
  .array(ProjectUncertaintySchema)
  .superRefine((uncertainties, context) => {
    duplicateIndexesBy(uncertainties, (uncertainty) => uncertainty.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Uncertainty IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

const TechnologySchema = z.strictObject({
  category: z.enum([
    'language',
    'framework',
    'build_tool',
    'runtime',
    'test_framework',
    'quality_tool',
  ]),
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema.optional(),
});

const TechnologyListSchema = z
  .array(TechnologySchema)
  .superRefine((technologies, context) => {
    duplicateIndexesBy(
      technologies,
      (technology) => `${technology.category}\u0000${technology.name}`,
    ).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Technology category/name pairs must be unique',
        path: [index, 'name'],
      });
    });
  });

const ProjectModuleSchema = z.strictObject({
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  responsibilities: UniqueStringListSchema.min(1),
});

const ProjectModuleListSchema = z
  .array(ProjectModuleSchema)
  .superRefine((modules, context) => {
    duplicateIndexesBy(modules, (module) => module.name).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Module names must be unique',
        path: [index, 'name'],
      });
    });
    duplicateIndexesBy(modules, (module) => module.path).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Module paths must be unique',
        path: [index, 'path'],
      });
    });
  });

/** Evidence-aware normalized description of a project and its constraints. */
export const ProjectProfileSchema = z.strictObject({
  schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
  kind: z.literal('project_profile'),
  id: ArtifactIdSchema,
  name: NonEmptyStringSchema,
  technologies: TechnologyListSchema.min(1),
  modules: ProjectModuleListSchema.min(1),
  observations: ProjectObservationListSchema.min(1),
  constraints: ProjectConstraintListSchema,
  uncertainties: ProjectUncertaintyListSchema,
});

/** A validated provider-neutral project profile artifact. */
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
