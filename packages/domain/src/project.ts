import { z } from 'zod';

import {
  ArtifactIdSchema,
  ConfidenceSchema,
  EvidenceReferenceListSchema,
  NonEmptyStringSchema,
  RepositoryRelativePathSchema,
  SUPPORTED_SCHEMA_VERSION,
  UniqueArtifactIdListSchema,
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

/** Evidence-linked technology declaration observed in repository configuration. */
export const TechnologySchema = z.strictObject({
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
  evidence: EvidenceReferenceListSchema.min(1),
});

/** A declared technology with the evidence used to detect it. */
export type Technology = z.infer<typeof TechnologySchema>;

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

/** Evidence-backed semantic role assigned separately from a module boundary. */
export const ProjectModuleRoleSchema = z
  .strictObject({
    value: z.enum(['business_policy', 'technical_adapter', 'mixed', 'unknown']),
    status: z.enum(['candidate', 'confirmed']),
    confidence: ConfidenceSchema,
    observation_refs: UniqueArtifactIdListSchema.min(1),
    evidence: EvidenceReferenceListSchema.min(1),
  })
  .superRefine((role, context) => {
    if (
      role.status === 'confirmed' &&
      !role.evidence.some((evidence) => evidence.type === 'human_decision')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A confirmed semantic module role requires human-decision evidence',
        path: ['evidence'],
      });
    }
  });

/** Provider-neutral evidence describing how a candidate module was discovered. */
export const ProjectModuleDiscoverySchema = z
  .strictObject({
    basis: z.enum([
      'manifest_declaration',
      'manifest_presence',
      'source_layout',
    ]),
    selection: z.enum([
      'unconditional',
      'default_candidate',
      'conditional',
      'unknown',
    ]),
    context: NonEmptyStringSchema.optional(),
  })
  .superRefine((discovery, context) => {
    if (
      (discovery.selection === 'default_candidate' ||
        discovery.selection === 'conditional') &&
      discovery.context === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Default-candidate and conditional module discovery requires context',
        path: ['context'],
      });
    }
  });

/** How a candidate module was discovered and selected. */
export type ProjectModuleDiscovery = z.infer<
  typeof ProjectModuleDiscoverySchema
>;

/** Candidate or confirmed project boundary backed by repository evidence. */
export const ProjectModuleSchema = z.strictObject({
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  status: z.enum(['candidate', 'confirmed']),
  discovery: ProjectModuleDiscoverySchema.optional(),
  architecture_role: ProjectModuleRoleSchema.optional(),
  responsibilities: UniqueStringListSchema,
  evidence: EvidenceReferenceListSchema.min(1),
});

/** One evidence-linked source or module boundary. */
export type ProjectModule = z.infer<typeof ProjectModuleSchema>;

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

/** Explicit context used for deterministic, proportionate rule adaptation. */
export const AdaptationContextSchema = z.strictObject({
  delivery_stage: z.enum(['greenfield', 'evolving', 'legacy', 'unknown']),
  architecture_scale: z.enum([
    'simple_application',
    'modular_system',
    'distributed_system',
    'unknown',
  ]),
  business_criticality: z.enum([
    'low',
    'medium',
    'high',
    'critical',
    'unknown',
  ]),
  architecture_intent: z.enum(['explicit', 'inferred', 'unknown']),
  confidence: ConfidenceSchema,
  observation_refs: z
    .array(ArtifactIdSchema)
    .min(1)
    .superRefine((references, context) => {
      duplicateIndexesBy(references, (reference) => reference).forEach(
        (index) => {
          context.addIssue({
            code: 'custom',
            message: 'Adaptation-context observation references must be unique',
            path: [index],
          });
        },
      );
    }),
  evidence: EvidenceReferenceListSchema.min(1),
});

/** Human- or evidence-supplied context; it is never guessed from naming alone. */
export type AdaptationContext = z.infer<typeof AdaptationContextSchema>;

/** One provider-neutral repository-observation capability declaration. */
export const RepositoryObservationCapabilitySchema = z.strictObject({
  id: ArtifactIdSchema,
  status: z.enum(['supported', 'partial', 'unsupported']),
});

/** Declared support level for one provider-neutral observation capability. */
export type RepositoryObservationCapability = z.infer<
  typeof RepositoryObservationCapabilitySchema
>;

const RepositoryObservationCapabilityListSchema = z
  .array(RepositoryObservationCapabilitySchema)
  .superRefine((capabilities, context) => {
    duplicateIndexesBy(capabilities, (capability) => capability.id).forEach(
      (index) => {
        context.addIssue({
          code: 'custom',
          message: 'Repository-observation capability IDs must be unique',
          path: [index, 'id'],
        });
      },
    );
  });

/** A normalized input kind observed without exposing provider parser types. */
export const RepositoryObservationInputKindSchema = z.enum([
  'manifest',
  'configuration',
  'lockfile',
  'source_root',
  'directory',
  'project_documentation',
]);

/** The provider-neutral kind of one observed repository input. */
export type RepositoryObservationInputKind = z.infer<
  typeof RepositoryObservationInputKindSchema
>;

/** One bounded repository input and the outcome of observing it. */
export const RepositoryObservationInputSchema = z.strictObject({
  path: z.union([z.literal('.'), RepositoryRelativePathSchema]),
  kind: RepositoryObservationInputKindSchema,
  status: z.enum([
    'parsed',
    'observed',
    'unsupported',
    'failed',
    'skipped_by_limit',
  ]),
  evidence: EvidenceReferenceListSchema.min(1),
});

/** A bounded repository input and its observation outcome. */
export type RepositoryObservationInput = z.infer<
  typeof RepositoryObservationInputSchema
>;

const RepositoryObservationInputListSchema = z
  .array(RepositoryObservationInputSchema)
  .superRefine((inputs, context) => {
    duplicateIndexesBy(inputs, (input) => input.path).forEach((index) => {
      context.addIssue({
        code: 'custom',
        message: 'Repository-observation input paths must be unique',
        path: [index, 'path'],
      });
    });
  });

/** Explicit finite limits applied while observing repository inputs. */
export const RepositoryObservationLimitsSchema = z.strictObject({
  max_declared_module_depth: z.number().int().nonnegative(),
  max_declared_module_declarations: z.number().int().nonnegative(),
  max_discovery_depth: z.number().int().nonnegative(),
  max_directories: z.number().int().nonnegative(),
  max_entries_per_directory: z.number().int().nonnegative(),
  max_manifests: z.number().int().nonnegative(),
  max_total_manifest_bytes: z.number().int().nonnegative(),
});

/** Finite bounds declared by a repository-observation provider. */
export type RepositoryObservationLimits = z.infer<
  typeof RepositoryObservationLimitsSchema
>;

/** Provider-neutral coverage and provenance for one repository observation. */
export const RepositoryObservationCoverageSchema = z
  .strictObject({
    status: z.enum(['complete_for_declared_scope', 'partial', 'unknown']),
    provider: z.strictObject({
      id: NonEmptyStringSchema,
      contract_version: NonEmptyStringSchema,
    }),
    capabilities: RepositoryObservationCapabilityListSchema,
    inputs: RepositoryObservationInputListSchema,
    limits: RepositoryObservationLimitsSchema.optional(),
    limitations: UniqueStringListSchema,
  })
  .superRefine((coverage, context) => {
    if (coverage.status === 'complete_for_declared_scope') {
      if (coverage.capabilities.length === 0) {
        context.addIssue({
          code: 'custom',
          message:
            'Complete repository observation requires at least one supported capability',
          path: ['capabilities'],
        });
      }
      coverage.capabilities.forEach((capability, capabilityIndex) => {
        if (capability.status !== 'supported') {
          context.addIssue({
            code: 'custom',
            message:
              'Complete repository observation cannot include partial or unsupported capabilities',
            path: ['capabilities', capabilityIndex, 'status'],
          });
        }
      });
      if (coverage.inputs.length === 0) {
        context.addIssue({
          code: 'custom',
          message:
            'Complete repository observation requires at least one assessed input',
          path: ['inputs'],
        });
      }
      coverage.inputs.forEach((input, inputIndex) => {
        if (input.status !== 'parsed' && input.status !== 'observed') {
          context.addIssue({
            code: 'custom',
            message:
              'Complete repository observation cannot include failed, skipped, or unsupported inputs',
            path: ['inputs', inputIndex, 'status'],
          });
        }
      });
      if (coverage.limitations.length > 0) {
        context.addIssue({
          code: 'custom',
          message:
            'Complete repository observation cannot retain unresolved limitations',
          path: ['limitations'],
        });
      }
    }
    if (
      (coverage.status === 'partial' || coverage.status === 'unknown') &&
      coverage.limitations.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Partial or unknown repository observation requires at least one limitation',
        path: ['limitations'],
      });
    }
  });

/** Coverage metadata that qualifies a repository-derived project profile. */
export type RepositoryObservationCoverage = z.infer<
  typeof RepositoryObservationCoverageSchema
>;

/** Evidence-aware normalized description of a project and its constraints. */
export const ProjectProfileSchema = z
  .strictObject({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    kind: z.literal('project_profile'),
    id: ArtifactIdSchema,
    name: NonEmptyStringSchema,
    technologies: TechnologyListSchema,
    modules: ProjectModuleListSchema,
    observations: ProjectObservationListSchema.min(1),
    constraints: ProjectConstraintListSchema,
    uncertainties: ProjectUncertaintyListSchema,
    observation_coverage: RepositoryObservationCoverageSchema.optional(),
    adaptation_context: AdaptationContextSchema.optional(),
  })
  .superRefine((profile, context) => {
    const observations = new Map(
      profile.observations.map((observation) => [observation.id, observation]),
    );
    profile.modules.forEach((module, moduleIndex) => {
      const role = module.architecture_role;
      if (role === undefined) {
        return;
      }
      const roleEvidence = new Map(
        role.evidence.map((evidence) => [evidence.id, evidence]),
      );
      const referencedRoleEvidence = new Map<
        string,
        (typeof role.evidence)[number]
      >();
      role.observation_refs.forEach((reference, referenceIndex) => {
        const observation = observations.get(reference);
        if (observation === undefined) {
          context.addIssue({
            code: 'custom',
            message:
              'A module role must reference an observation in this profile',
            path: [
              'modules',
              moduleIndex,
              'architecture_role',
              'observation_refs',
              referenceIndex,
            ],
          });
          return;
        }
        observation.evidence.forEach((evidence) => {
          referencedRoleEvidence.set(evidence.id, evidence);
        });
      });
      const referencesDecision = role.observation_refs.some(
        (reference) => observations.get(reference)?.type === 'decision',
      );
      if (role.status === 'confirmed' && !referencesDecision) {
        context.addIssue({
          code: 'custom',
          message:
            'A confirmed semantic module role must reference a project decision',
          path: [
            'modules',
            moduleIndex,
            'architecture_role',
            'observation_refs',
          ],
        });
      }
      role.evidence.forEach((evidence, evidenceIndex) => {
        const referenced = referencedRoleEvidence.get(evidence.id);
        if (
          referenced === undefined ||
          JSON.stringify(referenced) !== JSON.stringify(evidence)
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Module-role evidence must come from its referenced observations',
            path: [
              'modules',
              moduleIndex,
              'architecture_role',
              'evidence',
              evidenceIndex,
            ],
          });
        }
      });
      referencedRoleEvidence.forEach((evidence, id) => {
        const reproduced = roleEvidence.get(id);
        if (
          reproduced === undefined ||
          JSON.stringify(reproduced) !== JSON.stringify(evidence)
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'A module role must include all evidence from its referenced observations',
            path: ['modules', moduleIndex, 'architecture_role', 'evidence'],
          });
        }
      });
    });
    if (profile.adaptation_context === undefined) {
      return;
    }
    const referencedEvidence = new Map(
      profile.adaptation_context.observation_refs.flatMap((reference) => {
        const observation = observations.get(reference);
        return observation === undefined
          ? []
          : observation.evidence.map((evidence) => [evidence.id, evidence]);
      }),
    );
    profile.adaptation_context.observation_refs.forEach((reference, index) => {
      if (!observations.has(reference)) {
        context.addIssue({
          code: 'custom',
          message:
            'Adaptation context must reference an observation in this profile',
          path: ['adaptation_context', 'observation_refs', index],
        });
      }
    });
    profile.adaptation_context.evidence.forEach((evidence, index) => {
      const referenced = referencedEvidence.get(evidence.id);
      if (
        referenced === undefined ||
        JSON.stringify(referenced) !== JSON.stringify(evidence)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Adaptation-context evidence must come from its referenced observations',
          path: ['adaptation_context', 'evidence', index],
        });
      }
    });
    const contextEvidence = new Map(
      profile.adaptation_context.evidence.map((evidence) => [
        evidence.id,
        evidence,
      ]),
    );
    referencedEvidence.forEach((evidence, id) => {
      const reproduced = contextEvidence.get(id);
      if (
        reproduced === undefined ||
        JSON.stringify(reproduced) !== JSON.stringify(evidence)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Adaptation context must include all evidence from its referenced observations',
          path: ['adaptation_context', 'evidence'],
        });
      }
    });
  });

/** A validated provider-neutral project profile artifact. */
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
