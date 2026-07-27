import {
  MutationReportSchema,
  type AssurancePlan,
  type EvidenceReference,
  type MutationRecord,
  type MutationReport,
  type MutationScope,
} from '@craftcompass/domain';

import { isParsedPitRun } from './pit-run-provenance.js';
import type { PitMutation, PitMutationRun } from './types.js';

/** Stable normalization contract used in mutation-baseline comparability. */
export const PIT_NORMALIZATION_VERSION = 'pitest-xml-v1' as const;

/** Inputs supplied by the application layer when persisting a PIT result. */
export interface NormalizePitRunRequest {
  readonly reportId: string;
  readonly run: PitMutationRun;
  readonly plan: AssurancePlan;
  readonly capturedAt: Date;
  readonly toolVersion?: string;
  /**
   * Explicit evidence that the imported XML came from an execution configured
   * for this exact plan and scope. XML alone cannot prove that relationship.
   */
  readonly executionAttestation?: PitExecutionAttestation;
  /** Optional, explicit resolution from stable mutant ID to repository path. */
  readonly resolvedSourcePaths?: Readonly<Record<string, string>>;
}

/** Caller-supplied execution binding required before an import can pass. */
export interface PitExecutionAttestation {
  readonly assurancePlanRef: string;
  readonly scope: MutationScope;
  readonly configurationFingerprint: string;
  readonly evidence: EvidenceReference;
}

/** Stable adapter failure without leaking validation-library internals. */
export class PitMutationReportError extends Error {
  readonly issues: readonly {
    readonly path: string;
    readonly message: string;
  }[];

  constructor(
    message: string,
    issues: readonly {
      readonly path: string;
      readonly message: string;
    }[] = [],
  ) {
    super(message);
    this.name = 'PitMutationReportError';
    this.issues = issues;
  }
}

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

const capturedAtSeconds = (capturedAt: Date): string => {
  if (Number.isNaN(capturedAt.getTime())) {
    throw new PitMutationReportError('capturedAt must be a valid date');
  }
  return capturedAt.toISOString().replace(/\.\d{3}Z$/u, 'Z');
};

const toLocationSymbol = (mutation: PitMutation): string =>
  `${mutation.mutated_class}.${mutation.mutated_method}${mutation.method_descriptor}`;

const toDomainRecord = (
  mutation: PitMutation,
  evidence: EvidenceReference,
  resolvedSourcePath: string | undefined,
): MutationRecord => {
  const base = {
    id: mutation.id,
    provider_outcome: mutation.pit_status,
    operator: mutation.mutator,
    description: mutation.description,
    location: {
      provider_source: mutation.source_file,
      ...(resolvedSourcePath === undefined ? {} : { file: resolvedSourcePath }),
      symbol: toLocationSymbol(mutation),
      ...(mutation.line === 0 ? {} : { line: mutation.line }),
    },
    evidence: [evidence],
  };
  switch (mutation.outcome) {
    case 'killed':
      return {
        ...base,
        outcome: 'killed',
      };
    case 'survived':
      return {
        ...base,
        outcome: 'survived',
        classification: 'unknown',
        classification_status: 'unresolved',
        action: {
          required: true,
          category: 'investigate_survivor',
          reason: mutation.action.reason,
        },
      };
    case 'equivalent_candidate':
      return {
        ...base,
        outcome: 'survived',
        classification: 'equivalent',
        classification_status: 'candidate',
        explanation:
          'PIT reported an equivalent outcome; human confirmation is still required.',
        action: {
          required: true,
          category: 'review_equivalent_candidate',
          reason: mutation.action.reason,
        },
      };
    case 'no_coverage':
      return {
        ...base,
        outcome: 'no_coverage',
        classification: 'unknown',
        classification_status: 'unresolved',
        action: {
          required: true,
          category: 'add_test_coverage',
          reason: mutation.action.reason,
        },
      };
    case 'timed_out':
      return {
        ...base,
        outcome: 'timed_out',
        action: {
          required: true,
          category: 'investigate_timeout',
          reason: mutation.action.reason,
        },
      };
    case 'non_viable':
    case 'memory_error':
    case 'run_error':
      return {
        ...base,
        outcome: 'error',
        error_category: mutation.outcome,
        action: {
          required: true,
          category: 'investigate_provider_error',
          reason: mutation.action.reason,
        },
      };
  }
};

const totalsFor = (
  mutations: readonly MutationRecord[],
): MutationReport['totals'] => {
  const count = (outcome: MutationRecord['outcome']): number =>
    mutations.filter((mutation) => mutation.outcome === outcome).length;
  return {
    generated: mutations.length,
    killed: count('killed'),
    survived: count('survived'),
    no_coverage: count('no_coverage'),
    timed_out: count('timed_out'),
    errors: count('error'),
  };
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalScope = (scope: MutationScope): string =>
  JSON.stringify({
    primary_targets: [...scope.primary_targets].sort(compareText),
    supporting_targets: [...scope.supporting_targets].sort(compareText),
    relevant_tests: [...scope.relevant_tests].sort(compareText),
    confidence: scope.confidence,
    limitations: [...scope.limitations].sort(compareText),
  });

const validateExecutionAttestation = (
  request: NormalizePitRunRequest,
  run: PitMutationRun,
): PitExecutionAttestation | undefined => {
  const attestation = request.executionAttestation;
  if (attestation === undefined) {
    return undefined;
  }
  if (attestation.assurancePlanRef !== request.plan.id) {
    throw new PitMutationReportError(
      `PIT execution attestation references ${attestation.assurancePlanRef}, not assurance plan ${request.plan.id}`,
    );
  }
  if (
    request.plan.mutation_scope === undefined ||
    canonicalScope(attestation.scope) !==
      canonicalScope(request.plan.mutation_scope)
  ) {
    throw new PitMutationReportError(
      'PIT execution attestation scope does not match the assurance plan',
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(attestation.configurationFingerprint)) {
    throw new PitMutationReportError(
      'PIT execution attestation requires a lowercase sha256 configuration fingerprint',
    );
  }
  if (
    attestation.evidence.type !== 'build_configuration' ||
    attestation.evidence.provider !== 'pitest'
  ) {
    throw new PitMutationReportError(
      'PIT execution attestation requires build-configuration evidence identified as pitest provenance',
    );
  }
  const allowedTargets = new Set([
    ...attestation.scope.primary_targets,
    ...attestation.scope.supporting_targets,
  ]);
  const outsideTargets = [
    ...new Set(
      run.mutations
        .map((mutation) => mutation.mutated_class)
        .filter((target) => !allowedTargets.has(target)),
    ),
  ].sort(compareText);
  if (outsideTargets.length > 0) {
    throw new PitMutationReportError(
      `PIT report contains mutation target(s) outside the attested scope: ${outsideTargets.join(', ')}`,
    );
  }
  return attestation;
};

/**
 * Maps a strict PIT parse result into the provider-independent domain report.
 *
 * Tool-reported equivalent mutations remain candidates. Partial reports,
 * timeouts, and tool failures stay explicit and can never become a silent pass.
 */
export const normalizePitMutationRun = (
  request: NormalizePitRunRequest,
): MutationReport => {
  const run = request.run;
  if (!isParsedPitRun(run)) {
    throw new PitMutationReportError(
      'PIT run must be the immutable result returned directly by parsePitXml',
    );
  }
  if (request.plan.mutation_scope === undefined) {
    throw new PitMutationReportError(
      `Assurance plan ${request.plan.id} has no mutation scope`,
    );
  }
  const attestation = validateExecutionAttestation(request, run);
  const capturedAt = capturedAtSeconds(request.capturedAt);
  const reportReference: EvidenceReference = {
    id: `EV:${run.id}`,
    type: 'test_result',
    description: 'Strictly normalized PIT mutations.xml report.',
    location: run.origin,
    captured_at: capturedAt,
    provider: 'pitest',
  };
  const knownMutationIds = new Set(
    run.mutations.map((mutation) => mutation.id),
  );
  const unknownResolutionIds = Object.keys(request.resolvedSourcePaths ?? {})
    .filter((id) => !knownMutationIds.has(id))
    .sort(compareText);
  if (unknownResolutionIds.length > 0) {
    throw new PitMutationReportError(
      `Resolved source paths reference unknown mutation ID(s): ${unknownResolutionIds.join(', ')}`,
    );
  }
  const mutations = run.mutations.map((mutation) =>
    toDomainRecord(
      mutation,
      reportReference,
      request.resolvedSourcePaths?.[mutation.id],
    ),
  );
  const totals = totalsFor(mutations);
  const limitations = [
    ...(run.partial
      ? [
          'PIT marked the imported mutations.xml report as partial; it cannot authorize a mutation gate.',
        ]
      : []),
    ...(attestation === undefined
      ? [
          'The imported mutations.xml report has no execution attestation binding it to the assurance-plan scope.',
        ]
      : []),
  ];
  const completeness =
    limitations.length === 0 ? ('complete' as const) : ('partial' as const);
  const conditional =
    completeness === 'partial' ||
    request.toolVersion === undefined ||
    totals.generated === 0 ||
    totals.survived > 0 ||
    totals.no_coverage > 0 ||
    totals.timed_out > 0 ||
    totals.errors > 0;
  const candidate = {
    schema_version: 1,
    kind: 'mutation_report',
    id: request.reportId,
    project_ref: request.plan.project_ref,
    assurance_profile_ref: request.plan.assurance_profile_ref,
    assurance_plan_ref: request.plan.id,
    provider: {
      id: 'pitest',
      ...(request.toolVersion === undefined
        ? {}
        : { tool_version: request.toolVersion }),
      normalization_version: PIT_NORMALIZATION_VERSION,
      ...(attestation === undefined
        ? {}
        : {
            configuration_fingerprint: attestation.configurationFingerprint,
          }),
    },
    provider_run_id: run.id,
    run: {
      completeness,
      limitations,
    },
    scope: request.plan.mutation_scope,
    totals,
    mutations,
    evidence: [
      {
        id: `ASSURANCE:${run.id}`,
        type: 'mutation_run',
        status: conditional ? 'conditional' : 'passed',
        summary: conditional
          ? totals.generated === 0
            ? 'PIT produced zero mutation records; the run is inconclusive.'
            : 'The PIT run requires mutation-debt, provider-outcome, or execution-scope review.'
          : 'Every imported PIT mutation was killed by a selected test.',
        captured_at: capturedAt,
        references:
          attestation === undefined
            ? [reportReference]
            : [reportReference, attestation.evidence],
        execution: {
          tool: 'pitest',
          run_id: run.id,
          ...(request.toolVersion === undefined
            ? {}
            : { version: request.toolVersion }),
          ...(attestation === undefined
            ? {}
            : {
                invocation: attestation.configurationFingerprint,
                configuration_evidence_ref: attestation.evidence.id,
              }),
        },
      },
    ],
  };
  const parsed = MutationReportSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PitMutationReportError(
      'Could not normalize PIT results into a mutation report',
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
};
