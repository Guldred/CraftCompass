import {
  AssurancePlanSchema,
  type AssurancePlan,
  type AssuranceProfile,
  type ChangeConcern,
  type ChangeContext,
  type ChangeImpact,
  type EvidenceReference,
  type ProjectProfile,
  type QualityGateRequirement,
  type ReviewLevel,
} from '@craftcompass/domain';

import {
  deriveMutationScope,
  type MutationScopeDerivationResult,
} from './mutation-scope.js';

export type AssurancePlanningIssueCode =
  | 'change_reference_mismatch'
  | 'conflicting_evidence'
  | 'invalid_assurance_plan'
  | 'profile_reference_mismatch'
  | 'project_reference_mismatch';

export interface AssurancePlanningIssue {
  readonly code: AssurancePlanningIssueCode;
  readonly path: string;
  readonly message: string;
}

export type AssurancePlanningResult =
  | {
      readonly success: true;
      readonly plan: AssurancePlan;
    }
  | {
      readonly success: false;
      readonly issues: readonly AssurancePlanningIssue[];
    };

export interface DeriveAssurancePlanInput {
  readonly id: string;
  readonly project: ProjectProfile;
  readonly profile: AssuranceProfile;
  readonly change: ChangeContext;
  readonly impact: ChangeImpact;
}

type RiskBand = AssurancePlan['risk']['overall'];
type GateType = QualityGateRequirement['type'];

const RISK_ORDER: Readonly<Record<RiskBand, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const GATE_ORDER: readonly GateType[] = [
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
];

const CONCERN_RISK: Readonly<Record<ChangeConcern, RiskBand>> = {
  documentation: 'low',
  internal_rename: 'low',
  internal_refactoring: 'medium',
  business_rule: 'high',
  externally_observable_behavior: 'high',
  public_api: 'high',
  authorization: 'critical',
  sensitive_data: 'critical',
  data_migration: 'high',
  persistence: 'high',
  messaging: 'high',
  external_service: 'high',
  new_external_entry_point: 'high',
  dependency: 'medium',
  build_tooling: 'medium',
  security: 'critical',
  unknown: 'high',
};

const DEFAULT_ACCEPTANCE_CONCERNS: readonly ChangeConcern[] = [
  'business_rule',
  'externally_observable_behavior',
];

const DEFAULT_INTEGRATION_CONCERNS: readonly ChangeConcern[] = [
  'persistence',
  'messaging',
  'external_service',
  'new_external_entry_point',
];

const SECURITY_CONCERNS = new Set<ChangeConcern>([
  'authorization',
  'sensitive_data',
  'security',
  'new_external_entry_point',
]);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

const maximumRisk = (bands: readonly RiskBand[]): RiskBand =>
  bands.reduce<RiskBand>(
    (highest, band) =>
      RISK_ORDER[band] > RISK_ORDER[highest] ? band : highest,
    'low',
  );

interface ImpactRadius {
  readonly directProductionSymbols: number;
  readonly indirectProductionSymbols: number;
  readonly flows: number;
  readonly risk: RiskBand;
}

/**
 * Impact radius informs verification effort without becoming an architecture
 * verdict. Cluster and centrality signals are deliberately excluded.
 */
const deriveImpactRadius = (impact: ChangeImpact): ImpactRadius => {
  const directProductionSymbols = impact.direct_impacts.filter(
    (item) => item.symbol.role === 'production',
  ).length;
  const indirectProductionSymbols = impact.indirect_impacts.filter(
    (item) => item.symbol.role === 'production',
  ).length;
  const flows = impact.impacted_flows.length;
  const impactedProductionSymbols =
    directProductionSymbols + indirectProductionSymbols;
  const risk: RiskBand =
    impactedProductionSymbols >= 4 || flows >= 2
      ? 'high'
      : impactedProductionSymbols > 0 || flows > 0
        ? 'medium'
        : 'low';
  return {
    directProductionSymbols,
    indirectProductionSymbols,
    flows,
    risk,
  };
};

const stableSerialize = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const mergeEvidence = (
  groups: readonly (readonly EvidenceReference[])[],
):
  | { readonly success: true; readonly evidence: EvidenceReference[] }
  | { readonly success: false; readonly id: string } => {
  const byId = new Map<string, EvidenceReference>();
  for (const evidence of groups.flat()) {
    const existing = byId.get(evidence.id);
    if (
      existing !== undefined &&
      stableSerialize(existing) !== stableSerialize(evidence)
    ) {
      return { success: false, id: evidence.id };
    }
    byId.set(evidence.id, evidence);
  }
  return {
    success: true,
    evidence: [...byId.values()].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
};

const intersects = (
  concerns: ReadonlySet<ChangeConcern>,
  candidates: readonly ChangeConcern[],
): boolean => candidates.some((candidate) => concerns.has(candidate));

const selectedConcerns = (
  configured: readonly ChangeConcern[] | undefined,
  legacyConfiguration: readonly string[],
  defaults: readonly ChangeConcern[],
): readonly ChangeConcern[] =>
  configured ?? (legacyConfiguration.length > 0 ? defaults : []);

const gateTargets = (
  scope: MutationScopeDerivationResult,
  change: ChangeContext,
): string[] => {
  if (scope.success) {
    return uniqueSorted([
      ...scope.scope.primary_targets,
      ...scope.scope.supporting_targets,
    ]);
  }
  return uniqueSorted(
    change.changed_symbols.flatMap((symbol) =>
      symbol.role === 'production' && symbol.target !== undefined
        ? [symbol.target]
        : [],
    ),
  );
};

const deriveGates = (
  profile: AssuranceProfile,
  change: ChangeContext,
  scope: MutationScopeDerivationResult,
): QualityGateRequirement[] => {
  const concerns = new Set(change.concerns);
  const productionChanged =
    change.changed_files.some((file) => file.role === 'production') ||
    change.changed_symbols.some((symbol) => symbol.role === 'production');
  const configurationChanged =
    change.changed_files.some((file) => file.role === 'configuration') ||
    change.changed_symbols.some((symbol) => symbol.role === 'configuration');
  const testsChanged =
    change.changed_files.some((file) => file.role === 'test') ||
    change.changed_symbols.some((symbol) => symbol.role === 'test');
  const targets = gateTargets(scope, change);
  const byType = new Map<GateType, QualityGateRequirement>();
  const addGate = (type: GateType, reason: string): void => {
    byType.set(type, {
      id: `GATE:${change.id}:${type}`,
      type,
      blocking: true,
      reason,
      ...(targets.length === 0 ? {} : { targets }),
    });
  };

  if (productionChanged) {
    addGate('compilation', 'Changed production code must compile.');
  } else if (configurationChanged || concerns.has('build_tooling')) {
    addGate(
      'compilation',
      'Changed build or configuration inputs must construct the project successfully.',
    );
  } else if (concerns.has('documentation')) {
    addGate(
      'formatting',
      'Documentation-only changes require their configured deterministic formatting check.',
    );
  }
  if (
    (productionChanged || testsChanged) &&
    profile.testing_policy.unit_tests_required
  ) {
    addGate(
      'unit_tests',
      productionChanged
        ? 'Changed production behavior requires focused unit tests.'
        : 'Changed tests must pass their configured unit-test gate.',
    );
  }
  const acceptanceConcerns = selectedConcerns(
    profile.testing_policy.acceptance_concerns,
    profile.testing_policy.acceptance_tests_required_for,
    DEFAULT_ACCEPTANCE_CONCERNS,
  );
  if (intersects(concerns, acceptanceConcerns)) {
    addGate(
      'acceptance_tests',
      'The change affects behavior covered by the project acceptance-test policy.',
    );
  }
  const integrationConcerns = selectedConcerns(
    profile.testing_policy.integration_concerns,
    profile.testing_policy.integration_tests_required_for,
    DEFAULT_INTEGRATION_CONCERNS,
  );
  if (intersects(concerns, integrationConcerns)) {
    addGate(
      'integration_tests',
      'The change affects an integration concern selected by project policy.',
    );
  }
  if (productionChanged && profile.architecture_policy.checks_required) {
    addGate(
      'architecture_tests',
      'New architecture violations are checked independently from graph signals.',
    );
  }
  if (
    change.nature === 'behavior_changing' &&
    intersects(concerns, DEFAULT_ACCEPTANCE_CONCERNS)
  ) {
    addGate(
      'mutation_tests',
      'Changed business behavior must have no new unexplained surviving mutants.',
    );
  }
  if (
    profile.security_policy.dependency_scanning_required &&
    (productionChanged || concerns.has('dependency'))
  ) {
    addGate(
      'dependency_scan',
      'The project policy requires dependency scanning for production changes.',
    );
  }
  if ([...SECURITY_CONCERNS].some((concern) => concerns.has(concern))) {
    addGate(
      'security_tests',
      'Security-sensitive behavior requires independent security evidence.',
    );
  }
  if (concerns.has('public_api')) {
    addGate(
      'api_compatibility',
      'Public API changes require compatibility evidence.',
    );
  }
  if (concerns.has('data_migration')) {
    addGate(
      'migration_check',
      'Data migrations require forward and rollback verification.',
    );
  }
  if (byType.size === 0) {
    addGate(
      'other',
      'The change requires an explicit project-specific deterministic validation gate.',
    );
  }
  return GATE_ORDER.flatMap((type) => {
    const gate = byType.get(type);
    return gate === undefined ? [] : [gate];
  });
};

const concernReviewTargets = (
  concerns: ReadonlySet<ChangeConcern>,
  profile: AssuranceProfile,
): string[] => [
  ...(intersects(concerns, DEFAULT_ACCEPTANCE_CONCERNS)
    ? ['Business intent and acceptance criteria.']
    : []),
  ...(concerns.has('public_api') ? ['Public API contracts.'] : []),
  ...([...SECURITY_CONCERNS].some((concern) => concerns.has(concern))
    ? ['Authorization and security-sensitive behavior.']
    : []),
  ...(concerns.has('data_migration') ? ['Migration and rollback plan.'] : []),
  ...(intersects(concerns, profile.review_policy.always_review_concerns ?? [])
    ? ['Policy-selected concerns that always require human review.']
    : []),
  ...(intersects(
    concerns,
    profile.review_policy.selective_review_concerns ?? [],
  )
    ? ['Policy-selected concerns requiring focused human review.']
    : []),
  ...(intersects(concerns, profile.security_policy.human_review_concerns ?? [])
    ? ['Security concerns selected by the human-review policy.']
    : []),
];

const isLevelTwoReady = (
  input: DeriveAssurancePlanInput,
  overallRisk: RiskBand,
): boolean => {
  const readiness = input.profile.readiness;
  return (
    input.profile.review_policy.default_level === 2 &&
    overallRisk !== 'critical' &&
    input.impact.status === 'available' &&
    input.impact.confidence >= 0.8 &&
    input.impact.evidence_use === 'decision' &&
    readiness?.test_reliability === 'established' &&
    readiness.architecture_checks === 'established' &&
    readiness.mutation_baseline === 'available' &&
    readiness.impact_analysis === 'reliable' &&
    readiness.rollback === 'supported' &&
    input.profile.architecture_policy.checks_required &&
    input.profile.exception_policy.active_exceptions.length === 0 &&
    !input.project.uncertainties.some(
      (uncertainty) => uncertainty.resolution_required,
    )
  );
};

const deriveReviewLevel = (
  input: DeriveAssurancePlanInput,
  overallRisk: RiskBand,
  scope: MutationScopeDerivationResult,
  mutationRequired: boolean,
): ReviewLevel => {
  const maximumLevel = input.profile.review_policy.default_level;
  if (maximumLevel === 0) {
    return 0;
  }
  const conservativeReviewRequired =
    overallRisk === 'critical' ||
    input.impact.status === 'degraded' ||
    input.impact.confidence < 0.6 ||
    input.impact.evidence_use !== 'decision' ||
    input.change.nature === 'unknown' ||
    input.change.concerns.includes('unknown') ||
    (mutationRequired && !scope.success);
  if (conservativeReviewRequired) {
    return 0;
  }
  return isLevelTwoReady(input, overallRisk) ? 2 : 1;
};

/**
 * Deterministically derives risk, gates, mutation scope, and Review Level 0–2.
 * Functional-cluster and centrality signals are intentionally not risk inputs.
 */
export const deriveAssurancePlan = (
  input: DeriveAssurancePlanInput,
): AssurancePlanningResult => {
  const referenceIssues: AssurancePlanningIssue[] = [];
  if (input.profile.project_ref !== input.project.id) {
    referenceIssues.push({
      code: 'profile_reference_mismatch',
      path: '$.profile.project_ref',
      message: `Assurance profile references ${input.profile.project_ref}, not project ${input.project.id}`,
    });
  }
  if (
    input.change.project_ref !== input.project.id ||
    input.impact.project_ref !== input.project.id
  ) {
    referenceIssues.push({
      code: 'project_reference_mismatch',
      path: '$.project_ref',
      message:
        'Project, change context, and impact must share one project reference',
    });
  }
  if (input.impact.change_ref !== input.change.id) {
    referenceIssues.push({
      code: 'change_reference_mismatch',
      path: '$.impact.change_ref',
      message: `Impact references ${input.impact.change_ref}, not change ${input.change.id}`,
    });
  }
  if (referenceIssues.length > 0) {
    return { success: false, issues: referenceIssues };
  }

  const readinessEvidence = input.profile.readiness?.evidence ?? [];
  const derivationEvidence = mergeEvidence([
    input.impact.evidence,
    readinessEvidence,
  ]);
  if (!derivationEvidence.success) {
    return {
      success: false,
      issues: [
        {
          code: 'conflicting_evidence',
          path: '$.derivation_evidence',
          message: `Evidence ${derivationEvidence.id} has conflicting definitions`,
        },
      ],
    };
  }

  const concernBands = input.change.concerns.map(
    (concern) => CONCERN_RISK[concern],
  );
  const impactRadius = deriveImpactRadius(input.impact);
  const impactRisk = maximumRisk([
    input.profile.project_criticality,
    ...concernBands,
    impactRadius.risk,
  ]);
  const onlyLowLikelihoodConcerns = input.change.concerns.every(
    (concern) => concern === 'documentation' || concern === 'internal_rename',
  );
  const likelihoodRisk: RiskBand =
    input.change.nature === 'unknown' ||
    input.impact.status === 'degraded' ||
    input.impact.confidence < 0.6
      ? 'high'
      : input.change.nature === 'behavior_preserving' &&
          onlyLowLikelihoodConcerns
        ? 'low'
        : 'medium';
  const overallRisk = maximumRisk([impactRisk, likelihoodRisk]);
  const riskEvidence = input.impact.evidence;
  const riskFactors = uniqueSorted([
    `Project criticality is ${input.profile.project_criticality}.`,
    ...input.change.concerns.map(
      (concern) =>
        `Structured concern ${concern} has default impact ${CONCERN_RISK[concern]}.`,
    ),
    `Impact radius contains ${impactRadius.directProductionSymbols} direct production symbols, ${impactRadius.indirectProductionSymbols} indirect production symbols, and ${impactRadius.flows} affected flows; its verification-risk signal is ${impactRadius.risk}.`,
    ...(input.impact.status === 'degraded'
      ? ['Change-impact evidence is degraded.']
      : []),
    ...(input.impact.confidence < 0.6
      ? ['Change-impact confidence is below the reliable planning threshold.']
      : []),
    ...(input.impact.evidence_use === 'synthetic_test_only'
      ? ['Synthetic impact evidence is decision-ineligible.']
      : []),
  ]);

  const scope = deriveMutationScope(input.change, input.impact);
  const concerns = new Set(input.change.concerns);
  const mutationRequired =
    input.change.nature === 'behavior_changing' &&
    intersects(concerns, DEFAULT_ACCEPTANCE_CONCERNS);
  const gates = deriveGates(input.profile, input.change, scope);
  const reviewLevel = deriveReviewLevel(
    input,
    overallRisk,
    scope,
    mutationRequired,
  );
  const targets = uniqueSorted([
    ...input.profile.review_policy.always_review,
    ...concernReviewTargets(concerns, input.profile),
    ...(mutationRequired
      ? ['Mutation survivors and quality-gate exceptions.']
      : []),
    ...(reviewLevel < 2
      ? ['Complete relevant implementation diff.']
      : [
          ...input.change.changed_symbols,
          ...input.impact.direct_impacts.map((item) => item.symbol),
          ...input.impact.indirect_impacts.map((item) => item.symbol),
        ]
          .filter((symbol) => symbol.role === 'production')
          .map(
            (symbol) =>
              `Changed or impacted implementation: ${symbol.qualified_name}`,
          )),
  ]);
  const reviewRationale = uniqueSorted([
    ...(reviewLevel === 0
      ? [
          'Conventional review is required because risk, confidence, maturity, or evidence eligibility prevents reduced review.',
        ]
      : []),
    ...(reviewLevel === 1
      ? [
          'Automated gates run first, followed by complete relevant human review.',
        ]
      : []),
    ...(reviewLevel === 2
      ? [
          'Reduced implementation review is supported by explicit maturity, baseline, rollback, and reliable impact evidence.',
        ]
      : []),
  ]);
  const rationale = uniqueSorted([
    'Risk and verification requirements come from structured concerns and explicit evidence.',
    'Graph clusters and centrality remain non-authoritative signals.',
    ...(scope.success
      ? [
          'Mutation scope includes changed, direct, and indirect targets separately.',
        ]
      : [
          `Mutation scope was not derived: ${scope.issues
            .map((issue) => issue.message)
            .join('; ')}`,
        ]),
    ...(input.impact.limitations.length > 0
      ? [
          'Impact limitations remain visible in the mutation scope and review decision.',
        ]
      : []),
  ]);
  const evidenceIds = derivationEvidence.evidence.map(
    (evidence) => evidence.id,
  );
  const parsed = AssurancePlanSchema.safeParse({
    schema_version: 1,
    kind: 'assurance_plan',
    id: input.id,
    change_id: input.change.id,
    project_ref: input.project.id,
    assurance_profile_ref: input.profile.id,
    change_context_ref: input.change.id,
    impact_ref: input.impact.id,
    risk: {
      overall: overallRisk,
      likelihood: likelihoodRisk,
      impact: impactRisk,
      confidence:
        input.impact.evidence_use === 'synthetic_test_only'
          ? Math.min(0.5, input.impact.confidence)
          : input.impact.confidence,
      factors: riskFactors,
      evidence: riskEvidence,
    },
    impacted_flows: uniqueSorted(
      input.impact.impacted_flows.map((flow) => flow.name),
    ),
    required_gates: gates,
    ...(scope.success ? { mutation_scope: scope.scope } : {}),
    human_review: {
      level: reviewLevel,
      targets,
      rationale: reviewRationale,
    },
    rationale,
    derivation_evidence: derivationEvidence.evidence,
    decision_trace: [
      {
        code: 'RISK-V1',
        summary: `Overall risk is ${overallRisk} from structured concerns, project criticality, and impact radius.`,
        evidence_refs: riskEvidence.map((evidence) => evidence.id),
      },
      {
        code: 'GATES-V1',
        summary: `${gates.length} deterministic gate requirements were selected.`,
        evidence_refs: riskEvidence.map((evidence) => evidence.id),
      },
      {
        code: 'REVIEW-V1',
        summary: `Review Level ${reviewLevel} was selected conservatively.`,
        evidence_refs: evidenceIds,
      },
    ],
  });
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid_assurance_plan',
        path:
          issue.path.length === 0
            ? '$'
            : `$.${issue.path.map(String).join('.')}`,
        message: issue.message,
      })),
    };
  }
  return { success: true, plan: parsed.data };
};
