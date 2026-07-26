import type { EvidenceReference } from './common.js';
import type { CraftsmanshipPrinciple } from './knowledge.js';
import type {
  ProjectModule,
  ProjectObservation,
  ProjectProfile,
} from './project.js';
import {
  ProjectRuleSchema,
  type ProjectRule,
  type RuleLevel,
} from './rules.js';

/** The single principle supported by this deliberately narrow first recipe. */
export const DEPENDENCY_DIRECTION_PRINCIPLE_ID =
  'ARCH-DEPENDENCY-DIRECTION-001' as const;

/** Explainable branch selected by the deterministic dependency recipe. */
export type DependencyDirectionScenario =
  | 'intentionally_simple_tool'
  | 'legacy_monolith'
  | 'new_business_service'
  | 'requires_decision';

/** One construction failure that prevented a trustworthy candidate rule. */
export interface DependencyDirectionDerivationIssue {
  readonly code:
    | 'conflicting_evidence'
    | 'invalid_context_reference'
    | 'invalid_derived_rule'
    | 'superseded_principle'
    | 'unsupported_principle';
  readonly path: string;
  readonly message: string;
}

/** Input to the first deterministic, provider-independent rule recipe. */
export interface DependencyDirectionDerivationRequest {
  readonly principle: CraftsmanshipPrinciple;
  readonly project: ProjectProfile;
}

/** Result includes the selected branch so callers can explain the adaptation. */
export type DependencyDirectionDerivationResult =
  | {
      readonly success: true;
      readonly scenario: DependencyDirectionScenario;
      readonly rule: ProjectRule;
    }
  | {
      readonly success: false;
      readonly issues: readonly DependencyDirectionDerivationIssue[];
    };

interface ScenarioConfiguration {
  readonly title: string;
  readonly level: RuleLevel;
  readonly statement: string;
  readonly risk: string;
  readonly existingViolations: ProjectRule['scope']['existing_violations'];
  readonly enforcement: ProjectRule['enforcement'];
  readonly migration?: ProjectRule['migration'];
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const evidenceSignature = (evidence: EvidenceReference): string =>
  JSON.stringify({
    id: evidence.id,
    type: evidence.type,
    description: evidence.description,
    location: evidence.location,
    captured_at: evidence.captured_at ?? null,
    provider: evidence.provider ?? null,
    source_ref: evidence.source_ref ?? null,
  });

const formatPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (rendered, segment) =>
      typeof segment === 'number'
        ? `${rendered}[${segment}]`
        : `${rendered}.${String(segment)}`,
    '$',
  );

const selectScenario = (
  principle: CraftsmanshipPrinciple,
  project: ProjectProfile,
): DependencyDirectionScenario => {
  const context = project.adaptation_context;
  if (principle.lifecycle === 'contested' || context === undefined) {
    return 'requires_decision';
  }
  if (
    context.architecture_scale === 'simple_application' &&
    context.business_criticality === 'low' &&
    context.architecture_intent === 'explicit'
  ) {
    return 'intentionally_simple_tool';
  }
  if (context.delivery_stage === 'legacy') {
    return 'legacy_monolith';
  }
  if (
    context.delivery_stage === 'greenfield' &&
    (context.architecture_scale === 'modular_system' ||
      context.architecture_scale === 'distributed_system') &&
    (context.business_criticality === 'high' ||
      context.business_criticality === 'critical') &&
    context.architecture_intent === 'explicit'
  ) {
    return 'new_business_service';
  }
  return 'requires_decision';
};

const scenarioConfiguration = (
  scenario: DependencyDirectionScenario,
): ScenarioConfiguration => {
  switch (scenario) {
    case 'new_business_service':
      return {
        title: 'Keep business policy independent from technical details',
        level: 'mandatory',
        statement:
          'New and modified business-policy code must not depend directly on delivery, persistence, or framework details.',
        risk: 'Technical details can spread into business policy and make independent change, testing, and replacement harder.',
        existingViolations: 'forbidden',
        enforcement: [
          {
            mechanism: 'deterministic_check',
            blocking: false,
            description:
              'Prepare a dependency-direction check for activation after the candidate rule is accepted.',
            configuration: {
              boundary: 'business-policy-to-technical-detail',
            },
          },
        ],
        migration: {
          approach: 'immediate',
          rationale:
            'A greenfield, business-critical system can establish the boundary before dependency debt accumulates.',
          steps: [
            'Confirm the business-policy and technical-detail source roots.',
            'Activate the deterministic boundary check after human acceptance.',
          ],
        },
      };
    case 'legacy_monolith':
      return {
        title: 'Introduce no new technical dependencies into business policy',
        level: 'mandatory',
        statement:
          'New and modified business-policy code must not introduce additional dependencies on delivery, persistence, or framework details.',
        risk: 'New dependency violations would increase existing architecture debt and make incremental migration less achievable.',
        existingViolations: 'baseline',
        enforcement: [
          {
            mechanism: 'deterministic_check',
            blocking: false,
            description:
              'Prepare a ratcheting dependency check that distinguishes existing debt from new violations.',
            configuration: {
              boundary: 'business-policy-to-technical-detail',
              existing_debt: 'baseline',
            },
          },
        ],
        migration: {
          approach: 'baseline_and_ratcheting',
          rationale:
            'Existing violations remain visible while new and modified code is held to the intended direction.',
          steps: [
            'Record the existing dependency violations as a reviewed baseline.',
            'Reject no violations until the candidate rule is explicitly activated.',
            'After activation, prevent new violations in new and modified code.',
          ],
        },
      };
    case 'intentionally_simple_tool':
      return {
        title:
          'Add dependency boundaries only when change pressure justifies them',
        level: 'contextual',
        statement:
          'Keep the simple application direct unless independent business behavior or expected integration variation provides a concrete reason for an additional boundary.',
        risk: 'Applying a layered dependency structure without a current reason could add mapping and indirection without reducing meaningful change risk.',
        existingViolations: 'allowed',
        enforcement: [
          {
            mechanism: 'human_review',
            blocking: false,
            description:
              'Reconsider dependency boundaries when business behavior or integration variation creates a distinct reason to change.',
          },
        ],
      };
    case 'requires_decision':
      return {
        title:
          'Decide whether a dependency-direction boundary is proportionate',
        level: 'requires_decision',
        statement:
          'A project decision is required before dependency-direction guidance can become an enforceable project rule.',
        risk: 'Enforcing a boundary without sufficiently explicit project context could either preserve harmful coupling or introduce unjustified complexity.',
        existingViolations: 'allowed',
        enforcement: [
          {
            mechanism: 'human_review',
            blocking: false,
            description:
              'Clarify project intent, criticality, scale, and migration posture before activating enforcement.',
          },
        ],
      };
  }
};

const selectBasisObservations = (
  project: ProjectProfile,
  additionalReferences: readonly string[] = [],
):
  | {
      readonly success: true;
      readonly observations: readonly ProjectObservation[];
    }
  | {
      readonly success: false;
      readonly issues: readonly DependencyDirectionDerivationIssue[];
    } => {
  const observationsById = new Map(
    project.observations.map((observation) => [observation.id, observation]),
  );
  const references = [
    ...new Set([
      ...(project.adaptation_context?.observation_refs ??
        project.observations.map((observation) => observation.id)),
      ...additionalReferences,
    ]),
  ].sort(compareText);
  const issues: DependencyDirectionDerivationIssue[] = [];
  const observations = references.flatMap((reference, index) => {
    const observation = observationsById.get(reference);
    if (observation === undefined) {
      issues.push({
        code: 'invalid_context_reference',
        path: `$.adaptation_context.observation_refs[${index}]`,
        message: `Adaptation-context observation ${reference} does not resolve in project ${project.id}`,
      });
      return [];
    }
    return [observation];
  });
  if (issues.length > 0) {
    return {
      success: false,
      issues,
    };
  }
  return {
    success: true,
    observations: [...observations].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
};

interface EvidenceBasisItem {
  readonly path: string;
  readonly evidence: readonly EvidenceReference[];
}

const collectEvidence = (
  basisItems: readonly EvidenceBasisItem[],
):
  | {
      readonly success: true;
      readonly evidence: readonly EvidenceReference[];
    }
  | {
      readonly success: false;
      readonly issues: readonly DependencyDirectionDerivationIssue[];
    } => {
  const evidenceById = new Map<string, EvidenceReference>();
  const signaturesById = new Map<string, string>();
  const reportedConflictVariants = new Set<string>();
  const issues: DependencyDirectionDerivationIssue[] = [];
  basisItems.forEach((basisItem) => {
    basisItem.evidence.forEach((evidence) => {
      const signature = evidenceSignature(evidence);
      const existingSignature = signaturesById.get(evidence.id);
      if (existingSignature !== undefined && existingSignature !== signature) {
        const conflictVariant = `${evidence.id}\u0000${signature}`;
        if (reportedConflictVariants.has(conflictVariant)) {
          return;
        }
        reportedConflictVariants.add(conflictVariant);
        issues.push({
          code: 'conflicting_evidence',
          path: basisItem.path,
          message: `Evidence ${evidence.id} has conflicting definitions in the derivation basis`,
        });
      } else if (existingSignature === undefined) {
        signaturesById.set(evidence.id, signature);
        evidenceById.set(evidence.id, evidence);
      }
    });
  });
  if (issues.length > 0) {
    return {
      success: false,
      issues: issues.sort(
        (left, right) =>
          compareText(left.path, right.path) ||
          compareText(left.message, right.message),
      ),
    };
  }
  return {
    success: true,
    evidence: [...evidenceById.values()].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
};

const selectScopeModules = (
  project: ProjectProfile,
  scenario: DependencyDirectionScenario,
): ProjectModule[] =>
  project.modules
    .filter((module) => {
      const role = module.architecture_role;
      switch (scenario) {
        case 'new_business_service':
          return (
            module.status === 'confirmed' &&
            role?.status === 'confirmed' &&
            role.value === 'business_policy'
          );
        case 'legacy_monolith':
          return (
            module.status === 'confirmed' &&
            role?.status === 'confirmed' &&
            (role.value === 'business_policy' || role.value === 'mixed')
          );
        case 'intentionally_simple_tool':
          return module.status === 'confirmed';
        case 'requires_decision':
          return true;
      }
    })
    .sort((left, right) => compareText(left.name, right.name));

const scopeIncludes = (relevantModules: readonly ProjectModule[]): string[] => {
  const includes = relevantModules.map((module) => {
    const normalized = module.path.replace(/\/+$/, '');
    return normalized === '' || normalized === '.'
      ? '**/*'
      : `${normalized}/**`;
  });
  return [...new Set(includes)].sort(compareText).length > 0
    ? [...new Set(includes)].sort(compareText)
    : ['**/*'];
};

/**
 * Derives one candidate dependency-direction rule from explicit project
 * context. It never activates or makes a candidate enforcement blocking.
 */
export const deriveDependencyDirectionRule = (
  request: DependencyDirectionDerivationRequest,
): DependencyDirectionDerivationResult => {
  if (request.principle.id !== DEPENDENCY_DIRECTION_PRINCIPLE_ID) {
    return {
      success: false,
      issues: [
        {
          code: 'unsupported_principle',
          path: '$.principle.id',
          message: `Dependency-direction derivation supports only ${DEPENDENCY_DIRECTION_PRINCIPLE_ID}`,
        },
      ],
    };
  }
  if (request.principle.lifecycle === 'superseded') {
    return {
      success: false,
      issues: [
        {
          code: 'superseded_principle',
          path: '$.principle.lifecycle',
          message: `Superseded principle ${request.principle.id} cannot produce a candidate rule`,
        },
      ],
    };
  }

  const selectedScenario = selectScenario(request.principle, request.project);
  const initiallySelectedModules = selectScopeModules(
    request.project,
    selectedScenario,
  );
  const scenario =
    selectedScenario === 'requires_decision' ||
    initiallySelectedModules.length > 0
      ? selectedScenario
      : 'requires_decision';
  const selectedModules =
    scenario === selectedScenario
      ? initiallySelectedModules
      : selectScopeModules(request.project, scenario);
  const moduleObservationRefs = selectedModules.flatMap(
    (module) => module.architecture_role?.observation_refs ?? [],
  );
  const basis = selectBasisObservations(request.project, moduleObservationRefs);
  if (!basis.success) {
    return basis;
  }
  const evidenceResult = collectEvidence([
    ...basis.observations.map((observation) => ({
      path: `$.observations.${observation.id}.evidence`,
      evidence: observation.evidence,
    })),
    ...selectedModules.map((module) => ({
      path: `$.modules.${module.name}.evidence`,
      evidence: [
        ...module.evidence,
        ...(module.architecture_role?.evidence ?? []),
      ],
    })),
  ]);
  if (!evidenceResult.success) {
    return evidenceResult;
  }

  const configuration = scenarioConfiguration(scenario);
  const observationConfidence = Math.min(
    ...basis.observations.map((observation) => observation.confidence),
  );
  const contextConfidence =
    request.project.adaptation_context?.confidence ?? 0.5;
  const roleConfidences = selectedModules.flatMap((module) =>
    module.architecture_role === undefined
      ? []
      : [module.architecture_role.confidence],
  );
  const confidence = Math.min(
    observationConfidence,
    contextConfidence,
    ...roleConfidences,
  );
  const candidate = {
    schema_version: 1,
    kind: 'project_rule',
    id: `RULE:${request.project.id}:${request.principle.id}:DEPENDENCY-DIRECTION:V1`,
    project_ref: request.project.id,
    title: configuration.title,
    status: 'candidate',
    level: configuration.level,
    statement: configuration.statement,
    principle_refs: [request.principle.id],
    observation_refs: basis.observations.map((observation) => observation.id),
    module_refs: selectedModules.map((module) => module.name),
    evidence: evidenceResult.evidence,
    risk: configuration.risk,
    confidence,
    scope: {
      change_types: ['new_code', 'modified_code'],
      include: scopeIncludes(selectedModules),
      exclude: [],
      existing_violations: configuration.existingViolations,
    },
    enforcement: configuration.enforcement,
    ...(configuration.migration === undefined
      ? {}
      : { migration: configuration.migration }),
    exceptions: {
      allowed: true,
      reason_required: true,
      owner_required: true,
      expiration_required: true,
      active_exceptions: [],
    },
  } as const;
  const parsed = ProjectRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid_derived_rule',
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }
  return {
    success: true,
    scenario,
    rule: parsed.data,
  };
};
