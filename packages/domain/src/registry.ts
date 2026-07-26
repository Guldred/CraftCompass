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
  | 'artifact_scope_mismatch'
  | 'conflicting_evidence_reference'
  | 'conflicting_source_reference'
  | 'duplicate_artifact_id'
  | 'evidence_mismatch'
  | 'missing_artifact_reference'
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
          artifact.kind === 'change_impact'
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
        ...artifact.survivors.flatMap((survivor, survivorIndex) =>
          evidenceOccurrences(
            origin,
            scope,
            `$.survivors[${survivorIndex}].evidence`,
            survivor.evidence,
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
      case 'craftsmanship_principle':
      case 'practice_statement':
      case 'project_profile':
      case 'mutation_report':
        break;
    }
  });
};

/**
 * Builds a provider-independent registry and validates every currently
 * resolvable cross-artifact reference.
 *
 * Mutation baseline references are intentionally deferred until a baseline
 * artifact kind exists.
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
