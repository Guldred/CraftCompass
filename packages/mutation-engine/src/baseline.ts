import {
  MutationBaselineSchema,
  type MutationBaseline,
  type MutationDebtRecord,
  type MutationReport,
} from '@craftcompass/domain';

import {
  readRequestEnvelope,
  validateArtifactIdInput,
  validateMutationReportInput,
  type RuntimeValidationIssue,
} from './input-validation.js';

/** Inputs for a deterministic, never-active baseline candidate. */
export interface CreateMutationBaselineRequest {
  readonly id: string;
  readonly report: MutationReport;
  readonly createdAt: Date;
}

export type MutationBaselineCreationErrorCode =
  | 'input_limit_exceeded'
  | 'invalid_baseline_candidate'
  | 'invalid_created_at'
  | 'invalid_report'
  | 'invalid_request';

/** Stable creation failure without exposing validation-library internals. */
export class MutationBaselineCreationError extends Error {
  constructor(
    readonly code: MutationBaselineCreationErrorCode,
    message: string,
    readonly issues: readonly RuntimeValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'MutationBaselineCreationError';
  }
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const formatPath = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? '$'
    : path.reduce<string>(
        (result, segment) =>
          typeof segment === 'number'
            ? `${result}[${segment}]`
            : `${result}.${String(segment)}`,
        '$',
      );

const createdAtSeconds = (createdAt: Date): string => {
  const timestamp = Date.prototype.getTime.call(createdAt);
  if (Number.isNaN(timestamp)) {
    throw new MutationBaselineCreationError(
      'invalid_created_at',
      'createdAt must be a valid date',
    );
  }
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/u, 'Z');
};

const debtRecords = (report: MutationReport): readonly MutationDebtRecord[] =>
  report.mutations
    .filter(
      (mutation): mutation is MutationDebtRecord =>
        mutation.outcome === 'survived' || mutation.outcome === 'no_coverage',
    )
    .sort((left, right) => compareText(left.id, right.id));

/**
 * Creates an inert candidate snapshot. Automatic creation never activates a
 * baseline or invents classifications, exceptions, or source-run facts.
 */
export function createMutationBaseline(
  request: CreateMutationBaselineRequest,
): MutationBaseline;
export function createMutationBaseline(request: unknown): MutationBaseline {
  const envelope = readRequestEnvelope(
    request,
    ['id', 'report', 'createdAt'],
    ['id', 'report', 'createdAt'],
  );
  if (!envelope.success) {
    throw new MutationBaselineCreationError(
      envelope.kind === 'limit' ? 'input_limit_exceeded' : 'invalid_request',
      'Mutation baseline creation request is invalid',
      envelope.issues,
    );
  }
  const parsedId = validateArtifactIdInput(envelope.data['id']);
  if (!parsedId.success) {
    throw new MutationBaselineCreationError(
      parsedId.kind === 'limit' ? 'input_limit_exceeded' : 'invalid_request',
      parsedId.kind === 'limit'
        ? 'Mutation baseline id exceeds an input resource limit'
        : 'Mutation baseline id must be a valid artifact ID',
      parsedId.issues,
    );
  }
  const reportResult = validateMutationReportInput(envelope.data['report']);
  if (!reportResult.success) {
    throw new MutationBaselineCreationError(
      reportResult.kind === 'limit' ? 'input_limit_exceeded' : 'invalid_report',
      reportResult.kind === 'limit'
        ? 'Mutation report exceeds an input resource limit'
        : 'Mutation report is invalid',
      reportResult.issues,
    );
  }
  const rawCreatedAt = envelope.data['createdAt'];
  if (!(rawCreatedAt instanceof Date)) {
    throw new MutationBaselineCreationError(
      'invalid_created_at',
      'createdAt must be a valid date',
    );
  }
  let createdAt: Date;
  try {
    createdAt = new Date(Date.prototype.getTime.call(rawCreatedAt));
  } catch {
    throw new MutationBaselineCreationError(
      'invalid_created_at',
      'createdAt must be a valid date',
    );
  }
  const report = reportResult.data;
  const candidate = {
    schema_version: 1,
    kind: 'mutation_baseline',
    id: parsedId.data,
    project_ref: report.project_ref,
    assurance_profile_ref: report.assurance_profile_ref,
    source_report_ref: report.id,
    status: 'candidate',
    provider: {
      ...report.provider,
    },
    scope: {
      primary_targets: [...report.scope.primary_targets],
      supporting_targets: [...report.scope.supporting_targets],
      relevant_tests: [...report.scope.relevant_tests],
      confidence: report.scope.confidence,
      limitations: [...report.scope.limitations],
    },
    source_run: {
      completeness: report.run.completeness,
      totals: {
        ...report.totals,
      },
      limitations: [...report.run.limitations],
    },
    entries: debtRecords(report),
    created_at: createdAtSeconds(createdAt),
  };
  const parsed = MutationBaselineSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MutationBaselineCreationError(
      'invalid_baseline_candidate',
      'Could not create a mutation baseline candidate',
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}
