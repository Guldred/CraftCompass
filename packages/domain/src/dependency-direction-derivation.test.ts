import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEPENDENCY_DIRECTION_PRINCIPLE_ID,
  deriveDependencyDirectionRule,
  type DependencyDirectionDerivationResult,
  type DependencyDirectionScenario,
} from './dependency-direction-derivation.js';
import { CraftsmanshipPrincipleSchema } from './knowledge.js';
import { ProjectProfileSchema, type ProjectProfile } from './project.js';
import { createArtifactRegistry } from './registry.js';

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
  id: DEPENDENCY_DIRECTION_PRINCIPLE_ID,
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

const expectSuccessful = (
  result: DependencyDirectionDerivationResult,
): Extract<DependencyDirectionDerivationResult, { readonly success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  return result;
};

interface ScenarioExpectation {
  readonly file: string;
  readonly scenario: DependencyDirectionScenario;
  readonly level: 'mandatory' | 'contextual';
  readonly existingViolations: 'forbidden' | 'baseline' | 'allowed';
  readonly migration: 'immediate' | 'baseline_and_ratcheting' | undefined;
  readonly confidence: number;
}

const scenarios: readonly ScenarioExpectation[] = [
  {
    file: 'new-business-service.json',
    scenario: 'new_business_service',
    level: 'mandatory',
    existingViolations: 'forbidden',
    migration: 'immediate',
    confidence: 0.96,
  },
  {
    file: 'legacy-monolith.json',
    scenario: 'legacy_monolith',
    level: 'mandatory',
    existingViolations: 'baseline',
    migration: 'baseline_and_ratcheting',
    confidence: 0.8,
  },
  {
    file: 'intentionally-simple-tool.json',
    scenario: 'intentionally_simple_tool',
    level: 'contextual',
    existingViolations: 'allowed',
    migration: undefined,
    confidence: 0.97,
  },
];

describe('dependency-direction derivation', () => {
  it.each(scenarios)(
    'derives the $scenario candidate from $file',
    async ({
      file,
      scenario,
      level,
      existingViolations,
      migration,
      confidence,
    }) => {
      const profile = await loadProfile(file);

      const derivation = expectSuccessful(
        deriveDependencyDirectionRule({
          principle: dependencyPrinciple,
          project: profile,
        }),
      );

      expect(derivation.scenario).toBe(scenario);
      expect(derivation.rule).toMatchObject({
        schema_version: 1,
        kind: 'project_rule',
        id: `RULE:${profile.id}:${dependencyPrinciple.id}:DEPENDENCY-DIRECTION:V1`,
        project_ref: profile.id,
        status: 'candidate',
        level,
        principle_refs: [dependencyPrinciple.id],
        confidence,
        scope: {
          change_types: ['new_code', 'modified_code'],
          existing_violations: existingViolations,
        },
      });
      expect(derivation.rule.migration?.approach).toBe(migration);
      expect(derivation.rule.enforcement.every((item) => !item.blocking)).toBe(
        true,
      );
      const expectedRoleObservationRefs = profile.modules.flatMap(
        (module) => module.architecture_role?.observation_refs ?? [],
      );
      expect(derivation.rule.observation_refs).toEqual(
        [
          ...new Set([
            ...(profile.adaptation_context?.observation_refs ?? []),
            ...expectedRoleObservationRefs,
          ]),
        ].sort(),
      );
      expect(derivation.rule.module_refs).toEqual(
        profile.modules.map((module) => module.name).sort(),
      );
      expect(derivation.rule.evidence.map((item) => item.id)).toEqual(
        [...derivation.rule.evidence.map((item) => item.id)].sort(),
      );
      expect(derivation.rule.evidence).toEqual(
        expect.arrayContaining(profile.modules[0]?.evidence ?? []),
      );
    },
  );

  it('scopes a dependency rule to business policy rather than technical adapters', async () => {
    const profile = await loadProfile('new-business-service.json');
    profile.modules.push({
      name: 'payments-adapter',
      path: 'src/payments/adapters',
      status: 'confirmed',
      architecture_role: {
        value: 'technical_adapter',
        status: 'confirmed',
        confidence: 1,
        observation_refs: ['OBS-PAYMENTS-ARCHITECTURE-DECISION'],
        evidence: [
          {
            id: 'EV-PAYMENTS-ARCHITECTURE-DECISION',
            type: 'human_decision',
            description:
              'The team accepted an explicit policy-to-adapter dependency direction.',
            location: 'docs/decisions/payment-boundaries.md',
          },
        ],
      },
      responsibilities: ['Payment transport and persistence integration.'],
      evidence: [
        {
          id: 'EV-PAYMENTS-ADAPTER',
          type: 'source_file',
          description: 'The adapter source root contains technical details.',
          location: 'src/payments/adapters',
        },
      ],
    });

    const derivation = expectSuccessful(
      deriveDependencyDirectionRule({
        principle: dependencyPrinciple,
        project: profile,
      }),
    );

    expect(derivation.rule.scope.include).toEqual(['src/payments/domain/**']);
    expect(derivation.rule.module_refs).toEqual(['payments-domain']);
    expect(derivation.rule.evidence.map((evidence) => evidence.id)).toContain(
      'EV-PAYMENTS-MODULE',
    );
  });

  it('requires a decision when a semantic module role is only a candidate', async () => {
    const profile = await loadProfile('new-business-service.json');
    const role = profile.modules[0]?.architecture_role;
    expect(role).toBeDefined();
    if (role === undefined) {
      return;
    }
    role.status = 'candidate';

    const derivation = expectSuccessful(
      deriveDependencyDirectionRule({
        principle: dependencyPrinciple,
        project: profile,
      }),
    );

    expect(derivation.scenario).toBe('requires_decision');
    expect(derivation.rule.level).toBe('requires_decision');
  });

  it('includes semantic module-role confidence in rule confidence', async () => {
    const profile = await loadProfile('new-business-service.json');
    const role = profile.modules[0]?.architecture_role;
    expect(role).toBeDefined();
    if (role === undefined) {
      return;
    }
    role.confidence = 0.1;

    const derivation = expectSuccessful(
      deriveDependencyDirectionRule({
        principle: dependencyPrinciple,
        project: profile,
      }),
    );

    expect(derivation.rule.confidence).toBe(0.1);
  });

  it.each(scenarios)(
    'produces a registry-valid trace for $scenario',
    async ({ file }) => {
      const profile = await loadProfile(file);
      const derivation = expectSuccessful(
        deriveDependencyDirectionRule({
          principle: dependencyPrinciple,
          project: profile,
        }),
      );

      const registry = createArtifactRegistry([
        {
          origin: 'rules/derived.yaml',
          artifact: derivation.rule,
        },
        {
          origin: 'projects/profile.yaml',
          artifact: profile,
        },
        {
          origin: 'knowledge/dependency.yaml',
          artifact: dependencyPrinciple,
        },
      ]);

      expect(registry).toMatchObject({
        success: true,
      });
    },
  );

  it('returns a non-blocking requires-decision candidate when adaptation context is missing', async () => {
    const profile = await loadProfile('intentionally-simple-tool.json');
    delete profile.adaptation_context;

    const derivation = expectSuccessful(
      deriveDependencyDirectionRule({
        principle: dependencyPrinciple,
        project: profile,
      }),
    );

    expect(derivation.scenario).toBe('requires_decision');
    expect(derivation.rule.level).toBe('requires_decision');
    expect(derivation.rule.status).toBe('candidate');
    expect(derivation.rule.confidence).toBe(0.5);
    expect(derivation.rule.observation_refs).toEqual([
      'OBS-SIMPLE-TOOL-DECISION',
    ]);
    expect(derivation.rule.enforcement).toEqual([
      expect.objectContaining({
        mechanism: 'human_review',
        blocking: false,
      }),
    ]);
  });

  it('requires a decision when the foundational principle is contested', async () => {
    const profile = await loadProfile('new-business-service.json');
    const contested = structuredClone(dependencyPrinciple);
    contested.lifecycle = 'contested';

    const derivation = expectSuccessful(
      deriveDependencyDirectionRule({
        principle: contested,
        project: profile,
      }),
    );

    expect(derivation.scenario).toBe('requires_decision');
    expect(derivation.rule.level).toBe('requires_decision');
    expect(derivation.rule.enforcement.every((item) => !item.blocking)).toBe(
      true,
    );
  });

  it('refuses to derive from a superseded principle', async () => {
    const profile = await loadProfile('new-business-service.json');
    const superseded = structuredClone(dependencyPrinciple);
    superseded.lifecycle = 'superseded';

    const result = deriveDependencyDirectionRule({
      principle: superseded,
      project: profile,
    });

    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: 'superseded_principle',
          path: '$.principle.lifecycle',
          message:
            'Superseded principle ARCH-DEPENDENCY-DIRECTION-001 cannot produce a candidate rule',
        },
      ],
    });
  });

  it('rejects a different principle instead of pretending the recipe is generic', async () => {
    const profile = await loadProfile('new-business-service.json');
    const unsupported = structuredClone(dependencyPrinciple);
    unsupported.id = 'ARCH-ANOTHER-PRINCIPLE';

    const result = deriveDependencyDirectionRule({
      principle: unsupported,
      project: profile,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]).toMatchObject({
        code: 'unsupported_principle',
        path: '$.principle.id',
      });
    }
  });

  it('rejects an adaptation-context observation absent from the project', async () => {
    const profile = await loadProfile('new-business-service.json');
    expect(profile.adaptation_context).toBeDefined();
    if (profile.adaptation_context === undefined) {
      return;
    }
    profile.adaptation_context.observation_refs = ['OBS-MISSING'];

    const result = deriveDependencyDirectionRule({
      principle: dependencyPrinciple,
      project: profile,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        {
          code: 'invalid_context_reference',
          path: '$.adaptation_context.observation_refs[0]',
          message:
            'Adaptation-context observation OBS-MISSING does not resolve in project PROJECT-PAYMENTS-NEW',
        },
      ]);
    }
  });

  it('rejects conflicting definitions of one evidence identity in its basis', async () => {
    const profile = await loadProfile('legacy-monolith.json');
    const firstEvidence = profile.observations[0]?.evidence[0];
    const secondEvidence = profile.observations[1]?.evidence[0];
    expect(firstEvidence).toBeDefined();
    expect(secondEvidence).toBeDefined();
    if (firstEvidence === undefined || secondEvidence === undefined) {
      return;
    }
    secondEvidence.id = firstEvidence.id;

    const result = deriveDependencyDirectionRule({
      principle: dependencyPrinciple,
      project: profile,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe('conflicting_evidence');
      expect(result.issues[0]?.message).toContain(firstEvidence.id);
    }
  });

  it('requires a decision instead of inventing a business-policy scope', async () => {
    const profile = await loadProfile('new-business-service.json');
    profile.modules = [];

    const derivation = expectSuccessful(
      deriveDependencyDirectionRule({
        principle: dependencyPrinciple,
        project: profile,
      }),
    );

    expect(derivation.scenario).toBe('requires_decision');
    expect(derivation.rule.level).toBe('requires_decision');
    expect(derivation.rule.scope.include).toEqual(['**/*']);
  });

  it('is invariant to project collection and context-reference order', async () => {
    const profile = await loadProfile('legacy-monolith.json');
    const reordered = structuredClone(profile);
    reordered.observations.reverse();
    reordered.modules.reverse();
    expect(reordered.adaptation_context).toBeDefined();
    if (reordered.adaptation_context === undefined) {
      return;
    }
    reordered.adaptation_context.observation_refs.reverse();
    reordered.adaptation_context.evidence.reverse();

    const first = deriveDependencyDirectionRule({
      principle: dependencyPrinciple,
      project: profile,
    });
    const second = deriveDependencyDirectionRule({
      principle: dependencyPrinciple,
      project: reordered,
    });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
