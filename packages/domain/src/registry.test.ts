import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deriveDependencyDirectionRule,
  type DependencyDirectionDerivationResult,
} from './dependency-direction-derivation.js';
import { AssurancePlanSchema, AssuranceProfileSchema } from './assurance.js';
import type { CraftArtifact } from './artifact.js';
import { CraftsmanshipPrincipleSchema } from './knowledge.js';
import { ProjectProfileSchema, type ProjectProfile } from './project.js';
import {
  createArtifactRegistry,
  findRegistryArtifact,
  type LocatedArtifact,
} from './registry.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const loadProfile = async (name: string): Promise<ProjectProfile> =>
  ProjectProfileSchema.parse(
    JSON.parse(
      await readFile(
        path.join(REPOSITORY_ROOT, 'fixtures/derivation', name),
        'utf8',
      ),
    ) as unknown,
  );

const dependencyPrinciple = CraftsmanshipPrincipleSchema.parse({
  schema_version: 1,
  kind: 'craftsmanship_principle',
  id: 'ARCH-DEPENDENCY-DIRECTION-001',
  maturity: 'foundational',
  lifecycle: 'active',
  title: 'Direct dependencies toward stable policy',
  category: 'architecture',
  statement:
    'Source-code dependencies should point toward policy rather than replaceable technical details.',
  rationale:
    'Stable policy remains independently changeable and testable when technical details depend inward.',
  warning_signals: ['Business policy imports framework or persistence types.'],
  positive_signals: ['Business policy runs without technical infrastructure.'],
  counter_indications: [
    'A deliberately simple tool may not benefit from another boundary.',
  ],
  applicability: {
    contexts: ['Systems containing independently valuable business policy.'],
    preconditions: ['The boundary represents a real reason to change.'],
    exclusions: [],
  },
  enforcement_options: [
    {
      mechanism: 'deterministic_check',
      suitability: 'strong',
      description: 'Check forbidden dependency directions.',
    },
  ],
  limitations: [
    'Dependency direction does not prove that responsibilities are appropriate.',
  ],
  source_references: [
    {
      id: 'SRC-DEPENDENCY-DIRECTION',
      type: 'book',
      title: 'A source concerning dependency direction',
      author: 'Example Author',
      retrieved_on: '2026-07-27',
      locator: 'Dependency direction',
    },
  ],
  product_interpretation:
    'Evaluate dependency direction against explicit project context.',
});

const deriveRule = (
  profile: ProjectProfile,
): Extract<DependencyDirectionDerivationResult, { readonly success: true }> => {
  const result = deriveDependencyDirectionRule({
    principle: dependencyPrinciple,
    project: profile,
  });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  return result;
};

const located = (origin: string, artifact: CraftArtifact): LocatedArtifact => ({
  origin,
  artifact,
});

const assuranceProfileFor = (
  projectRef: string,
): Extract<CraftArtifact, { readonly kind: 'assurance_profile' }> =>
  AssuranceProfileSchema.parse({
    schema_version: 1,
    kind: 'assurance_profile',
    id: 'ASSURANCE-PROFILE-REGISTRY',
    project_ref: projectRef,
    project_criticality: 'high',
    agent_generated_code_share: 'low',
    review_policy: {
      default_level: 1,
      always_review: ['Business intent.'],
      selective_review: [],
    },
    testing_policy: {
      unit_tests_required: true,
      acceptance_tests_required_for: [],
      integration_tests_required_for: [],
    },
    architecture_policy: {
      checks_required: true,
      baseline_existing_violations: false,
      fail_on_new_violations: true,
    },
    mutation_policy: {
      strategy: 'no_new_unexplained_survivors',
      changed_business_behavior: {
        new_unexplained_survivors: 'forbidden',
      },
      baseline: {
        existing_survivors: 'not_available',
        regression: 'forbidden',
      },
    },
    security_policy: {
      dependency_scanning_required: true,
      human_review_required_for: [],
    },
    exception_policy: {
      allowed: true,
      reason_required: true,
      owner_required: true,
      expiration_required: true,
      active_exceptions: [],
    },
  });

const assurancePlanFor = (
  projectRef: string,
): Extract<CraftArtifact, { readonly kind: 'assurance_plan' }> =>
  AssurancePlanSchema.parse({
    schema_version: 1,
    kind: 'assurance_plan',
    id: 'ASSURANCE-PLAN-REGISTRY',
    change_id: 'CHANGE-REGISTRY',
    project_ref: projectRef,
    assurance_profile_ref: 'ASSURANCE-PROFILE-REGISTRY',
    risk: {
      overall: 'medium',
      likelihood: 'medium',
      impact: 'medium',
      confidence: 0.8,
      factors: ['The change affects business policy.'],
      evidence: [
        {
          id: 'EV-CHANGE-REGISTRY',
          type: 'git_change',
          description: 'A business-policy change is proposed.',
          location: 'git:CHANGE-REGISTRY',
        },
      ],
    },
    impacted_flows: [],
    required_gates: [
      {
        id: 'GATE-REGISTRY-UNIT',
        type: 'unit_tests',
        blocking: true,
        reason: 'Changed policy needs focused unit tests.',
      },
    ],
    human_review: {
      level: 1,
      targets: ['Business intent.'],
      rationale: ['The project has not earned reduced review.'],
    },
    rationale: ['Run deterministic gates before review.'],
  });

describe('artifact registry', () => {
  it('resolves project, principle, observation, evidence, and assurance references', async () => {
    const profile = await loadProfile('new-business-service.json');
    const sourceReference = dependencyPrinciple.source_references[0];
    const observationEvidence = profile.observations[0]?.evidence[0];
    const contextEvidence = profile.adaptation_context?.evidence[0];
    expect(sourceReference).toBeDefined();
    expect(observationEvidence).toBeDefined();
    expect(contextEvidence).toBeDefined();
    if (
      sourceReference === undefined ||
      observationEvidence === undefined ||
      contextEvidence === undefined
    ) {
      return;
    }
    observationEvidence.source_ref = sourceReference.id;
    contextEvidence.source_ref = sourceReference.id;
    profile.modules[0]?.architecture_role?.evidence.forEach((evidence) => {
      if (evidence.id === observationEvidence.id) {
        evidence.source_ref = sourceReference.id;
      }
    });
    const derivation = deriveRule(profile);
    const entries = [
      located('rules/dependency.yaml', derivation.rule),
      located('assurance/profile.yaml', assuranceProfileFor(profile.id)),
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/payments.yaml', profile),
      located('assurance/plan.yaml', assurancePlanFor(profile.id)),
    ];

    const result = createArtifactRegistry(entries);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.registry.entries.map((entry) => entry.origin)).toEqual([
        'assurance/plan.yaml',
        'assurance/profile.yaml',
        'knowledge/dependency.yaml',
        'projects/payments.yaml',
        'rules/dependency.yaml',
      ]);
      expect(
        findRegistryArtifact(result.registry, derivation.rule.id)?.artifact,
      ).toEqual(derivation.rule);
    }
  });

  it('rejects duplicate top-level artifact identities deterministically', async () => {
    const profile = await loadProfile('new-business-service.json');
    const duplicate = structuredClone(profile);

    const result = createArtifactRegistry([
      located('z/project.yaml', duplicate),
      located('a/project.yaml', profile),
    ]);

    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: 'duplicate_artifact_id',
          origin: 'a/project.yaml',
          path: '$.id',
          message:
            'Artifact ID PROJECT-PAYMENTS-NEW is duplicated across: a/project.yaml, z/project.yaml',
        },
      ],
    });
  });

  it('reports a missing principle reference with its exact rule path', async () => {
    const profile = await loadProfile('new-business-service.json');
    const rule = structuredClone(deriveRule(profile).rule);
    rule.principle_refs = ['ARCH-MISSING'];

    const result = createArtifactRegistry([
      located('projects/payments.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_artifact_reference',
            origin: 'rules/dependency.yaml',
            path: '$.principle_refs[0]',
          }),
        ]),
      );
    }
  });

  it('distinguishes a wrong artifact kind from a missing reference', async () => {
    const profile = await loadProfile('new-business-service.json');
    const rule = structuredClone(deriveRule(profile).rule);
    rule.principle_refs = [profile.id];

    const result = createArtifactRegistry([
      located('projects/payments.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.issues.find(
        (candidate) =>
          candidate.code === 'wrong_artifact_kind' &&
          candidate.path === '$.principle_refs[0]',
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('expected craftsmanship_principle');
    }
  });

  it('reports ambiguous references to duplicated artifact IDs', async () => {
    const profile = await loadProfile('new-business-service.json');
    const duplicateProfile = structuredClone(profile);
    const rule = deriveRule(profile).rule;

    const result = createArtifactRegistry([
      located('projects/a.yaml', profile),
      located('projects/b.yaml', duplicateProfile),
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'ambiguous_artifact_reference',
            path: '$.project_ref',
          }),
        ]),
      );
    }
  });

  it('reports a rule observation missing from its referenced project', async () => {
    const profile = await loadProfile('new-business-service.json');
    const rule = structuredClone(deriveRule(profile).rule);
    rule.observation_refs = ['OBS-NOT-IN-PROJECT'];

    const result = createArtifactRegistry([
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/payments.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_observation_reference',
            path: '$.observation_refs[0]',
          }),
        ]),
      );
    }
  });

  it('rejects rule evidence whose content differs from project evidence', async () => {
    const profile = await loadProfile('new-business-service.json');
    const rule = structuredClone(deriveRule(profile).rule);
    const evidence = rule.evidence[0];
    expect(evidence).toBeDefined();
    if (evidence === undefined) {
      return;
    }
    evidence.description = 'A conflicting description of the same evidence.';

    const result = createArtifactRegistry([
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/payments.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'conflicting_evidence_reference',
            origin: 'rules/dependency.yaml',
            path: '$.evidence[0]',
          }),
          expect.objectContaining({
            code: 'evidence_mismatch',
            path: '$.evidence[0]',
          }),
        ]),
      );
    }
  });

  it('rejects omitted evidence from a referenced observation', async () => {
    const profile = await loadProfile('legacy-monolith.json');
    const rule = structuredClone(deriveRule(profile).rule);
    const retainedEvidence = rule.evidence[0];
    expect(retainedEvidence).toBeDefined();
    if (retainedEvidence === undefined) {
      return;
    }
    rule.evidence = [retainedEvidence];

    const result = createArtifactRegistry([
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/legacy.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_rule_evidence',
            path: '$.evidence',
          }),
        ]),
      );
    }
  });

  it('allows identical repeated evidence definitions', async () => {
    const profile = await loadProfile('new-business-service.json');
    const rule = deriveRule(profile).rule;

    const result = createArtifactRegistry([
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/payments.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(true);
  });

  it('scopes evidence identities to their owning projects', async () => {
    const first = await loadProfile('new-business-service.json');
    const second = await loadProfile('intentionally-simple-tool.json');
    const secondEvidence = second.modules[0]?.evidence[0];
    expect(secondEvidence).toBeDefined();
    if (secondEvidence === undefined) {
      return;
    }
    secondEvidence.id = 'EV-PAYMENTS-MODULE';

    const result = createArtifactRegistry([
      located('projects/payments.yaml', first),
      located('projects/tool.yaml', second),
    ]);

    expect(result.success).toBe(true);
  });

  it('reports a rule module missing from its referenced project', async () => {
    const profile = await loadProfile('new-business-service.json');
    const rule = structuredClone(deriveRule(profile).rule);
    rule.module_refs = ['missing-module'];

    const result = createArtifactRegistry([
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/payments.yaml', profile),
      located('rules/dependency.yaml', rule),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_module_reference',
            path: '$.module_refs[0]',
          }),
        ]),
      );
    }
  });

  it('rejects conflicting source-reference definitions', () => {
    const conflictingPrinciple = structuredClone(dependencyPrinciple);
    conflictingPrinciple.id = 'ARCH-DEPENDENCY-DIRECTION-ALTERNATE';
    const sourceReference = conflictingPrinciple.source_references[0];
    expect(sourceReference).toBeDefined();
    if (sourceReference === undefined) {
      return;
    }
    sourceReference.title = 'A conflicting source title';

    const result = createArtifactRegistry([
      located('knowledge/a.yaml', dependencyPrinciple),
      located('knowledge/b.yaml', conflictingPrinciple),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        {
          code: 'conflicting_source_reference',
          origin: 'knowledge/b.yaml',
          path: '$.source_references[0]',
          message:
            'Source reference SRC-DEPENDENCY-DIRECTION conflicts with its definition at knowledge/a.yaml$.source_references[0]',
        },
      ]);
    }
  });

  it('resolves evidence source references and rejects missing source IDs', async () => {
    const profile = await loadProfile('new-business-service.json');
    const observationEvidence = profile.observations[0]?.evidence[0];
    const contextEvidence = profile.adaptation_context?.evidence[0];
    expect(observationEvidence).toBeDefined();
    expect(contextEvidence).toBeDefined();
    if (observationEvidence === undefined || contextEvidence === undefined) {
      return;
    }
    observationEvidence.source_ref = 'SRC-NOT-PRESENT';
    contextEvidence.source_ref = 'SRC-NOT-PRESENT';

    const result = createArtifactRegistry([
      located('projects/payments.yaml', profile),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_source_reference',
            path: '$.observations[0].evidence[0].source_ref',
          }),
          expect.objectContaining({
            code: 'missing_source_reference',
            path: '$.adaptation_context.evidence[0].source_ref',
          }),
        ]),
      );
    }
  });

  it('validates assurance project references against the expected kind', async () => {
    const profile = await loadProfile('new-business-service.json');
    const assuranceProfile = assuranceProfileFor(dependencyPrinciple.id);
    const assurancePlan = assurancePlanFor('PROJECT-MISSING');

    const result = createArtifactRegistry([
      located('knowledge/dependency.yaml', dependencyPrinciple),
      located('projects/payments.yaml', profile),
      located('assurance/profile.yaml', assuranceProfile),
      located('assurance/plan.yaml', assurancePlan),
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'wrong_artifact_kind',
            origin: 'assurance/profile.yaml',
            path: '$.project_ref',
          }),
          expect.objectContaining({
            code: 'missing_artifact_reference',
            origin: 'assurance/plan.yaml',
            path: '$.project_ref',
          }),
        ]),
      );
    }
  });

  it('produces identical sorted issues and registry entries for every input order', async () => {
    const profile = await loadProfile('new-business-service.json');
    const conflictingRule = structuredClone(deriveRule(profile).rule);
    conflictingRule.module_refs = ['missing-module'];
    const conflictingEvidence = conflictingRule.evidence[0];
    expect(conflictingEvidence).toBeDefined();
    if (conflictingEvidence === undefined) {
      return;
    }
    conflictingEvidence.description = 'Conflicting evidence content.';
    const entries = [
      located('z/rule.yaml', conflictingRule),
      located('a/project.yaml', profile),
      located('m/knowledge.yaml', dependencyPrinciple),
    ];

    const forwardFailure = createArtifactRegistry(entries);
    const reverseFailure = createArtifactRegistry([...entries].reverse());

    expect(forwardFailure.success).toBe(false);
    expect(reverseFailure).toEqual(forwardFailure);

    const successEntries = [
      located('z/project.yaml', profile),
      located('a/knowledge.yaml', dependencyPrinciple),
    ];
    const forwardSuccess = createArtifactRegistry(successEntries);
    const reverseSuccess = createArtifactRegistry(
      [...successEntries].reverse(),
    );

    expect(reverseSuccess).toEqual(forwardSuccess);
  });
});
