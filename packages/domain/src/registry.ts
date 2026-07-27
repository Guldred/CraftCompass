import type { ArtifactKind, CraftArtifact } from './artifact.js';
import type { EvidenceReference, SourceReference } from './common.js';
import type { ProjectProfile } from './project.js';

/** A validated artifact paired with a provider-neutral origin label. */
export interface LocatedArtifact {
  readonly origin: string;
  readonly artifact: CraftArtifact;
}

/** Stable cross-artifact validation codes suitable for CLI and API consumers. */
export type RegistryIssueCode =
  | 'ambiguous_artifact_reference'
  | 'ambiguous_source_reference'
  | 'artifact_content_mismatch'
  | 'artifact_scope_mismatch'
  | 'conflicting_evidence_reference'
  | 'conflicting_source_reference'
  | 'duplicate_artifact_id'
  | 'evidence_mismatch'
  | 'missing_artifact_reference'
  | 'missing_exception_reference'
  | 'mutation_exception_scope_mismatch'
  | 'missing_module_reference'
  | 'missing_observation_reference'
  | 'missing_rule_evidence'
  | 'missing_source_reference'
  | 'wrong_artifact_kind';

/** One deterministic registry or reference-resolution problem. */
export interface RegistryIssue {
  readonly code: RegistryIssueCode;
  readonly origin: string;
  readonly path: string;
  readonly message: string;
}

/** Immutable-by-contract collection of uniquely identified artifacts. */
export interface ArtifactRegistry {
  readonly entries: readonly LocatedArtifact[];
}

/** Result of building and validating an artifact registry. */
export type ArtifactRegistryResult =
  | {
      readonly success: true;
      readonly registry: ArtifactRegistry;
    }
  | {
      readonly success: false;
      readonly issues: readonly RegistryIssue[];
    };

interface EvidenceOccurrence {
  readonly origin: string;
  readonly path: string;
  readonly scope: string;
  readonly reference: EvidenceReference;
}

interface SourceOccurrence {
  readonly origin: string;
  readonly path: string;
  readonly reference: SourceReference;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareLocatedArtifacts = (
  left: LocatedArtifact,
  right: LocatedArtifact,
): number =>
  compareText(left.origin, right.origin) ||
  compareText(left.artifact.id, right.artifact.id) ||
  compareText(left.artifact.kind, right.artifact.kind);

const compareIssues = (left: RegistryIssue, right: RegistryIssue): number =>
  compareText(left.origin, right.origin) ||
  compareText(left.path, right.path) ||
  compareText(left.code, right.code) ||
  compareText(left.message, right.message);

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
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value);
};

const referencesEqual = (left: unknown, right: unknown): boolean =>
  stableSerialize(left) === stableSerialize(right);

const collectSources = (entry: LocatedArtifact): SourceOccurrence[] => {
  const { artifact, origin } = entry;
  if (
    artifact.kind !== 'craftsmanship_principle' &&
    artifact.kind !== 'practice_statement'
  ) {
    return [];
  }
  return artifact.source_references.map((reference, index) => ({
    origin,
    path: `$.source_references[${index}]`,
    reference,
  }));
};

const evidenceOccurrences = (
  origin: string,
  scope: string,
  basePath: string,
  references: readonly EvidenceReference[],
): EvidenceOccurrence[] =>
  references.map((reference, index) => ({
    origin,
    path: `${basePath}[${index}]`,
    scope,
    reference,
  }));

const collectEvidence = (entry: LocatedArtifact): EvidenceOccurrence[] => {
  const { artifact, origin } = entry;
  const scope =
    artifact.kind === 'project_profile'
      ? `project:${artifact.id}`
      : artifact.kind === 'project_rule' ||
          artifact.kind === 'assurance_profile' ||
          artifact.kind === 'assurance_plan' ||
          artifact.kind === 'change_context' ||
          artifact.kind === 'change_impact' ||
          artifact.kind === 'mutation_report' ||
          artifact.kind === 'mutation_baseline'
        ? `project:${artifact.project_ref}`
        : `artifact:${artifact.id}`;
  switch (artifact.kind) {
    case 'craftsmanship_principle':
    case 'practice_statement':
      return [];
    case 'project_profile':
      return [
        ...artifact.technologies.flatMap((technology, technologyIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.technologies[${technologyIndex}].evidence`,
            technology.evidence,
          ),
        ),
        ...artifact.modules.flatMap((module, moduleIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.modules[${moduleIndex}].evidence`,
            module.evidence,
          ),
        ),
        ...artifact.modules.flatMap((module, moduleIndex) =>
          module.architecture_role === undefined
            ? []
            : evidenceOccurrences(
                origin,
                scope,
                `$.modules[${moduleIndex}].architecture_role.evidence`,
                module.architecture_role.evidence,
              ),
        ),
        ...(artifact.observation_coverage?.inputs.flatMap((input, inputIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.observation_coverage.inputs[${inputIndex}].evidence`,
            input.evidence,
          ),
        ) ?? []),
        ...artifact.observations.flatMap((observation, observationIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.observations[${observationIndex}].evidence`,
            observation.evidence,
          ),
        ),
        ...artifact.constraints.flatMap((constraint, constraintIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.constraints[${constraintIndex}].evidence`,
            constraint.evidence,
          ),
        ),
        ...artifact.uncertainties.flatMap((uncertainty, uncertaintyIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.uncertainties[${uncertaintyIndex}].evidence`,
            uncertainty.evidence,
          ),
        ),
        ...(artifact.adaptation_context === undefined
          ? []
          : evidenceOccurrences(
              origin,
              scope,
              '$.adaptation_context.evidence',
              artifact.adaptation_context.evidence,
            )),
      ];
    case 'change_context':
      return [
        ...evidenceOccurrences(origin, scope, '$.evidence', artifact.evidence),
        ...artifact.changed_files.flatMap((file, fileIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.changed_files[${fileIndex}].evidence`,
            file.evidence,
          ),
        ),
        ...artifact.changed_symbols.flatMap((symbol, symbolIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.changed_symbols[${symbolIndex}].evidence`,
            symbol.evidence,
          ),
        ),
      ];
    case 'change_impact':
      return [
        ...evidenceOccurrences(origin, scope, '$.evidence', artifact.evidence),
        ...artifact.changed_symbols.flatMap((symbol, symbolIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.changed_symbols[${symbolIndex}].evidence`,
            symbol.evidence,
          ),
        ),
        ...artifact.direct_impacts.flatMap((impact, impactIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.direct_impacts[${impactIndex}].symbol.evidence`,
            impact.symbol.evidence,
          ),
        ),
        ...artifact.indirect_impacts.flatMap((impact, impactIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.indirect_impacts[${impactIndex}].symbol.evidence`,
            impact.symbol.evidence,
          ),
        ),
        ...artifact.impacted_flows.flatMap((flow, flowIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.impacted_flows[${flowIndex}].evidence`,
            flow.evidence,
          ),
        ),
        ...artifact.functional_clusters.flatMap((cluster, clusterIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.functional_clusters[${clusterIndex}].evidence`,
            cluster.evidence,
          ),
        ),
        ...artifact.candidate_tests.flatMap((test, testIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.candidate_tests[${testIndex}].evidence`,
            test.evidence,
          ),
        ),
      ];
    case 'project_rule':
      return [
        ...evidenceOccurrences(origin, scope, '$.evidence', artifact.evidence),
        ...artifact.exceptions.active_exceptions.flatMap(
          (exception, exceptionIndex) =>
            evidenceOccurrences(
              origin,
              scope,
              `$.exceptions.active_exceptions[${exceptionIndex}].evidence`,
              exception.evidence,
            ),
        ),
      ];
    case 'assurance_profile':
      return [
        ...(artifact.readiness === undefined
          ? []
          : evidenceOccurrences(
              origin,
              scope,
              '$.readiness.evidence',
              artifact.readiness.evidence,
            )),
        ...artifact.exception_policy.active_exceptions.flatMap(
          (exception, exceptionIndex) =>
            evidenceOccurrences(
              origin,
              scope,
              `$.exception_policy.active_exceptions[${exceptionIndex}].evidence`,
              exception.evidence,
            ),
        ),
      ];
    case 'assurance_plan':
      return [
        ...evidenceOccurrences(
          origin,
          scope,
          '$.risk.evidence',
          artifact.risk.evidence,
        ),
        ...(artifact.derivation_evidence === undefined
          ? []
          : evidenceOccurrences(
              origin,
              scope,
              '$.derivation_evidence',
              artifact.derivation_evidence,
            )),
      ];
    case 'mutation_report':
      return [
        ...artifact.mutations.flatMap((mutation, mutationIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.mutations[${mutationIndex}].evidence`,
            mutation.evidence,
          ),
        ),
        ...artifact.evidence.flatMap((evidence, evidenceIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.evidence[${evidenceIndex}].references`,
            evidence.references,
          ),
        ),
      ];
    case 'mutation_baseline':
      return [
        ...artifact.entries.flatMap((mutation, mutationIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.entries[${mutationIndex}].evidence`,
            mutation.evidence,
          ),
        ),
        ...(artifact.activation === undefined
          ? []
          : evidenceOccurrences(
              origin,
              scope,
              '$.activation.evidence',
              artifact.activation.evidence,
            )),
      ];
  }
};

const groupByKey = <Occurrence>(
  occurrences: readonly Occurrence[],
  keyFor: (occurrence: Occurrence) => string,
): Map<string, Occurrence[]> => {
  const groups = new Map<string, Occurrence[]>();
  occurrences.forEach((occurrence) => {
    const key = keyFor(occurrence);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [occurrence]);
    } else {
      group.push(occurrence);
    }
  });
  return groups;
};

const groupById = <
  Occurrence extends { readonly reference: { readonly id: string } },
>(
  occurrences: readonly Occurrence[],
): Map<string, Occurrence[]> =>
  groupByKey(occurrences, (occurrence) => occurrence.reference.id);

const findConflictingReferenceIds = <
  Occurrence extends {
    readonly origin: string;
    readonly path: string;
    readonly reference: { readonly id: string };
  },
>(
  groups: ReadonlyMap<string, readonly Occurrence[]>,
  code: 'conflicting_evidence_reference' | 'conflicting_source_reference',
  label: string,
  issues: RegistryIssue[],
): Set<string> => {
  const conflictingIds = new Set<string>();
  [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .forEach(([groupKey, occurrences]) => {
      const ordered = [...occurrences].sort(
        (left, right) =>
          compareText(left.origin, right.origin) ||
          compareText(left.path, right.path),
      );
      const canonical = ordered[0];
      if (canonical === undefined) {
        return;
      }
      ordered.slice(1).forEach((occurrence) => {
        if (!referencesEqual(canonical.reference, occurrence.reference)) {
          conflictingIds.add(groupKey);
          issues.push({
            code,
            origin: occurrence.origin,
            path: occurrence.path,
            message: `${label} ${occurrence.reference.id} conflicts with its definition at ${canonical.origin}${canonical.path}`,
          });
        }
      });
    });
  return conflictingIds;
};

const validateArtifactReference = (
  owner: LocatedArtifact,
  path: string,
  reference: string,
  expectedKind: ArtifactKind,
  artifactsById: ReadonlyMap<string, LocatedArtifact>,
  duplicateIds: ReadonlySet<string>,
  issues: RegistryIssue[],
): LocatedArtifact | undefined => {
  if (duplicateIds.has(reference)) {
    issues.push({
      code: 'ambiguous_artifact_reference',
      origin: owner.origin,
      path,
      message: `Artifact reference ${reference} is ambiguous because its ID is duplicated`,
    });
    return undefined;
  }
  const target = artifactsById.get(reference);
  if (target === undefined) {
    issues.push({
      code: 'missing_artifact_reference',
      origin: owner.origin,
      path,
      message: `Artifact reference ${reference} does not resolve`,
    });
    return undefined;
  }
  if (target.artifact.kind !== expectedKind) {
    issues.push({
      code: 'wrong_artifact_kind',
      origin: owner.origin,
      path,
      message: `Artifact reference ${reference} resolves to ${target.artifact.kind}; expected ${expectedKind}`,
    });
    return undefined;
  }
  return target;
};

const validateExceptionArtifactReferences = (
  owner: LocatedArtifact,
  exceptions: readonly {
    readonly applies_to?:
      | {
          readonly artifact_refs: readonly string[];
        }
      | undefined;
  }[],
  basePath: string,
  artifactsById: ReadonlyMap<string, LocatedArtifact>,
  duplicateIds: ReadonlySet<string>,
  issues: RegistryIssue[],
): void => {
  exceptions.forEach((exception, exceptionIndex) => {
    exception.applies_to?.artifact_refs.forEach((reference, referenceIndex) => {
      const path = `${basePath}[${exceptionIndex}].applies_to.artifact_refs[${referenceIndex}]`;
      if (duplicateIds.has(reference)) {
        issues.push({
          code: 'ambiguous_artifact_reference',
          origin: owner.origin,
          path,
          message: `Artifact reference ${reference} is ambiguous because its ID is duplicated`,
        });
      } else if (!artifactsById.has(reference)) {
        issues.push({
          code: 'missing_artifact_reference',
          origin: owner.origin,
          path,
          message: `Artifact reference ${reference} does not resolve`,
        });
      }
    });
  });
};

const validateRuleEvidence = (
  owner: LocatedArtifact & {
    readonly artifact: Extract<
      CraftArtifact,
      { readonly kind: 'project_rule' }
    >;
  },
  project: ProjectProfile,
  issues: RegistryIssue[],
): void => {
  const observations = new Map(
    project.observations.map((observation) => [observation.id, observation]),
  );
  const resolvedObservations = owner.artifact.observation_refs.flatMap(
    (reference, index) => {
      const observation = observations.get(reference);
      if (observation === undefined) {
        issues.push({
          code: 'missing_observation_reference',
          origin: owner.origin,
          path: `$.observation_refs[${index}]`,
          message: `Observation reference ${reference} does not resolve in project ${project.id}`,
        });
        return [];
      }
      return [observation];
    },
  );
  const modules = new Map(
    project.modules.map((module) => [module.name, module]),
  );
  const resolvedModules = owner.artifact.module_refs.flatMap(
    (reference, index) => {
      const module = modules.get(reference);
      if (module === undefined) {
        issues.push({
          code: 'missing_module_reference',
          origin: owner.origin,
          path: `$.module_refs[${index}]`,
          message: `Module reference ${reference} does not resolve in project ${project.id}`,
        });
        return [];
      }
      return [module];
    },
  );

  const expectedEvidence = new Map<string, EvidenceReference>();
  const ambiguousEvidenceIds = new Set<string>();
  const evidenceSources = [
    ...resolvedObservations.map((observation) => observation.evidence),
    ...resolvedModules.map((module) => [
      ...module.evidence,
      ...(module.architecture_role?.evidence ?? []),
    ]),
  ];
  evidenceSources.forEach((evidenceItems) => {
    evidenceItems.forEach((evidence) => {
      const existing = expectedEvidence.get(evidence.id);
      if (existing === undefined) {
        expectedEvidence.set(evidence.id, evidence);
      } else if (!referencesEqual(existing, evidence)) {
        ambiguousEvidenceIds.add(evidence.id);
      }
    });
  });

  const actualEvidence = new Map(
    owner.artifact.evidence.map((evidence) => [evidence.id, evidence]),
  );
  owner.artifact.evidence.forEach((evidence, index) => {
    const expected = expectedEvidence.get(evidence.id);
    if (
      ambiguousEvidenceIds.has(evidence.id) ||
      expected === undefined ||
      !referencesEqual(expected, evidence)
    ) {
      issues.push({
        code: 'evidence_mismatch',
        origin: owner.origin,
        path: `$.evidence[${index}]`,
        message: `Rule evidence ${evidence.id} does not match evidence from its referenced project observations and modules`,
      });
    }
  });
  [...expectedEvidence.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .forEach(([id, evidence]) => {
      const actual = actualEvidence.get(id);
      if (
        actual === undefined ||
        ambiguousEvidenceIds.has(id) ||
        !referencesEqual(actual, evidence)
      ) {
        issues.push({
          code: 'missing_rule_evidence',
          origin: owner.origin,
          path: '$.evidence',
          message: `Rule evidence does not include the resolved evidence ${id}`,
        });
      }
    });
};

const addContentMismatch = (
  owner: LocatedArtifact,
  path: string,
  message: string,
  issues: RegistryIssue[],
): void => {
  issues.push({
    code: 'artifact_content_mismatch',
    origin: owner.origin,
    path,
    message,
  });
};

const addScopeMismatch = (
  owner: LocatedArtifact,
  path: string,
  message: string,
  issues: RegistryIssue[],
): void => {
  issues.push({
    code: 'artifact_scope_mismatch',
    origin: owner.origin,
    path,
    message,
  });
};

const validateMutationExceptionReferences = (
  owner: LocatedArtifact,
  indexedRecords: readonly {
    readonly record: {
      readonly id: string;
      readonly classification_status: string;
      readonly exception_ref?: string | undefined;
    };
    readonly index: number;
  }[],
  profile:
    Extract<CraftArtifact, { readonly kind: 'assurance_profile' }> | undefined,
  basePath: string,
  issues: RegistryIssue[],
): void => {
  if (profile === undefined) {
    return;
  }
  const exceptionsById = new Map(
    profile.exception_policy.active_exceptions.map((exception) => [
      exception.id,
      exception,
    ]),
  );
  indexedRecords.forEach(({ record, index }) => {
    if (
      record.classification_status !== 'accepted_exception' ||
      record.exception_ref === undefined
    ) {
      return;
    }
    const exception = exceptionsById.get(record.exception_ref);
    if (exception === undefined) {
      issues.push({
        code: 'missing_exception_reference',
        origin: owner.origin,
        path: `${basePath}[${index}].exception_ref`,
        message: `Mutation exception ${record.exception_ref} is not active in assurance profile ${profile.id}`,
      });
    } else if (!exception.applies_to?.mutation_ids.includes(record.id)) {
      issues.push({
        code: 'mutation_exception_scope_mismatch',
        origin: owner.origin,
        path: `${basePath}[${index}].exception_ref`,
        message: `Mutation exception ${record.exception_ref} does not explicitly apply to mutation ${record.id}`,
      });
    }
  });
};

const mutationDebtIdentity = (record: {
  readonly id: string;
  readonly outcome: string;
  readonly provider_outcome: string;
  readonly operator: string;
  readonly description: string;
  readonly location: unknown;
}): unknown => ({
  id: record.id,
  outcome: record.outcome,
  provider_outcome: record.provider_outcome,
  operator: record.operator,
  description: record.description,
  location: record.location,
});

const validateCrossArtifactReferences = (
  entries: readonly LocatedArtifact[],
  artifactsById: ReadonlyMap<string, LocatedArtifact>,
  duplicateIds: ReadonlySet<string>,
  issues: RegistryIssue[],
): void => {
  entries.forEach((entry) => {
    const { artifact } = entry;
    switch (artifact.kind) {
      case 'project_rule': {
        const projectEntry = validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        artifact.principle_refs.forEach((reference, index) => {
          validateArtifactReference(
            entry,
            `$.principle_refs[${index}]`,
            reference,
            'craftsmanship_principle',
            artifactsById,
            duplicateIds,
            issues,
          );
        });
        if (projectEntry?.artifact.kind === 'project_profile') {
          validateRuleEvidence(
            {
              origin: entry.origin,
              artifact,
            },
            projectEntry.artifact,
            issues,
          );
        }
        validateExceptionArtifactReferences(
          entry,
          artifact.exceptions.active_exceptions,
          '$.exceptions.active_exceptions',
          artifactsById,
          duplicateIds,
          issues,
        );
        break;
      }
      case 'assurance_profile':
        validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        validateExceptionArtifactReferences(
          entry,
          artifact.exception_policy.active_exceptions,
          '$.exception_policy.active_exceptions',
          artifactsById,
          duplicateIds,
          issues,
        );
        break;
      case 'change_context':
        validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        break;
      case 'change_impact':
        validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        {
          const changeEntry = validateArtifactReference(
            entry,
            '$.change_ref',
            artifact.change_ref,
            'change_context',
            artifactsById,
            duplicateIds,
            issues,
          );
          if (
            changeEntry?.artifact.kind === 'change_context' &&
            changeEntry.artifact.project_ref !== artifact.project_ref
          ) {
            issues.push({
              code: 'artifact_scope_mismatch',
              origin: entry.origin,
              path: '$.project_ref',
              message: `Change impact project ${artifact.project_ref} does not match change-context project ${changeEntry.artifact.project_ref}`,
            });
          }
        }
        break;
      case 'assurance_plan': {
        validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        const assuranceProfileEntry = validateArtifactReference(
          entry,
          '$.assurance_profile_ref',
          artifact.assurance_profile_ref,
          'assurance_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        let changeEntry: LocatedArtifact | undefined;
        let impactEntry: LocatedArtifact | undefined;
        if (artifact.change_context_ref !== undefined) {
          changeEntry = validateArtifactReference(
            entry,
            '$.change_context_ref',
            artifact.change_context_ref,
            'change_context',
            artifactsById,
            duplicateIds,
            issues,
          );
        }
        if (artifact.impact_ref !== undefined) {
          impactEntry = validateArtifactReference(
            entry,
            '$.impact_ref',
            artifact.impact_ref,
            'change_impact',
            artifactsById,
            duplicateIds,
            issues,
          );
        }
        if (
          assuranceProfileEntry?.artifact.kind === 'assurance_profile' &&
          assuranceProfileEntry.artifact.project_ref !== artifact.project_ref
        ) {
          issues.push({
            code: 'artifact_scope_mismatch',
            origin: entry.origin,
            path: '$.assurance_profile_ref',
            message: `Assurance-plan project ${artifact.project_ref} does not match assurance-profile project ${assuranceProfileEntry.artifact.project_ref}`,
          });
        }
        if (
          changeEntry?.artifact.kind === 'change_context' &&
          changeEntry.artifact.project_ref !== artifact.project_ref
        ) {
          issues.push({
            code: 'artifact_scope_mismatch',
            origin: entry.origin,
            path: '$.change_context_ref',
            message: `Assurance-plan project ${artifact.project_ref} does not match change-context project ${changeEntry.artifact.project_ref}`,
          });
        }
        if (
          impactEntry?.artifact.kind === 'change_impact' &&
          impactEntry.artifact.project_ref !== artifact.project_ref
        ) {
          issues.push({
            code: 'artifact_scope_mismatch',
            origin: entry.origin,
            path: '$.impact_ref',
            message: `Assurance-plan project ${artifact.project_ref} does not match impact project ${impactEntry.artifact.project_ref}`,
          });
        }
        if (
          changeEntry?.artifact.kind === 'change_context' &&
          impactEntry?.artifact.kind === 'change_impact' &&
          impactEntry.artifact.change_ref !== changeEntry.artifact.id
        ) {
          issues.push({
            code: 'artifact_scope_mismatch',
            origin: entry.origin,
            path: '$.impact_ref',
            message: `Impact change ${impactEntry.artifact.change_ref} does not match assurance-plan change context ${changeEntry.artifact.id}`,
          });
        }
        break;
      }
      case 'mutation_report': {
        validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        const profileEntry = validateArtifactReference(
          entry,
          '$.assurance_profile_ref',
          artifact.assurance_profile_ref,
          'assurance_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        const planEntry = validateArtifactReference(
          entry,
          '$.assurance_plan_ref',
          artifact.assurance_plan_ref,
          'assurance_plan',
          artifactsById,
          duplicateIds,
          issues,
        );
        const profile =
          profileEntry?.artifact.kind === 'assurance_profile'
            ? profileEntry.artifact
            : undefined;
        if (
          profile !== undefined &&
          profile.project_ref !== artifact.project_ref
        ) {
          addScopeMismatch(
            entry,
            '$.assurance_profile_ref',
            `Mutation-report project ${artifact.project_ref} does not match assurance-profile project ${profile.project_ref}`,
            issues,
          );
        }
        if (planEntry?.artifact.kind === 'assurance_plan') {
          const plan = planEntry.artifact;
          if (plan.project_ref !== artifact.project_ref) {
            addScopeMismatch(
              entry,
              '$.assurance_plan_ref',
              `Mutation-report project ${artifact.project_ref} does not match assurance-plan project ${plan.project_ref}`,
              issues,
            );
          }
          if (plan.assurance_profile_ref !== artifact.assurance_profile_ref) {
            addScopeMismatch(
              entry,
              '$.assurance_profile_ref',
              `Mutation-report assurance profile ${artifact.assurance_profile_ref} does not match assurance-plan profile ${plan.assurance_profile_ref}`,
              issues,
            );
          }
          if (plan.mutation_scope === undefined) {
            addContentMismatch(
              entry,
              '$.assurance_plan_ref',
              `Assurance plan ${plan.id} does not define a mutation scope`,
              issues,
            );
          } else if (!referencesEqual(plan.mutation_scope, artifact.scope)) {
            addContentMismatch(
              entry,
              '$.scope',
              `Mutation-report scope does not match assurance plan ${plan.id}`,
              issues,
            );
          }
        }
        validateMutationExceptionReferences(
          entry,
          artifact.mutations.flatMap((mutation, index) =>
            mutation.outcome === 'survived' ||
            mutation.outcome === 'no_coverage'
              ? [{ record: mutation, index }]
              : [],
          ),
          profile,
          '$.mutations',
          issues,
        );
        break;
      }
      case 'mutation_baseline': {
        validateArtifactReference(
          entry,
          '$.project_ref',
          artifact.project_ref,
          'project_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        const profileEntry = validateArtifactReference(
          entry,
          '$.assurance_profile_ref',
          artifact.assurance_profile_ref,
          'assurance_profile',
          artifactsById,
          duplicateIds,
          issues,
        );
        const sourceReportEntry = validateArtifactReference(
          entry,
          '$.source_report_ref',
          artifact.source_report_ref,
          'mutation_report',
          artifactsById,
          duplicateIds,
          issues,
        );
        const profile =
          profileEntry?.artifact.kind === 'assurance_profile'
            ? profileEntry.artifact
            : undefined;
        if (
          profile !== undefined &&
          profile.project_ref !== artifact.project_ref
        ) {
          addScopeMismatch(
            entry,
            '$.assurance_profile_ref',
            `Mutation-baseline project ${artifact.project_ref} does not match assurance-profile project ${profile.project_ref}`,
            issues,
          );
        }
        if (sourceReportEntry?.artifact.kind === 'mutation_report') {
          const sourceReport = sourceReportEntry.artifact;
          if (sourceReport.project_ref !== artifact.project_ref) {
            addScopeMismatch(
              entry,
              '$.source_report_ref',
              `Mutation-baseline project ${artifact.project_ref} does not match source-report project ${sourceReport.project_ref}`,
              issues,
            );
          }
          if (
            sourceReport.assurance_profile_ref !==
            artifact.assurance_profile_ref
          ) {
            addScopeMismatch(
              entry,
              '$.assurance_profile_ref',
              `Mutation-baseline profile ${artifact.assurance_profile_ref} does not match source-report profile ${sourceReport.assurance_profile_ref}`,
              issues,
            );
          }
          if (!referencesEqual(sourceReport.provider, artifact.provider)) {
            addContentMismatch(
              entry,
              '$.provider',
              `Mutation-baseline provider does not match source report ${sourceReport.id}`,
              issues,
            );
          }
          if (!referencesEqual(sourceReport.scope, artifact.scope)) {
            addContentMismatch(
              entry,
              '$.scope',
              `Mutation-baseline scope does not match source report ${sourceReport.id}`,
              issues,
            );
          }
          const expectedSourceRun = {
            completeness: sourceReport.run.completeness,
            totals: sourceReport.totals,
            limitations: sourceReport.run.limitations,
          };
          if (!referencesEqual(expectedSourceRun, artifact.source_run)) {
            addContentMismatch(
              entry,
              '$.source_run',
              `Mutation-baseline source run does not match report ${sourceReport.id}`,
              issues,
            );
          }
          const sourceDebt = sourceReport.mutations.filter(
            (mutation) =>
              mutation.outcome === 'survived' ||
              mutation.outcome === 'no_coverage',
          );
          const sourceById = new Map(
            sourceDebt.map((mutation) => [mutation.id, mutation]),
          );
          artifact.entries.forEach((baselineEntry, index) => {
            const sourceEntry = sourceById.get(baselineEntry.id);
            if (sourceEntry === undefined) {
              addContentMismatch(
                entry,
                `$.entries[${index}].id`,
                `Baseline mutation ${baselineEntry.id} is absent from source report ${sourceReport.id}`,
                issues,
              );
            } else if (
              !referencesEqual(
                mutationDebtIdentity(sourceEntry),
                mutationDebtIdentity(baselineEntry),
              )
            ) {
              addContentMismatch(
                entry,
                `$.entries[${index}]`,
                `Baseline mutation ${baselineEntry.id} does not match its source-report identity and outcome`,
                issues,
              );
            }
          });
          const baselineIds = artifact.entries.map((mutation) => mutation.id);
          const sourceIds = sourceDebt.map((mutation) => mutation.id);
          if (!referencesEqual(baselineIds, sourceIds)) {
            addContentMismatch(
              entry,
              '$.entries',
              `Mutation baseline must retain every survivor and no-coverage record from source report ${sourceReport.id}`,
              issues,
            );
          }
        }
        validateMutationExceptionReferences(
          entry,
          artifact.entries.map((record, index) => ({ record, index })),
          profile,
          '$.entries',
          issues,
        );
        if (artifact.superseded_by !== undefined) {
          const successorEntry = validateArtifactReference(
            entry,
            '$.superseded_by',
            artifact.superseded_by,
            'mutation_baseline',
            artifactsById,
            duplicateIds,
            issues,
          );
          if (
            successorEntry?.artifact.kind === 'mutation_baseline' &&
            successorEntry.artifact.project_ref !== artifact.project_ref
          ) {
            addScopeMismatch(
              entry,
              '$.superseded_by',
              `Successor baseline ${successorEntry.artifact.id} belongs to project ${successorEntry.artifact.project_ref}`,
              issues,
            );
          }
        }
        break;
      }
      case 'craftsmanship_principle':
      case 'practice_statement':
      case 'project_profile':
        break;
    }
  });
};

/**
 * Builds a provider-independent registry and validates every currently
 * resolvable cross-artifact reference.
 *
 * Mutation reports and baselines are validated against their project,
 * assurance policy, plan scope, provider identity, and source run.
 */
export const createArtifactRegistry = (
  entries: readonly LocatedArtifact[],
): ArtifactRegistryResult => {
  const orderedEntries = [...entries].sort(compareLocatedArtifacts);
  const issues: RegistryIssue[] = [];

  const artifactGroups = new Map<string, LocatedArtifact[]>();
  orderedEntries.forEach((entry) => {
    const group = artifactGroups.get(entry.artifact.id);
    if (group === undefined) {
      artifactGroups.set(entry.artifact.id, [entry]);
    } else {
      group.push(entry);
    }
  });

  const duplicateIds = new Set<string>();
  const artifactsById = new Map<string, LocatedArtifact>();
  [...artifactGroups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .forEach(([id, group]) => {
      if (group.length === 1) {
        const entry = group[0];
        if (entry !== undefined) {
          artifactsById.set(id, entry);
        }
        return;
      }
      duplicateIds.add(id);
      const origins = group.map((entry) => entry.origin).join(', ');
      const first = group[0];
      if (first !== undefined) {
        issues.push({
          code: 'duplicate_artifact_id',
          origin: first.origin,
          path: '$.id',
          message: `Artifact ID ${id} is duplicated across: ${origins}`,
        });
      }
    });

  const sourceOccurrences = orderedEntries.flatMap(collectSources);
  const sourceGroups = groupById(sourceOccurrences);
  const conflictingSourceIds = findConflictingReferenceIds(
    sourceGroups,
    'conflicting_source_reference',
    'Source reference',
    issues,
  );

  const evidenceOccurrencesList = orderedEntries.flatMap(collectEvidence);
  const evidenceGroups = groupByKey(
    evidenceOccurrencesList,
    (occurrence) => `${occurrence.scope}\u0000${occurrence.reference.id}`,
  );
  findConflictingReferenceIds(
    evidenceGroups,
    'conflicting_evidence_reference',
    'Evidence reference',
    issues,
  );

  evidenceOccurrencesList.forEach((occurrence) => {
    const sourceReference = occurrence.reference.source_ref;
    if (sourceReference === undefined) {
      return;
    }
    if (conflictingSourceIds.has(sourceReference)) {
      issues.push({
        code: 'ambiguous_source_reference',
        origin: occurrence.origin,
        path: `${occurrence.path}.source_ref`,
        message: `Source reference ${sourceReference} is ambiguous because its definitions conflict`,
      });
    } else if (!sourceGroups.has(sourceReference)) {
      issues.push({
        code: 'missing_source_reference',
        origin: occurrence.origin,
        path: `${occurrence.path}.source_ref`,
        message: `Source reference ${sourceReference} does not resolve`,
      });
    }
  });

  validateCrossArtifactReferences(
    orderedEntries,
    artifactsById,
    duplicateIds,
    issues,
  );

  if (issues.length > 0) {
    return {
      success: false,
      issues: issues.sort(compareIssues),
    };
  }
  return {
    success: true,
    registry: {
      entries: orderedEntries,
    },
  };
};

/** Finds an artifact by its globally unique registry ID. */
export const findRegistryArtifact = (
  registry: ArtifactRegistry,
  id: string,
): LocatedArtifact | undefined =>
  registry.entries.find((entry) => entry.artifact.id === id);
