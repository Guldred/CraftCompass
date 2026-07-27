import type {
  AssuranceEvidence,
  MutationBaseline,
  MutationDebtRecord,
  MutationRecord,
  MutationReport,
} from '@craftcompass/domain';

import {
  artifactIdOrFallback,
  validateMutationBaselineInput,
  validateMutationReportInput,
} from './input-validation.js';

export type MutationComparisonIssueCode =
  | 'assurance_profile_mismatch'
  | 'baseline_candidate'
  | 'baseline_duplicate_debt_ids'
  | 'baseline_input_limit_exceeded'
  | 'baseline_invalid'
  | 'baseline_source_errors'
  | 'baseline_source_partial'
  | 'baseline_source_timed_out'
  | 'baseline_source_zero_generated'
  | 'baseline_superseded'
  | 'baseline_configuration_fingerprint_missing'
  | 'baseline_tool_version_missing'
  | 'configuration_fingerprint_mismatch'
  | 'current_configuration_fingerprint_missing'
  | 'current_duplicate_mutation_ids'
  | 'current_execution_evidence_ambiguous'
  | 'current_execution_evidence_configuration_mismatch'
  | 'current_execution_evidence_missing'
  | 'current_execution_evidence_provider_mismatch'
  | 'current_execution_evidence_run_id_mismatch'
  | 'current_execution_evidence_status_mismatch'
  | 'current_execution_evidence_tool_version_mismatch'
  | 'current_report_input_limit_exceeded'
  | 'current_report_invalid'
  | 'current_run_errors'
  | 'current_run_partial'
  | 'current_run_timed_out'
  | 'current_run_zero_generated'
  | 'current_tool_version_missing'
  | 'mutation_identity_mismatch'
  | 'normalization_version_mismatch'
  | 'primary_targets_mismatch'
  | 'project_mismatch'
  | 'provider_id_mismatch'
  | 'provider_tool_version_mismatch'
  | 'relevant_tests_mismatch'
  | 'scope_confidence_mismatch'
  | 'scope_limitations_mismatch'
  | 'supporting_targets_mismatch';

/** One deterministic explanation for an incomparable pair. */
export interface MutationComparisonIssue {
  readonly code: MutationComparisonIssueCode;
  readonly mutationIds: readonly string[];
}

/** Like-for-like mutation-debt delta with transitions kept explicit. */
export interface ComparableMutationReport {
  readonly status: 'comparable';
  readonly reportId: string;
  readonly baselineId: string;
  readonly newDebtIds: readonly string[];
  readonly unchangedDebtIds: readonly string[];
  readonly resolvedDebtIds: readonly string[];
  readonly survivedToNoCoverageIds: readonly string[];
  readonly noCoverageToSurvivedIds: readonly string[];
}

/** Explicit refusal to compare runs that are not decision-compatible. */
export interface IncomparableMutationReport {
  readonly status: 'incomparable';
  readonly reportId: string;
  readonly baselineId: string;
  readonly issues: readonly MutationComparisonIssue[];
}

export type MutationReportComparison =
  ComparableMutationReport | IncomparableMutationReport;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sorted = (values: Iterable<string>): readonly string[] =>
  [...values].sort(compareText);

const sameCanonicalList = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const canonicalLeft = sorted(left);
  const canonicalRight = sorted(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
};

const duplicateIds = (
  records: readonly { readonly id: string }[],
): readonly string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  records.forEach((record) => {
    if (seen.has(record.id)) {
      duplicates.add(record.id);
    }
    seen.add(record.id);
  });
  return sorted(duplicates);
};

const debtRecords = (report: MutationReport): readonly MutationDebtRecord[] =>
  report.mutations.filter(
    (mutation): mutation is MutationDebtRecord =>
      mutation.outcome === 'survived' || mutation.outcome === 'no_coverage',
  );

const issue = (
  code: MutationComparisonIssueCode,
  mutationIds: readonly string[] = [],
): MutationComparisonIssue => ({
  code,
  mutationIds: sorted(new Set(mutationIds)),
});

const compareIssues = (
  left: MutationComparisonIssue,
  right: MutationComparisonIssue,
): number =>
  compareText(left.code, right.code) ||
  compareText(
    left.mutationIds.join('\u0000'),
    right.mutationIds.join('\u0000'),
  );

const canonicalIssues = (
  issues: readonly MutationComparisonIssue[],
): readonly MutationComparisonIssue[] => {
  const unique = new Map<string, MutationComparisonIssue>();
  issues.forEach((comparisonIssue) => {
    const normalized = issue(comparisonIssue.code, comparisonIssue.mutationIds);
    unique.set(
      `${normalized.code}\u0000${normalized.mutationIds.join('\u0000')}`,
      normalized,
    );
  });
  return [...unique.values()].sort(compareIssues);
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dataProperty = (input: UnknownRecord, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

/**
 * Classifies evidence-specific failures even when the domain schema rejects
 * the full report. This keeps public failure codes stable and actionable.
 */
const rawExecutionEvidenceIssues = (
  input: unknown,
): readonly MutationComparisonIssue[] => {
  try {
    if (!isRecord(input)) {
      return [];
    }
    const rawEvidence = dataProperty(input, 'evidence');
    if (!Array.isArray(rawEvidence)) {
      return [issue('current_execution_evidence_missing')];
    }
    const evidenceItems: readonly unknown[] = rawEvidence;
    const mutationEvidence: UnknownRecord[] = [];
    evidenceItems.forEach((candidate) => {
      if (
        isRecord(candidate) &&
        dataProperty(candidate, 'type') === 'mutation_run'
      ) {
        mutationEvidence.push(candidate);
      }
    });
    if (mutationEvidence.length === 0) {
      return [issue('current_execution_evidence_missing')];
    }
    if (mutationEvidence.length > 1) {
      return [issue('current_execution_evidence_ambiguous')];
    }

    const provider = dataProperty(input, 'provider');
    const runEvidence = mutationEvidence[0];
    const execution =
      runEvidence === undefined
        ? undefined
        : dataProperty(runEvidence, 'execution');
    const result: MutationComparisonIssue[] = [];
    if (!isRecord(provider) || !isRecord(execution)) {
      return [
        issue('current_execution_evidence_provider_mismatch'),
        issue('current_execution_evidence_run_id_mismatch'),
      ];
    }
    if (dataProperty(execution, 'tool') !== dataProperty(provider, 'id')) {
      result.push(issue('current_execution_evidence_provider_mismatch'));
    }
    if (
      dataProperty(execution, 'version') !==
      dataProperty(provider, 'tool_version')
    ) {
      result.push(issue('current_execution_evidence_tool_version_mismatch'));
    }
    if (
      dataProperty(execution, 'invocation') !==
      dataProperty(provider, 'configuration_fingerprint')
    ) {
      result.push(issue('current_execution_evidence_configuration_mismatch'));
    }
    if (
      dataProperty(execution, 'run_id') !==
      dataProperty(input, 'provider_run_id')
    ) {
      result.push(issue('current_execution_evidence_run_id_mismatch'));
    }
    return result;
  } catch {
    return [];
  }
};

const expectedEvidenceStatus = (
  report: MutationReport,
): AssuranceEvidence['status'] => {
  const allKilled =
    report.run.completeness === 'complete' &&
    report.mutations.length > 0 &&
    report.mutations.every((mutation) => mutation.outcome === 'killed');
  return allKilled ? 'passed' : 'conditional';
};

const collectExecutionEvidenceIssues = (
  report: MutationReport,
  issues: MutationComparisonIssue[],
): void => {
  const mutationEvidence = report.evidence.filter(
    (evidence) => evidence.type === 'mutation_run',
  );
  if (mutationEvidence.length === 0) {
    issues.push(issue('current_execution_evidence_missing'));
    return;
  }
  if (mutationEvidence.length > 1) {
    issues.push(issue('current_execution_evidence_ambiguous'));
    return;
  }
  const evidence = mutationEvidence[0];
  if (evidence === undefined) {
    issues.push(issue('current_execution_evidence_missing'));
    return;
  }
  if (evidence.execution?.tool !== report.provider.id) {
    issues.push(issue('current_execution_evidence_provider_mismatch'));
  }
  if (evidence.execution?.version !== report.provider.tool_version) {
    issues.push(issue('current_execution_evidence_tool_version_mismatch'));
  }
  if (
    evidence.execution?.invocation !== report.provider.configuration_fingerprint
  ) {
    issues.push(issue('current_execution_evidence_configuration_mismatch'));
  }
  if (evidence.execution?.run_id !== report.provider_run_id) {
    issues.push(issue('current_execution_evidence_run_id_mismatch'));
  }
  if (evidence.status !== expectedEvidenceStatus(report)) {
    issues.push(issue('current_execution_evidence_status_mismatch'));
  }
};

const sameLocation = (
  left: MutationRecord['location'],
  right: MutationRecord['location'],
): boolean =>
  left.provider_source === right.provider_source &&
  left.file === right.file &&
  left.symbol === right.symbol &&
  left.line === right.line;

const sameMutationIdentity = (
  previous: MutationDebtRecord,
  current: MutationRecord,
): boolean =>
  previous.operator === current.operator &&
  previous.description === current.description &&
  sameLocation(previous.location, current.location) &&
  // A raw provider outcome is stable unless this is the explicit normalized
  // outcome transition that the comparison model is designed to report.
  (previous.outcome !== current.outcome ||
    previous.provider_outcome === current.provider_outcome);

const incomparable = (
  reportId: string,
  baselineId: string,
  issues: readonly MutationComparisonIssue[],
): IncomparableMutationReport => ({
  status: 'incomparable',
  reportId,
  baselineId,
  issues: canonicalIssues(issues),
});

/**
 * Compares only validated, complete, exact-scope, exact-provider,
 * active-baseline runs.
 */
export function compareMutationReport(
  reportInput: MutationReport,
  baselineInput: MutationBaseline,
): MutationReportComparison;
export function compareMutationReport(
  reportInput: unknown,
  baselineInput: unknown,
): MutationReportComparison {
  const reportId = artifactIdOrFallback(reportInput, 'INVALID-REPORT');
  const baselineId = artifactIdOrFallback(baselineInput, 'INVALID-BASELINE');
  const reportResult = validateMutationReportInput(reportInput);
  const baselineResult = validateMutationBaselineInput(baselineInput);
  const boundaryIssues: MutationComparisonIssue[] = [];
  if (!reportResult.success) {
    boundaryIssues.push(
      issue(
        reportResult.kind === 'limit'
          ? 'current_report_input_limit_exceeded'
          : 'current_report_invalid',
      ),
    );
    if (reportResult.kind === 'invalid') {
      boundaryIssues.push(...rawExecutionEvidenceIssues(reportInput));
    }
  }
  if (!baselineResult.success) {
    boundaryIssues.push(
      issue(
        baselineResult.kind === 'limit'
          ? 'baseline_input_limit_exceeded'
          : 'baseline_invalid',
      ),
    );
  }
  if (!reportResult.success || !baselineResult.success) {
    return incomparable(reportId, baselineId, boundaryIssues);
  }

  const report = reportResult.data;
  const baseline = baselineResult.data;
  const issues: MutationComparisonIssue[] = [];
  if (baseline.status === 'candidate') {
    issues.push(issue('baseline_candidate'));
  } else if (baseline.status === 'superseded') {
    issues.push(issue('baseline_superseded'));
  }
  if (report.project_ref !== baseline.project_ref) {
    issues.push(issue('project_mismatch'));
  }
  if (report.assurance_profile_ref !== baseline.assurance_profile_ref) {
    issues.push(issue('assurance_profile_mismatch'));
  }
  if (report.provider.id !== baseline.provider.id) {
    issues.push(issue('provider_id_mismatch'));
  }
  if (baseline.provider.tool_version === undefined) {
    issues.push(issue('baseline_tool_version_missing'));
  }
  if (report.provider.tool_version === undefined) {
    issues.push(issue('current_tool_version_missing'));
  }
  if (report.provider.tool_version !== baseline.provider.tool_version) {
    issues.push(issue('provider_tool_version_mismatch'));
  }
  if (baseline.provider.configuration_fingerprint === undefined) {
    issues.push(issue('baseline_configuration_fingerprint_missing'));
  }
  if (report.provider.configuration_fingerprint === undefined) {
    issues.push(issue('current_configuration_fingerprint_missing'));
  }
  if (
    report.provider.configuration_fingerprint !==
    baseline.provider.configuration_fingerprint
  ) {
    issues.push(issue('configuration_fingerprint_mismatch'));
  }
  if (
    report.provider.normalization_version !==
    baseline.provider.normalization_version
  ) {
    issues.push(issue('normalization_version_mismatch'));
  }
  if (
    !sameCanonicalList(
      report.scope.primary_targets,
      baseline.scope.primary_targets,
    )
  ) {
    issues.push(issue('primary_targets_mismatch'));
  }
  if (
    !sameCanonicalList(
      report.scope.supporting_targets,
      baseline.scope.supporting_targets,
    )
  ) {
    issues.push(issue('supporting_targets_mismatch'));
  }
  if (
    !sameCanonicalList(
      report.scope.relevant_tests,
      baseline.scope.relevant_tests,
    )
  ) {
    issues.push(issue('relevant_tests_mismatch'));
  }
  if (report.scope.confidence !== baseline.scope.confidence) {
    issues.push(issue('scope_confidence_mismatch'));
  }
  if (
    !sameCanonicalList(report.scope.limitations, baseline.scope.limitations)
  ) {
    issues.push(issue('scope_limitations_mismatch'));
  }
  if (baseline.source_run.completeness !== 'complete') {
    issues.push(issue('baseline_source_partial'));
  }
  if (baseline.source_run.totals.generated === 0) {
    issues.push(issue('baseline_source_zero_generated'));
  }
  if (baseline.source_run.totals.timed_out > 0) {
    issues.push(issue('baseline_source_timed_out'));
  }
  if (baseline.source_run.totals.errors > 0) {
    issues.push(issue('baseline_source_errors'));
  }

  const currentDuplicateIds = duplicateIds(report.mutations);
  if (currentDuplicateIds.length > 0) {
    issues.push(issue('current_duplicate_mutation_ids', currentDuplicateIds));
  }
  const baselineDuplicateIds = duplicateIds(baseline.entries);
  if (baselineDuplicateIds.length > 0) {
    issues.push(issue('baseline_duplicate_debt_ids', baselineDuplicateIds));
  }
  if (report.run.completeness !== 'complete') {
    issues.push(issue('current_run_partial'));
  }
  if (report.mutations.length === 0) {
    issues.push(issue('current_run_zero_generated'));
  }
  const timedOutIds = report.mutations
    .filter((mutation) => mutation.outcome === 'timed_out')
    .map((mutation) => mutation.id);
  if (timedOutIds.length > 0) {
    issues.push(issue('current_run_timed_out', timedOutIds));
  }
  const errorIds = report.mutations
    .filter((mutation) => mutation.outcome === 'error')
    .map((mutation) => mutation.id);
  if (errorIds.length > 0) {
    issues.push(issue('current_run_errors', errorIds));
  }
  collectExecutionEvidenceIssues(report, issues);

  const currentById = new Map(
    report.mutations.map((record) => [record.id, record]),
  );
  const identityMismatchIds = baseline.entries
    .filter((previous) => {
      const current = currentById.get(previous.id);
      return current !== undefined && !sameMutationIdentity(previous, current);
    })
    .map((record) => record.id);
  if (identityMismatchIds.length > 0) {
    issues.push(issue('mutation_identity_mismatch', identityMismatchIds));
  }

  if (issues.length > 0) {
    return incomparable(report.id, baseline.id, issues);
  }

  const baselineById = new Map(
    baseline.entries.map((entry) => [entry.id, entry]),
  );
  const currentDebt = debtRecords(report);
  const currentDebtById = new Map(
    currentDebt.map((entry) => [entry.id, entry]),
  );
  const newDebtIds: string[] = [];
  const unchangedDebtIds: string[] = [];
  const resolvedDebtIds: string[] = [];
  const survivedToNoCoverageIds: string[] = [];
  const noCoverageToSurvivedIds: string[] = [];

  currentDebtById.forEach((current, id) => {
    const previous = baselineById.get(id);
    if (previous === undefined) {
      newDebtIds.push(id);
    } else if (previous.outcome === current.outcome) {
      unchangedDebtIds.push(id);
    } else if (
      previous.outcome === 'survived' &&
      current.outcome === 'no_coverage'
    ) {
      survivedToNoCoverageIds.push(id);
    } else {
      noCoverageToSurvivedIds.push(id);
    }
  });
  baselineById.forEach((_previous, id) => {
    if (!currentDebtById.has(id)) {
      resolvedDebtIds.push(id);
    }
  });

  return {
    status: 'comparable',
    reportId: report.id,
    baselineId: baseline.id,
    newDebtIds: sorted(newDebtIds),
    unchangedDebtIds: sorted(unchangedDebtIds),
    resolvedDebtIds: sorted(resolvedDebtIds),
    survivedToNoCoverageIds: sorted(survivedToNoCoverageIds),
    noCoverageToSurvivedIds: sorted(noCoverageToSurvivedIds),
  };
}
