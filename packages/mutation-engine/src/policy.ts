import type {
  AssuranceProfile,
  MutationBaseline,
  MutationDebtRecord,
  MutationReport,
} from '@craftcompass/domain';

import {
  compareMutationReport,
  type ComparableMutationReport,
  type MutationComparisonIssueCode,
  type MutationReportComparison,
} from './comparison.js';
import {
  artifactIdOrFallback,
  readRequestEnvelope,
  validateAssuranceProfileInput,
  validateMutationBaselineInput,
  validateMutationReportInput,
} from './input-validation.js';

export type MutationPolicyReasonCode =
  | MutationComparisonIssueCode
  | 'accepted_risk_exception_changed'
  | 'accepted_risk_exception_expired'
  | 'accepted_risk_exception_missing'
  | 'accepted_risk_exception_not_applicable'
  | 'accepted_risk_exception_policy_disabled'
  | 'accepted_risk_human_governance_missing'
  | 'baseline_missing'
  | 'baseline_policy_not_available'
  | 'invalid_evaluation_registry'
  | 'invalid_evaluation_request'
  | 'invalid_evaluation_selection'
  | 'invalid_evaluation_time'
  | 'mutation_policy_satisfied'
  | 'new_equivalent_candidate'
  | 'new_no_coverage'
  | 'new_test_gap'
  | 'new_unaccepted_classification'
  | 'new_unconfirmed_classification'
  | 'new_unresolved_mutation'
  | 'policy_profile_input_limit_exceeded'
  | 'policy_profile_invalid'
  | 'policy_profile_mismatch'
  | 'survived_to_no_coverage_regression';

/** One stable policy reason with the exact affected mutation identities. */
export interface MutationPolicyReason {
  readonly code: MutationPolicyReasonCode;
  readonly mutationIds: readonly string[];
}

/** Total, deterministic decision produced without consulting a mutation score. */
export interface MutationPolicyEvaluation {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly reportId: string;
  readonly baselineId?: string;
  readonly reasons: readonly MutationPolicyReason[];
  readonly affectedMutationIds: readonly string[];
  readonly comparison?: MutationReportComparison;
}

/** Inputs to the project mutation policy. */
export interface EvaluateMutationPolicyRequest {
  readonly report: MutationReport;
  readonly baseline?: MutationBaseline;
  readonly profile: AssuranceProfile;
  readonly now: Date;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

class ReasonCollector {
  readonly #byCode = new Map<MutationPolicyReasonCode, Set<string>>();

  add(
    code: MutationPolicyReasonCode,
    mutationIds: readonly string[] = [],
  ): void {
    const ids = this.#byCode.get(code) ?? new Set<string>();
    mutationIds.forEach((id) => ids.add(id));
    this.#byCode.set(code, ids);
  }

  get empty(): boolean {
    return this.#byCode.size === 0;
  }

  reasons(): readonly MutationPolicyReason[] {
    return [...this.#byCode.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([code, ids]) => ({
        code,
        mutationIds: [...ids].sort(compareText),
      }));
  }

  affectedMutationIds(): readonly string[] {
    return [
      ...new Set([...this.#byCode.values()].flatMap((ids) => [...ids])),
    ].sort(compareText);
  }
}

const result = (
  status: MutationPolicyEvaluation['status'],
  reportId: string,
  baselineId: string | undefined,
  reasons: ReasonCollector,
  comparison?: MutationReportComparison,
): MutationPolicyEvaluation => ({
  status,
  reportId,
  ...(baselineId === undefined ? {} : { baselineId }),
  reasons: reasons.reasons(),
  affectedMutationIds: reasons.affectedMutationIds(),
  ...(comparison === undefined ? {} : { comparison }),
});

const hasHumanDecision = (record: MutationDebtRecord): boolean =>
  record.evidence.some((evidence) => evidence.type === 'human_decision');

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
  return [...duplicates].sort(compareText);
};

const collectCurrentEligibility = (
  report: MutationReport,
  reasons: ReasonCollector,
): void => {
  if (report.provider.tool_version === undefined) {
    reasons.add('current_tool_version_missing');
  }
  if (report.provider.configuration_fingerprint === undefined) {
    reasons.add('current_configuration_fingerprint_missing');
  }
  if (report.run.completeness !== 'complete') {
    reasons.add('current_run_partial');
  }
  if (report.mutations.length === 0) {
    reasons.add('current_run_zero_generated');
  }
  const duplicates = duplicateIds(report.mutations);
  if (duplicates.length > 0) {
    reasons.add('current_duplicate_mutation_ids', duplicates);
  }
  const timedOutIds = report.mutations
    .filter((mutation) => mutation.outcome === 'timed_out')
    .map((mutation) => mutation.id);
  if (timedOutIds.length > 0) {
    reasons.add('current_run_timed_out', timedOutIds);
  }
  const errorIds = report.mutations
    .filter((mutation) => mutation.outcome === 'error')
    .map((mutation) => mutation.id);
  if (errorIds.length > 0) {
    reasons.add('current_run_errors', errorIds);
  }
};

const evaluateAcceptedRisk = (
  record: MutationDebtRecord,
  profile: AssuranceProfile,
  today: string,
  reasons: ReasonCollector,
): void => {
  if (!profile.exception_policy.allowed) {
    reasons.add('accepted_risk_exception_policy_disabled', [record.id]);
    return;
  }
  const exception =
    record.exception_ref === undefined
      ? undefined
      : profile.exception_policy.active_exceptions.find(
          (candidate) => candidate.id === record.exception_ref,
        );
  if (exception === undefined) {
    reasons.add('accepted_risk_exception_missing', [record.id]);
    return;
  }
  if (exception.expires_on < today) {
    reasons.add('accepted_risk_exception_expired', [record.id]);
  }
  if (!exception.applies_to?.mutation_ids.includes(record.id)) {
    reasons.add('accepted_risk_exception_not_applicable', [record.id]);
  }
};

const evaluateNewDebt = (
  record: MutationDebtRecord,
  profile: AssuranceProfile,
  today: string,
  reasons: ReasonCollector,
): void => {
  if (record.outcome === 'no_coverage') {
    reasons.add('new_no_coverage', [record.id]);
    return;
  }
  if (
    record.classification_status === 'unresolved' ||
    record.classification === 'unknown'
  ) {
    reasons.add('new_unresolved_mutation', [record.id]);
    return;
  }
  if (record.classification === 'test_gap') {
    reasons.add('new_test_gap', [record.id]);
    return;
  }
  if (
    record.classification === 'equivalent' &&
    record.classification_status === 'candidate'
  ) {
    reasons.add('new_equivalent_candidate', [record.id]);
    return;
  }
  if (record.classification === 'accepted_risk') {
    if (
      record.classification_status !== 'accepted_exception' ||
      !hasHumanDecision(record)
    ) {
      reasons.add('new_unaccepted_classification', [record.id]);
      return;
    }
    evaluateAcceptedRisk(record, profile, today, reasons);
    return;
  }
  if (
    record.classification_status === 'confirmed' &&
    hasHumanDecision(record)
  ) {
    return;
  }
  if (
    record.classification_status !== 'confirmed' ||
    !hasHumanDecision(record)
  ) {
    reasons.add('new_unconfirmed_classification', [record.id]);
  } else {
    reasons.add('new_unaccepted_classification', [record.id]);
  }
};

const evaluateExistingAcceptedRisk = (
  current: MutationDebtRecord,
  previous: MutationDebtRecord,
  profile: AssuranceProfile,
  today: string,
  reasons: ReasonCollector,
): void => {
  if (previous.classification === 'accepted_risk') {
    if (
      current.classification !== 'accepted_risk' ||
      current.classification_status !== 'accepted_exception' ||
      current.exception_ref !== previous.exception_ref
    ) {
      reasons.add('accepted_risk_exception_changed', [current.id]);
      return;
    }
    if (!hasHumanDecision(current)) {
      reasons.add('accepted_risk_human_governance_missing', [current.id]);
      return;
    }
    evaluateAcceptedRisk(current, profile, today, reasons);
    return;
  }
  if (current.classification === 'accepted_risk') {
    if (
      current.classification_status !== 'accepted_exception' ||
      !hasHumanDecision(current)
    ) {
      reasons.add('accepted_risk_human_governance_missing', [current.id]);
      return;
    }
    evaluateAcceptedRisk(current, profile, today, reasons);
  }
};

const evaluateComparableDebt = (
  report: MutationReport,
  baseline: MutationBaseline,
  profile: AssuranceProfile,
  today: string,
  comparison: ComparableMutationReport,
  reasons: ReasonCollector,
): void => {
  const currentDebt = new Map(
    report.mutations.flatMap((mutation) =>
      mutation.outcome === 'survived' || mutation.outcome === 'no_coverage'
        ? [[mutation.id, mutation] as const]
        : [],
    ),
  );
  const previousDebt = new Map(
    baseline.entries.map((entry) => [entry.id, entry]),
  );
  comparison.newDebtIds.forEach((id) => {
    const record = currentDebt.get(id);
    if (record !== undefined) {
      evaluateNewDebt(record, profile, today, reasons);
    }
  });
  if (comparison.survivedToNoCoverageIds.length > 0) {
    reasons.add(
      'survived_to_no_coverage_regression',
      comparison.survivedToNoCoverageIds,
    );
  }
  [
    ...comparison.unchangedDebtIds,
    ...comparison.survivedToNoCoverageIds,
    ...comparison.noCoverageToSurvivedIds,
  ].forEach((id) => {
    const current = currentDebt.get(id);
    const previous = previousDebt.get(id);
    if (current !== undefined && previous !== undefined) {
      evaluateExistingAcceptedRisk(current, previous, profile, today, reasons);
    }
  });
};

/**
 * Applies no-new-unexplained-debt policy. Every public input is bounded,
 * validated, and cloned before an eligibility or policy decision is made.
 */
export function evaluateMutationPolicy(
  request: EvaluateMutationPolicyRequest,
): MutationPolicyEvaluation;
export function evaluateMutationPolicy(
  request: unknown,
): MutationPolicyEvaluation {
  const inconclusive = new ReasonCollector();
  const envelope = readRequestEnvelope(
    request,
    ['report', 'baseline', 'profile', 'now'],
    ['report', 'profile', 'now'],
  );
  if (!envelope.success) {
    inconclusive.add('invalid_evaluation_request');
    return result('inconclusive', 'INVALID-REPORT', undefined, inconclusive);
  }

  const rawReport = envelope.data['report'];
  const rawBaseline = envelope.data['baseline'];
  const rawProfile = envelope.data['profile'];
  const reportId = artifactIdOrFallback(rawReport, 'INVALID-REPORT');
  const baselineId =
    rawBaseline === undefined
      ? undefined
      : artifactIdOrFallback(rawBaseline, 'INVALID-BASELINE');
  const reportResult = validateMutationReportInput(rawReport);
  if (!reportResult.success) {
    inconclusive.add(
      reportResult.kind === 'limit'
        ? 'current_report_input_limit_exceeded'
        : 'current_report_invalid',
    );
  }
  const profileResult = validateAssuranceProfileInput(rawProfile);
  if (!profileResult.success) {
    inconclusive.add(
      profileResult.kind === 'limit'
        ? 'policy_profile_input_limit_exceeded'
        : 'policy_profile_invalid',
    );
  }
  const baselineResult =
    rawBaseline === undefined
      ? undefined
      : validateMutationBaselineInput(rawBaseline);
  if (baselineResult !== undefined && !baselineResult.success) {
    inconclusive.add(
      baselineResult.kind === 'limit'
        ? 'baseline_input_limit_exceeded'
        : 'baseline_invalid',
    );
  }

  const rawNow = envelope.data['now'];
  let now: Date | undefined;
  if (rawNow instanceof Date) {
    try {
      const timestamp = Date.prototype.getTime.call(rawNow);
      if (!Number.isNaN(timestamp)) {
        now = new Date(timestamp);
      }
    } catch {
      // Report the same stable invalid-time reason as an invalid Date.
    }
  }
  if (now === undefined) {
    inconclusive.add('invalid_evaluation_time');
  }

  let boundaryComparison: MutationReportComparison | undefined;
  if (!reportResult.success && baselineResult?.success === true) {
    boundaryComparison = compareMutationReport(
      rawReport as MutationReport,
      baselineResult.data,
    );
    if (boundaryComparison.status === 'incomparable') {
      boundaryComparison.issues.forEach((comparisonIssue) => {
        inconclusive.add(comparisonIssue.code, comparisonIssue.mutationIds);
      });
    }
  }
  if (
    !reportResult.success ||
    !profileResult.success ||
    (baselineResult !== undefined && !baselineResult.success)
  ) {
    return result(
      'inconclusive',
      reportId,
      baselineId,
      inconclusive,
      boundaryComparison,
    );
  }

  const report = reportResult.data;
  const profile = profileResult.data;
  const baseline = baselineResult?.data;
  if (
    report.assurance_profile_ref !== profile.id ||
    report.project_ref !== profile.project_ref
  ) {
    inconclusive.add('policy_profile_mismatch');
  }
  collectCurrentEligibility(report, inconclusive);
  if (baseline === undefined) {
    inconclusive.add('baseline_missing');
    return result('inconclusive', report.id, undefined, inconclusive);
  }
  if (profile.mutation_policy.baseline.existing_survivors === 'not_available') {
    inconclusive.add('baseline_policy_not_available');
  }

  const comparison = compareMutationReport(report, baseline);
  if (comparison.status === 'incomparable') {
    comparison.issues.forEach((comparisonIssue) => {
      inconclusive.add(comparisonIssue.code, comparisonIssue.mutationIds);
    });
  }
  if (!inconclusive.empty || now === undefined) {
    return result(
      'inconclusive',
      report.id,
      baseline.id,
      inconclusive,
      comparison,
    );
  }
  if (comparison.status !== 'comparable') {
    return result(
      'inconclusive',
      report.id,
      baseline.id,
      inconclusive,
      comparison,
    );
  }

  const failures = new ReasonCollector();
  const today = now.toISOString().slice(0, 10);
  evaluateComparableDebt(
    report,
    baseline,
    profile,
    today,
    comparison,
    failures,
  );
  if (!failures.empty) {
    return result('failed', report.id, baseline.id, failures, comparison);
  }
  failures.add('mutation_policy_satisfied');
  return result('passed', report.id, baseline.id, failures, comparison);
}
