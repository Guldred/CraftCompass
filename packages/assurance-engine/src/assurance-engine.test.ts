import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AssurancePlanSchema,
  AssuranceProfileSchema,
  ChangeContextSchema,
  ChangeImpactSchema,
  ProjectProfileSchema,
  createArtifactRegistry,
  validateArtifact,
  type AssuranceProfile,
  type ChangeConcern,
  type ChangeContext,
  type ChangeImpact,
  type EvidenceReference,
  type LocatedArtifact,
  type ProjectProfile,
} from '@craftcompass/domain';
import { describe, expect, it } from 'vitest';

import {
  DIFF_FALLBACK_CONFIDENCE_CAP,
  FakeCodeGraphProvider,
  analyzeChangeImpact,
  deriveAssurancePlan,
  deriveMutationScope,
  parseFakeCodeGraphScenario,
  type FakeCodeGraphScenario,
  type ImpactAnalysisResult,
} from './index.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const readJson = async (relativePath: string): Promise<unknown> =>
  JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8'),
  ) as unknown;

const loadProject = async (): Promise<ProjectProfile> =>
  ProjectProfileSchema.parse(
    await readJson('fixtures/derivation/new-business-service.json'),
  );

const scenarioNames = [
  'direct-impact',
  'indirect-impact',
  'low-confidence',
  'runtime-gap',
  'unavailable',
  'provider-error',
] as const;

type ScenarioName = (typeof scenarioNames)[number];

const loadScenario = async (
  name: ScenarioName,
): Promise<FakeCodeGraphScenario> =>
  parseFakeCodeGraphScenario(
    await readJson(`fixtures/code-graph/${name}.json`),
  );

const changeEvidenceFor = (id: string): EvidenceReference => ({
  id: `EV-${id}`,
  type: 'git_change',
  description: `The normalized diff for ${id}.`,
  location: `git:${id}`,
  provider: 'git',
});

interface ChangeOptions {
  readonly id?: string;
  readonly projectRef?: string;
  readonly concerns?: readonly ChangeConcern[];
  readonly nature?: 'behavior_preserving' | 'behavior_changing' | 'unknown';
  readonly includeProductionTarget?: boolean;
  readonly includeChangedSymbols?: boolean;
}

const changeFor = (options: ChangeOptions = {}): ChangeContext => {
  const id = options.id ?? 'CHANGE-CANCELLATION';
  const evidence = changeEvidenceFor(id);
  return ChangeContextSchema.parse({
    schema_version: 1,
    kind: 'change_context',
    id,
    project_ref: options.projectRef ?? 'PROJECT-PAYMENTS-NEW',
    summary: 'Change cancellation behavior.',
    nature: options.nature ?? 'behavior_changing',
    concerns: options.concerns ?? [
      'business_rule',
      'externally_observable_behavior',
    ],
    agent_generated_code_share: 'medium',
    changed_files: [
      {
        path: 'src/main/java/example/order/domain/OrderCancellationService.java',
        change_type: 'modified',
        role: 'production',
        evidence: [evidence],
      },
    ],
    changed_symbols:
      options.includeChangedSymbols === false
        ? []
        : [
            {
              qualified_name:
                'example.order.domain.OrderCancellationService.cancelOrder',
              kind: 'method',
              role: 'production',
              file: 'src/main/java/example/order/domain/OrderCancellationService.java',
              ...(options.includeProductionTarget === false
                ? {}
                : { target: 'example.order.domain.OrderCancellationService' }),
              confidence: 1,
              evidence: [evidence],
            },
          ],
    evidence: [evidence],
  });
};

const readinessEvidence: EvidenceReference = {
  id: 'EV-ASSURANCE-READINESS',
  type: 'human_decision',
  description: 'The team approved the recorded assurance-readiness state.',
  location: 'decision:assurance-readiness',
};

const assuranceProfileFor = (
  projectRef: string,
  projectCriticality: 'low' | 'medium' | 'high' | 'critical' = 'high',
): AssuranceProfile =>
  AssuranceProfileSchema.parse({
    schema_version: 1,
    kind: 'assurance_profile',
    id: `ASSURANCE-${projectRef}`,
    project_ref: projectRef,
    project_criticality: projectCriticality,
    agent_generated_code_share: 'medium',
    review_policy: {
      default_level: 2,
      always_review: ['Business intent.'],
      selective_review: ['Legacy prose that the planner must not interpret.'],
      always_review_concerns: ['business_rule'],
      selective_review_concerns: ['public_api'],
    },
    testing_policy: {
      unit_tests_required: true,
      acceptance_tests_required_for: [
        'Legacy prose that the planner must not interpret.',
      ],
      integration_tests_required_for: [
        'Other legacy prose that the planner must not interpret.',
      ],
      acceptance_concerns: ['business_rule', 'externally_observable_behavior'],
      integration_concerns: [
        'persistence',
        'messaging',
        'external_service',
        'new_external_entry_point',
      ],
    },
    architecture_policy: {
      checks_required: true,
      baseline_existing_violations: true,
      fail_on_new_violations: true,
    },
    mutation_policy: {
      strategy: 'no_new_unexplained_survivors',
      changed_business_behavior: {
        new_unexplained_survivors: 'forbidden',
      },
      baseline: {
        existing_survivors: 'classify_and_track',
        regression: 'forbidden',
      },
      score: {
        report: true,
        decision_role: 'context_only',
      },
    },
    security_policy: {
      dependency_scanning_required: true,
      human_review_required_for: [
        'Legacy prose that the planner must not interpret.',
      ],
      human_review_concerns: [
        'authorization',
        'sensitive_data',
        'new_external_entry_point',
        'security',
      ],
    },
    exception_policy: {
      allowed: true,
      reason_required: true,
      owner_required: true,
      expiration_required: true,
      active_exceptions: [],
    },
    readiness: {
      test_reliability: 'established',
      architecture_checks: 'established',
      mutation_baseline: 'available',
      impact_analysis: 'reliable',
      rollback: 'supported',
      evidence: [readinessEvidence],
    },
  });

interface ObservedImpactOptions {
  readonly confidence?: number;
  readonly directProductionSymbols?: number;
  readonly indirectProductionSymbols?: number;
  readonly flows?: number;
  readonly status?: 'available' | 'degraded';
}

const observedImpactFor = (
  change: ChangeContext,
  options: ObservedImpactOptions = {},
): ChangeImpact => {
  const directCount = options.directProductionSymbols ?? 1;
  const indirectCount = options.indirectProductionSymbols ?? 0;
  const flowCount = options.flows ?? 1;
  const status = options.status ?? 'available';
  const graphEvidence: EvidenceReference = {
    id: `EV-OBSERVED-${change.id}`,
    type: 'code_graph',
    description: `Observed impact data for ${change.id}.`,
    location: `graph:${change.id}`,
    provider: 'observed-code-graph',
  };
  const symbol = (
    prefix: string,
    index: number,
  ): {
    qualified_name: string;
    kind: 'method';
    role: 'production';
    target: string;
    confidence: number;
    evidence: EvidenceReference[];
  } => ({
    qualified_name: `example.order.impact.${prefix}${index}.run`,
    kind: 'method',
    role: 'production',
    target: `example.order.impact.${prefix}${index}`,
    confidence: options.confidence ?? 0.92,
    evidence: [graphEvidence],
  });
  return ChangeImpactSchema.parse({
    schema_version: 1,
    kind: 'change_impact',
    id: `IMPACT-${change.id}`,
    project_ref: change.project_ref,
    change_ref: change.id,
    status,
    source: 'code_graph',
    completeness: status === 'available' ? 'partial' : 'unknown',
    provider: {
      id: 'observed-code-graph',
      evidence_kind: 'observed',
    },
    evidence_use: 'decision',
    changed_symbols: change.changed_symbols,
    direct_impacts: Array.from({ length: directCount }, (_, index) => ({
      symbol: symbol('Direct', index + 1),
      distance: 1,
      relationships: ['calls'],
    })),
    indirect_impacts: Array.from({ length: indirectCount }, (_, index) => ({
      symbol: symbol('Indirect', index + 1),
      distance: index + 2,
      relationships: ['calls', 'returns_to'],
    })),
    impacted_flows: Array.from({ length: flowCount }, (_, index) => ({
      id: `FLOW-OBSERVED-${index + 1}`,
      name: `Observed flow ${index + 1}`,
      symbol_refs:
        directCount > 0
          ? [`example.order.impact.Direct1.run`]
          : [change.changed_symbols[0]?.qualified_name ?? change.id],
      evidence: [graphEvidence],
    })),
    functional_clusters: [],
    candidate_tests: [],
    confidence: options.confidence ?? 0.92,
    limitations:
      status === 'degraded'
        ? ['Observed provider reported incomplete impact data.']
        : [],
    evidence: [...change.evidence, graphEvidence],
  });
};

const analyzeScenario = async (
  name: ScenarioName,
  project: ProjectProfile,
  change: ChangeContext,
): Promise<ImpactAnalysisResult> =>
  analyzeChangeImpact({
    id: `IMPACT-${name.toUpperCase()}`,
    project,
    change,
    provider: new FakeCodeGraphProvider(
      `fake-${name}`,
      await loadScenario(name),
    ),
  });

const requireImpact = (
  result: ImpactAnalysisResult,
): Extract<ImpactAnalysisResult, { readonly success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  return result;
};

describe('synthetic code-graph fixtures and impact normalization', () => {
  it.each(scenarioNames)('strictly parses the %s scenario', async (name) => {
    expect((await loadScenario(name)).mode).toBeDefined();
  });

  it('keeps the fake provider permanently synthetic and rejects extra fixture fields', async () => {
    const scenario = await loadScenario('direct-impact');
    const provider = new FakeCodeGraphProvider('fake-direct', scenario);

    expect(provider.evidenceKind).toBe('synthetic');
    expect(() =>
      parseFakeCodeGraphScenario({
        ...(scenario as object),
        evidence_kind: 'observed',
      }),
    ).toThrow(/Unexpected fake code-graph scenario fields/);
  });

  it('normalizes direct impact into primary mutation targets and relevant tests', async () => {
    const project = await loadProject();
    const change = changeFor();
    const { impact } = requireImpact(
      await analyzeScenario('direct-impact', project, change),
    );

    expect(impact.provider.evidence_kind).toBe('synthetic');
    expect(impact.evidence_use).toBe('synthetic_test_only');
    expect(
      impact.direct_impacts.map((item) => item.symbol.qualified_name),
    ).toEqual(['example.order.domain.CancellationPolicy.mayCancel']);
    const scope = deriveMutationScope(change, impact);
    expect(scope.success).toBe(true);
    if (scope.success) {
      expect(scope.scope.primary_targets).toEqual([
        'example.order.domain.CancellationPolicy',
        'example.order.domain.OrderCancellationService',
      ]);
      expect(scope.scope.supporting_targets).toEqual([]);
      expect(scope.scope.relevant_tests).toEqual([
        'example.order.domain.OrderCancellationServiceTest',
      ]);
    }
  });

  it('keeps indirect impact separate as supporting mutation scope', async () => {
    const project = await loadProject();
    const change = changeFor();
    const { impact } = requireImpact(
      await analyzeScenario('indirect-impact', project, change),
    );
    const scope = deriveMutationScope(change, impact);

    expect(scope.success).toBe(true);
    if (scope.success) {
      expect(scope.scope.supporting_targets).toEqual([
        'example.order.domain.RefundDecision',
      ]);
    }
  });

  it('retains low confidence and runtime limitations instead of claiming completeness', async () => {
    const project = await loadProject();
    const change = changeFor();
    const low = requireImpact(
      await analyzeScenario('low-confidence', project, change),
    ).impact;
    const runtimeGap = requireImpact(
      await analyzeScenario('runtime-gap', project, change),
    ).impact;

    expect(low).toMatchObject({
      status: 'degraded',
      completeness: 'unknown',
      confidence: 0.42,
    });
    expect(low.limitations).toEqual([
      'Dependency-injection relationships may be absent.',
      'Only a subset of symbols resolved.',
    ]);
    expect(runtimeGap.status).toBe('degraded');
    expect(runtimeGap.limitations).toContain(
      'Runtime message consumers are known but absent from the static graph.',
    );
  });

  it.each(['unavailable', 'provider-error'] as const)(
    'falls back conservatively for %s without a false empty graph success',
    async (name) => {
      const project = await loadProject();
      const change = changeFor();
      const { impact } = requireImpact(
        await analyzeScenario(name, project, change),
      );

      expect(impact).toMatchObject({
        status: 'degraded',
        source: 'diff_fallback',
        completeness: 'unknown',
        confidence: DIFF_FALLBACK_CONFIDENCE_CAP,
        direct_impacts: [],
        indirect_impacts: [],
        impacted_flows: [],
        functional_clusters: [],
      });
      expect(impact.changed_symbols).toHaveLength(1);
      expect(impact.limitations.join(' ')).toContain(
        'only changed production symbols are in scope',
      );
    },
  );

  it('intentionally rejects changed-file-only fallback before artifact construction', async () => {
    const project = await loadProject();
    const result = await analyzeScenario(
      'unavailable',
      project,
      changeFor({
        id: 'CHANGE-FILE-ONLY',
        includeChangedSymbols: false,
      }),
    );

    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: 'no_changed_production_symbols',
          path: '$.changed_symbols',
          message:
            'Code-graph provider fake-unavailable is unavailable: No graph index is available for the requested revision.; no changed production symbol with an explicit target is available for fallback',
        },
        {
          code: 'provider_unavailable',
          path: '$.provider',
          message:
            'Code-graph provider fake-unavailable is unavailable: No graph index is available for the requested revision.',
        },
      ],
    });
  });

  it.each(['unavailable', 'provider-error'] as const)(
    'fails explicitly for %s when diff fallback has no production target',
    async (name) => {
      const project = await loadProject();
      const result = await analyzeScenario(
        name,
        project,
        changeFor({ includeProductionTarget: false }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.map((issue) => issue.code)).toContain(
          'no_changed_production_symbols',
        );
      }
    },
  );

  it('does not allow synthetic impact evidence to be relabeled as decision evidence', async () => {
    const project = await loadProject();
    const impact = requireImpact(
      await analyzeScenario('direct-impact', project, changeFor()),
    ).impact;

    expect(
      ChangeImpactSchema.safeParse({
        ...structuredClone(impact),
        evidence_use: 'decision',
      }).success,
    ).toBe(false);
  });

  it('canonicalizes provider ordering and prefers normalized change symbols', async () => {
    const project = await loadProject();
    const change = changeFor();
    const scenario = await loadScenario('indirect-impact');
    if (scenario.mode !== 'result') {
      throw new Error('Expected result scenario');
    }
    const reordered = structuredClone(scenario);
    reordered.impact.limitations.reverse();
    reordered.impact.indirect_impacts[0]?.relationships.reverse();
    const changedSymbol = change.changed_symbols[0];
    if (changedSymbol === undefined) {
      throw new Error('Expected a changed symbol');
    }
    reordered.impact.changed_symbols = [
      {
        ...changedSymbol,
        confidence: 0.1,
      },
    ];
    const base = requireImpact(
      await analyzeChangeImpact({
        id: 'IMPACT-CANONICAL',
        project,
        change,
        provider: new FakeCodeGraphProvider('fake-canonical', scenario),
      }),
    ).impact;
    const normalized = requireImpact(
      await analyzeChangeImpact({
        id: 'IMPACT-CANONICAL',
        project,
        change,
        provider: new FakeCodeGraphProvider('fake-canonical', reordered),
      }),
    ).impact;

    expect(normalized).toEqual(base);
    expect(normalized.changed_symbols[0]?.confidence).toBe(1);
  });
});

describe('deterministic assurance planning', () => {
  it.each([
    ['test', 'unit_tests'],
    ['generated', 'other'],
    ['unknown', 'other'],
  ] as const)(
    'keeps gate derivation total for a %s-only change',
    async (role, expectedGate) => {
      const project = await loadProject();
      const profile = assuranceProfileFor(project.id, 'low');
      const id = `CHANGE-${role.toUpperCase()}-ONLY`;
      const evidence = changeEvidenceFor(id);
      const change = ChangeContextSchema.parse({
        schema_version: 1,
        kind: 'change_context',
        id,
        project_ref: project.id,
        summary: `Change only a ${role}-role artifact.`,
        nature: 'behavior_preserving',
        concerns: ['internal_refactoring'],
        changed_files: [
          {
            path: `src/${role}/Artifact.java`,
            change_type: 'modified',
            role,
            evidence: [evidence],
          },
        ],
        changed_symbols: [
          {
            qualified_name: `example.${role}.Artifact`,
            kind: 'class',
            role,
            ...(role === 'test' ? { target: 'example.test.ArtifactTest' } : {}),
            confidence: 1,
            evidence: [evidence],
          },
        ],
        evidence: [evidence],
      });
      const result = deriveAssurancePlan({
        id: `PLAN-${role.toUpperCase()}-ONLY`,
        project,
        profile,
        change,
        impact: observedImpactFor(change, {
          directProductionSymbols: 0,
          flows: 0,
        }),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.required_gates.map((gate) => gate.type)).toEqual([
          expectedGate,
        ]);
      }
    },
  );

  it('selects a deterministic compilation gate for configuration-only build-tooling changes', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id, 'low');
    const evidence = changeEvidenceFor('CHANGE-BUILD-CONFIG');
    const change = ChangeContextSchema.parse({
      schema_version: 1,
      kind: 'change_context',
      id: 'CHANGE-BUILD-CONFIG',
      project_ref: project.id,
      summary: 'Update build configuration.',
      nature: 'behavior_preserving',
      concerns: ['build_tooling'],
      changed_files: [
        {
          path: 'pom.xml',
          change_type: 'modified',
          role: 'configuration',
          evidence: [evidence],
        },
      ],
      changed_symbols: [
        {
          qualified_name: 'build.maven.project',
          kind: 'file',
          role: 'configuration',
          file: 'pom.xml',
          confidence: 1,
          evidence: [evidence],
        },
      ],
      evidence: [evidence],
    });
    const result = deriveAssurancePlan({
      id: 'PLAN-BUILD-CONFIG',
      project,
      profile,
      change,
      impact: observedImpactFor(change, {
        directProductionSymbols: 0,
        flows: 0,
      }),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.plan.required_gates).toEqual([
        {
          id: 'GATE:CHANGE-BUILD-CONFIG:compilation',
          type: 'compilation',
          blocking: true,
          reason:
            'Changed build or configuration inputs must construct the project successfully.',
        },
      ]);
    }
  });

  it('derives stable gates, review policy, and trace from structured concerns', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id);
    const change = changeFor();
    const impact = observedImpactFor(change);
    const first = deriveAssurancePlan({
      id: 'PLAN-CANCELLATION',
      project,
      profile,
      change,
      impact,
    });
    const reorderedChange = changeFor({
      concerns: ['externally_observable_behavior', 'business_rule'],
    });
    const second = deriveAssurancePlan({
      id: 'PLAN-CANCELLATION',
      project,
      profile,
      change: reorderedChange,
      impact,
    });

    expect(first.success).toBe(true);
    expect(second).toEqual(first);
    if (first.success) {
      expect(first.plan.required_gates.map((gate) => gate.type)).toEqual([
        'compilation',
        'unit_tests',
        'acceptance_tests',
        'architecture_tests',
        'mutation_tests',
        'dependency_scan',
      ]);
      expect(first.plan.human_review.level).toBe(2);
      expect(first.plan.assurance_profile_ref).toBe(profile.id);
      expect(first.plan.human_review.targets).toContain(
        'Policy-selected concerns that always require human review.',
      );
      expect(first.plan.decision_trace?.map((item) => item.code)).toEqual([
        'RISK-V1',
        'GATES-V1',
        'REVIEW-V1',
      ]);
      expect(first.plan.derivation_evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'EV-PAYMENTS-ARCHITECTURE-DECISION',
          }),
        ]),
      );
      expect(
        first.plan.decision_trace?.find(
          (decision) => decision.code === 'REVIEW-V1',
        )?.evidence_refs,
      ).toContain('EV-PAYMENTS-ARCHITECTURE-DECISION');
    }
  });

  it.each([
    ['test_reliability', 'weak'],
    ['architecture_checks', 'partial'],
    ['mutation_baseline', 'stale'],
    ['impact_analysis', 'developing'],
    ['rollback', 'unsupported'],
  ] as const)(
    'does not grant Level 2 when readiness %s is %s',
    async (field, value) => {
      const project = await loadProject();
      const profile = assuranceProfileFor(project.id);
      const readiness = profile.readiness;
      if (readiness === undefined) {
        throw new Error('Expected readiness');
      }
      Object.assign(readiness, { [field]: value });
      const change = changeFor();
      const result = deriveAssurancePlan({
        id: `PLAN-READINESS-${field}`,
        project,
        profile,
        change,
        impact: observedImpactFor(change),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.human_review.level).toBe(1);
      }
    },
  );

  it('requires architecture enforcement, no active exceptions, and resolved project uncertainty for Level 2', async () => {
    const project = await loadProject();
    const change = changeFor();
    const cases = [
      (() => {
        const profile = assuranceProfileFor(project.id);
        profile.architecture_policy.checks_required = false;
        return { project, profile };
      })(),
      (() => {
        const profile = assuranceProfileFor(project.id);
        profile.exception_policy.active_exceptions = [
          {
            id: 'EXCEPTION-ACTIVE',
            reason: 'A temporary test exception.',
            owner: 'team',
            scope: 'one gate',
            expires_on: '2099-01-01',
            evidence: [readinessEvidence],
          },
        ];
        return { project, profile };
      })(),
      (() => {
        const uncertainProject = structuredClone(project);
        uncertainProject.uncertainties = [
          {
            id: 'UNCERTAINTY-IMPACT',
            statement: 'Runtime subscribers are not mapped.',
            impact: 'Impact analysis may omit a consumer.',
            resolution_required: true,
            evidence: [readinessEvidence],
          },
        ];
        const profile = assuranceProfileFor(uncertainProject.id);
        return { project: uncertainProject, profile };
      })(),
    ];

    cases.forEach(({ project: caseProject, profile }, index) => {
      const result = deriveAssurancePlan({
        id: `PLAN-PREREQUISITE-${index}`,
        project: caseProject,
        profile,
        change,
        impact: observedImpactFor(change),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.human_review.level).toBe(1);
      }
    });
  });

  it.each([
    ['missing', undefined],
    [
      'complete but not assurance-relevant',
      {
        status: 'complete_for_declared_scope',
        provider: {
          id: 'filesystem_repository_scanner',
          contract_version: '1',
        },
        capabilities: [
          {
            id: 'bounded_manifest_observation',
            status: 'supported',
          },
        ],
        inputs: [
          {
            path: 'pom.xml',
            kind: 'manifest',
            status: 'parsed',
            evidence: [
              {
                id: 'EV-BOUNDED-MANIFEST',
                type: 'build_configuration',
                description: 'A supported root manifest was parsed.',
                location: 'pom.xml',
                provider: 'filesystem',
              },
            ],
          },
        ],
        limitations: [],
      },
    ],
    [
      'self-declared assurance-relevant context without human-decision evidence',
      {
        status: 'complete_for_declared_scope',
        provider: {
          id: 'self_declared_project_profile',
          contract_version: '1',
        },
        capabilities: [
          {
            id: 'assurance_relevant_project_context',
            status: 'supported',
          },
        ],
        inputs: [
          {
            path: 'pom.xml',
            kind: 'manifest',
            status: 'parsed',
            evidence: [
              {
                id: 'EV-SELF-DECLARED-PROJECT-CONTEXT',
                type: 'build_configuration',
                description:
                  'A build file alone claims assurance-relevant project context.',
                location: 'pom.xml',
                provider: 'self_declared',
              },
            ],
          },
        ],
        limitations: [],
      },
    ],
    [
      'partial',
      {
        status: 'partial',
        provider: {
          id: 'filesystem_repository_scanner',
          contract_version: '1',
        },
        capabilities: [
          {
            id: 'declared_project_context',
            status: 'partial',
          },
        ],
        inputs: [],
        limitations: ['The repository observation was intentionally bounded.'],
      },
    ],
  ] satisfies readonly (readonly [
    string,
    ProjectProfile['observation_coverage'],
  ])[])(
    'does not grant Level 2 when project observation coverage is %s',
    async (_coverageCase, observationCoverage) => {
      const project = await loadProject();
      project.observation_coverage = observationCoverage;
      const profile = assuranceProfileFor(project.id);
      const change = changeFor();

      const result = deriveAssurancePlan({
        id: 'PLAN-OBSERVATION-COVERAGE',
        project,
        profile,
        change,
        impact: observedImpactFor(change),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.human_review.level).toBe(1);
        expect(result.plan.human_review.rationale).toContain(
          'Project observation coverage is missing, partial, unknown, not declared fit for assurance-relevant project context, or lacks human-decision input evidence, so it cannot support reduced review.',
        );
      }
    },
  );

  it('rejects conflicting project-coverage evidence in the assurance decision basis', async () => {
    const project = await loadProject();
    const coverageEvidence =
      project.observation_coverage?.inputs[0]?.evidence[0];
    expect(coverageEvidence).toBeDefined();
    if (coverageEvidence === undefined) {
      return;
    }
    coverageEvidence.id = readinessEvidence.id;
    const profile = assuranceProfileFor(project.id);
    const change = changeFor();

    const result = deriveAssurancePlan({
      id: 'PLAN-CONFLICTING-COVERAGE-EVIDENCE',
      project,
      profile,
      change,
      impact: observedImpactFor(change),
    });

    expect(result).toEqual({
      success: false,
      issues: [
        {
          code: 'conflicting_evidence',
          path: '$.derivation_evidence',
          message: `Evidence ${readinessEvidence.id} has conflicting definitions`,
        },
      ],
    });
  });

  it('forces Level 0 for low-confidence, degraded, or synthetic impact evidence', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id);
    const change = changeFor();
    const lowConfidence = deriveAssurancePlan({
      id: 'PLAN-LOW-CONFIDENCE',
      project,
      profile,
      change,
      impact: observedImpactFor(change, { confidence: 0.59 }),
    });
    const degraded = deriveAssurancePlan({
      id: 'PLAN-DEGRADED',
      project,
      profile,
      change,
      impact: observedImpactFor(change, { status: 'degraded' }),
    });
    const syntheticImpact = requireImpact(
      await analyzeScenario('direct-impact', project, change),
    ).impact;
    const synthetic = deriveAssurancePlan({
      id: 'PLAN-SYNTHETIC',
      project,
      profile,
      change,
      impact: syntheticImpact,
    });

    for (const result of [lowConfidence, degraded, synthetic]) {
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.plan.human_review.level).toBe(0);
      }
    }
  });

  it('raises risk for a wide impact radius without treating clusters as verdicts', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id, 'low');
    const change = changeFor({
      concerns: ['internal_refactoring'],
      nature: 'behavior_preserving',
    });
    const narrow = deriveAssurancePlan({
      id: 'PLAN-RADIUS',
      project,
      profile,
      change,
      impact: observedImpactFor(change, {
        directProductionSymbols: 1,
        indirectProductionSymbols: 0,
        flows: 1,
      }),
    });
    const wide = deriveAssurancePlan({
      id: 'PLAN-RADIUS',
      project,
      profile,
      change,
      impact: observedImpactFor(change, {
        directProductionSymbols: 2,
        indirectProductionSymbols: 2,
        flows: 2,
      }),
    });

    expect(narrow.success).toBe(true);
    expect(wide.success).toBe(true);
    if (narrow.success && wide.success) {
      expect(narrow.plan.risk.impact).toBe('medium');
      expect(wide.plan.risk.impact).toBe('high');
      expect(wide.plan.risk.factors).toContain(
        'Impact radius contains 2 direct production symbols, 2 indirect production symbols, and 2 affected flows; its verification-risk signal is high.',
      );
    }
  });

  it('does not classify behavior-changing documentation or rename work as low likelihood', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id, 'low');
    const preserving = changeFor({
      concerns: ['internal_rename'],
      nature: 'behavior_preserving',
    });
    const changing = changeFor({
      concerns: ['internal_rename'],
      nature: 'behavior_changing',
    });
    const preservingPlan = deriveAssurancePlan({
      id: 'PLAN-NATURE',
      project,
      profile,
      change: preserving,
      impact: observedImpactFor(preserving, {
        directProductionSymbols: 0,
        flows: 0,
      }),
    });
    const changingPlan = deriveAssurancePlan({
      id: 'PLAN-NATURE',
      project,
      profile,
      change: changing,
      impact: observedImpactFor(changing, {
        directProductionSymbols: 0,
        flows: 0,
      }),
    });

    expect(preservingPlan.success).toBe(true);
    expect(changingPlan.success).toBe(true);
    if (preservingPlan.success && changingPlan.success) {
      expect(preservingPlan.plan.risk.likelihood).toBe('low');
      expect(changingPlan.plan.risk.likelihood).toBe('medium');
    }
  });

  it('does not let functional-cluster or centrality signals change the plan', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id);
    const change = changeFor();
    const impact = observedImpactFor(change);
    const evidence = impact.evidence.find((item) => item.type === 'code_graph');
    if (evidence === undefined) {
      throw new Error('Expected code-graph evidence');
    }
    const withCluster = ChangeImpactSchema.parse({
      ...structuredClone(impact),
      functional_clusters: [
        {
          id: 'CLUSTER-CENTRAL',
          name: 'Central-looking cluster',
          symbol_refs: [impact.changed_symbols[0]?.qualified_name ?? change.id],
          signals: ['high_centrality', 'multiple_flow_membership'],
          evidence: [evidence],
        },
      ],
    });
    const without = deriveAssurancePlan({
      id: 'PLAN-CLUSTER',
      project,
      profile,
      change,
      impact,
    });
    const withSignal = deriveAssurancePlan({
      id: 'PLAN-CLUSTER',
      project,
      profile,
      change,
      impact: withCluster,
    });

    expect(withSignal).toEqual(without);
  });

  it('uses structured concern selectors and never matches policy prose', async () => {
    const project = await loadProject();
    const baseProfile = assuranceProfileFor(project.id, 'low');
    const profile = AssuranceProfileSchema.parse({
      ...structuredClone(baseProfile),
      testing_policy: {
        ...structuredClone(baseProfile.testing_policy),
        acceptance_concerns: ['business_rule'],
        integration_concerns: [],
        acceptance_tests_required_for: ['persistence security public API'],
        integration_tests_required_for: ['business rule'],
      },
    });
    const change = changeFor({
      concerns: ['persistence'],
      nature: 'behavior_changing',
    });
    const result = deriveAssurancePlan({
      id: 'PLAN-STRUCTURED-POLICY',
      project,
      profile,
      change,
      impact: observedImpactFor(change),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.plan.required_gates.map((gate) => gate.type)).not.toContain(
        'acceptance_tests',
      );
      expect(result.plan.required_gates.map((gate) => gate.type)).not.toContain(
        'integration_tests',
      );
    }
  });
});

describe('change artifacts and registry ownership', () => {
  it('validates change context and impact as first-class artifacts', () => {
    const change = changeFor();
    const impact = observedImpactFor(change);

    expect(validateArtifact(change)).toMatchObject({ success: true });
    expect(validateArtifact(impact)).toMatchObject({ success: true });
  });

  it('resolves a consistent project/change/impact/plan chain', async () => {
    const project = await loadProject();
    const profile = assuranceProfileFor(project.id);
    const change = changeFor();
    const impact = observedImpactFor(change);
    const planResult = deriveAssurancePlan({
      id: 'PLAN-REGISTRY',
      project,
      profile,
      change,
      impact,
    });
    if (!planResult.success) {
      throw new Error(
        planResult.issues.map((issue) => issue.message).join('; '),
      );
    }
    const entries: LocatedArtifact[] = [
      { origin: 'project.json', artifact: project },
      { origin: 'profile.json', artifact: profile },
      { origin: 'change.json', artifact: change },
      { origin: 'impact.json', artifact: impact },
      { origin: 'plan.json', artifact: planResult.plan },
    ];

    expect(createArtifactRegistry(entries).success).toBe(true);
  });

  it('rejects an impact whose project differs from its referenced change', async () => {
    const project = await loadProject();
    const otherProject = ProjectProfileSchema.parse({
      ...structuredClone(project),
      id: 'PROJECT-OTHER',
    });
    const change = changeFor();
    const mismatchedImpact = ChangeImpactSchema.parse({
      ...observedImpactFor(change),
      project_ref: otherProject.id,
    });
    const result = createArtifactRegistry([
      { origin: 'project.json', artifact: project },
      { origin: 'other-project.json', artifact: otherProject },
      { origin: 'change.json', artifact: change },
      { origin: 'impact.json', artifact: mismatchedImpact },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'artifact_scope_mismatch',
            origin: 'impact.json',
            path: '$.project_ref',
          }),
        ]),
      );
    }
  });

  it('rejects plan references outside its project and a mismatched impact/change pair', async () => {
    const project = await loadProject();
    const otherProject = ProjectProfileSchema.parse({
      ...structuredClone(project),
      id: 'PROJECT-OTHER',
    });
    const change = changeFor();
    const otherChange = changeFor({ id: 'CHANGE-OTHER' });
    const impact = observedImpactFor(change);
    const profile = assuranceProfileFor(project.id);
    const basePlanResult = deriveAssurancePlan({
      id: 'PLAN-REGISTRY-MISMATCH',
      project,
      profile,
      change,
      impact,
    });
    if (!basePlanResult.success) {
      throw new Error(
        basePlanResult.issues.map((issue) => issue.message).join('; '),
      );
    }
    const projectMismatchPlan = AssurancePlanSchema.parse({
      ...structuredClone(basePlanResult.plan),
      id: 'PLAN-PROJECT-MISMATCH',
      project_ref: otherProject.id,
    });
    const changeMismatchPlan = AssurancePlanSchema.parse({
      ...structuredClone(basePlanResult.plan),
      id: 'PLAN-CHANGE-MISMATCH',
      change_id: otherChange.id,
      change_context_ref: otherChange.id,
    });
    const result = createArtifactRegistry([
      { origin: 'project.json', artifact: project },
      { origin: 'other-project.json', artifact: otherProject },
      { origin: 'change.json', artifact: change },
      { origin: 'other-change.json', artifact: otherChange },
      { origin: 'impact.json', artifact: impact },
      { origin: 'profile.json', artifact: profile },
      { origin: 'project-mismatch-plan.json', artifact: projectMismatchPlan },
      { origin: 'change-mismatch-plan.json', artifact: changeMismatchPlan },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'artifact_scope_mismatch',
            origin: 'project-mismatch-plan.json',
            path: '$.assurance_profile_ref',
          }),
          expect.objectContaining({
            code: 'artifact_scope_mismatch',
            origin: 'project-mismatch-plan.json',
            path: '$.change_context_ref',
          }),
          expect.objectContaining({
            code: 'artifact_scope_mismatch',
            origin: 'project-mismatch-plan.json',
            path: '$.impact_ref',
          }),
          expect.objectContaining({
            code: 'artifact_scope_mismatch',
            origin: 'change-mismatch-plan.json',
            path: '$.impact_ref',
          }),
        ]),
      );
    }
  });
});
