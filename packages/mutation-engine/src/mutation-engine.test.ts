import {
  AssurancePlanSchema,
  AssuranceProfileSchema,
  MutationBaselineSchema,
  MutationDebtRecordSchema,
  MutationRecordSchema,
  MutationReportSchema,
  ProjectProfileSchema,
  createArtifactRegistry,
  type AssuranceProfile,
  type EvidenceReference,
  type LocatedArtifact,
  type MutationBaseline,
  type MutationClassification,
  type MutationDebtRecord,
  type MutationRecord,
  type MutationReport,
} from '@craftcompass/domain';
import { describe, expect, it } from 'vitest';

import {
  MutationBaselineCreationError,
  createMutationBaseline,
} from './baseline.js';
import {
  compareMutationReport,
  type MutationComparisonIssueCode,
  type MutationReportComparison,
} from './comparison.js';
import { MAX_MUTATION_ENGINE_RECORDS } from './input-validation.js';
import {
  evaluateMutationPolicy,
  type MutationPolicyEvaluation,
} from './policy.js';
import { evaluateMutationPolicy as evaluateRegisteredMutationPolicy } from './registered-policy.js';

const sourceEvidence = (id: string): EvidenceReference => ({
  id: `EV-SOURCE-${id}`,
  type: 'test_result' as const,
  description: `Normalized result for ${id}.`,
  location: `provider-run:${id}`,
  provider: 'pitest',
});

const humanEvidence = (id: string): EvidenceReference => ({
  id: `EV-HUMAN-${id}`,
  type: 'human_decision' as const,
  description: `Human classification for ${id}.`,
  location: `decision:${id}`,
});

interface DebtOptions {
  readonly id: string;
  readonly outcome?: 'survived' | 'no_coverage';
  readonly classification?: MutationClassification;
  readonly status?:
    'unresolved' | 'candidate' | 'confirmed' | 'accepted_exception';
  readonly exceptionRef?: string;
  readonly humanDecision?: boolean;
}

const debt = ({
  id,
  outcome = 'survived',
  classification = 'unknown',
  status = classification === 'unknown'
    ? 'unresolved'
    : classification === 'accepted_risk'
      ? 'accepted_exception'
      : 'confirmed',
  exceptionRef,
  humanDecision = status === 'confirmed' || status === 'accepted_exception',
}: DebtOptions): MutationDebtRecord =>
  MutationDebtRecordSchema.parse({
    id,
    provider_outcome: outcome === 'no_coverage' ? 'NO_COVERAGE' : 'SURVIVED',
    operator: 'example.Mutator',
    description: `Mutation ${id}.`,
    location: {
      provider_source: 'Example.java',
      file: 'src/main/java/example/Example.java',
      symbol: 'example.Example.run',
      line: 12,
    },
    evidence: [
      sourceEvidence(id),
      ...(humanDecision ? [humanEvidence(id)] : []),
    ],
    outcome,
    classification,
    classification_status: status,
    ...(exceptionRef === undefined ? {} : { exception_ref: exceptionRef }),
    action: {
      required: true,
      category:
        outcome === 'no_coverage'
          ? 'add_test_coverage'
          : classification === 'equivalent' && status === 'candidate'
            ? 'review_equivalent_candidate'
            : 'investigate_survivor',
      reason: `Follow up ${id}.`,
    },
  });

const killed = (id: string): MutationRecord =>
  MutationRecordSchema.parse({
    id,
    provider_outcome: 'KILLED',
    operator: 'example.Mutator',
    description: `Mutation ${id}.`,
    location: {
      provider_source: 'Example.java',
      file: 'src/main/java/example/Example.java',
      symbol: 'example.Example.run',
      line: 12,
    },
    evidence: [sourceEvidence(id)],
    outcome: 'killed',
  });

const timedOut = (id: string): MutationRecord =>
  MutationRecordSchema.parse({
    id,
    provider_outcome: 'TIMED_OUT',
    operator: 'example.Mutator',
    description: `Timed-out mutation ${id}.`,
    location: {
      provider_source: 'Example.java',
      line: 0,
    },
    evidence: [sourceEvidence(id)],
    outcome: 'timed_out',
    action: {
      required: true,
      category: 'investigate_timeout',
      reason: `Investigate timeout ${id}.`,
    },
  });

const providerError = (id: string): MutationRecord =>
  MutationRecordSchema.parse({
    id,
    provider_outcome: 'RUN_ERROR',
    operator: 'example.Mutator',
    description: `Provider error ${id}.`,
    location: {
      provider_source: 'Example.java',
    },
    evidence: [sourceEvidence(id)],
    outcome: 'error',
    error_category: 'run_error',
    action: {
      required: true,
      category: 'investigate_provider_error',
      reason: `Investigate error ${id}.`,
    },
  });

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const totalsFor = (
  records: readonly MutationRecord[],
): MutationReport['totals'] => {
  const count = (outcome: MutationRecord['outcome']): number =>
    records.filter((record) => record.outcome === outcome).length;
  return {
    generated: records.length,
    killed: count('killed'),
    survived: count('survived'),
    no_coverage: count('no_coverage'),
    timed_out: count('timed_out'),
    errors: count('error'),
  };
};

interface ReportOptions {
  readonly id?: string;
  readonly projectRef?: string;
  readonly profileRef?: string;
  readonly records?: readonly MutationRecord[];
  readonly completeness?: 'complete' | 'partial';
  readonly providerId?: string;
  readonly toolVersion?: string | null;
  readonly normalizationVersion?: string;
  readonly configurationFingerprint?: string | null;
  readonly primaryTargets?: readonly string[];
  readonly supportingTargets?: readonly string[];
  readonly relevantTests?: readonly string[];
  readonly confidence?: number;
  readonly limitations?: readonly string[];
}

const reportFor = ({
  id = 'REPORT-CURRENT',
  projectRef = 'PROJECT-MUTATION',
  profileRef = 'PROFILE-MUTATION',
  records = [killed('M-KILLED')],
  completeness = 'complete',
  providerId = 'pitest',
  toolVersion = '1.25.3',
  normalizationVersion = 'pitest-xml-v1',
  configurationFingerprint = `sha256:${'a'.repeat(64)}`,
  primaryTargets = ['example.Order', 'example.OrderService'],
  supportingTargets = ['example.OrderRepository'],
  relevantTests = ['example.OrderServiceTest', 'example.OrderTest'],
  confidence = 0.9,
  limitations = [],
}: ReportOptions = {}): MutationReport => {
  const orderedRecords = [...records].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const reportReference = {
    id: `EV-REPORT-${id}`,
    type: 'test_result' as const,
    description: `Mutation report ${id}.`,
    location: `provider-run:${id}`,
    provider: providerId,
  };
  const configurationReference =
    configurationFingerprint === null
      ? undefined
      : {
          id: `EV-CONFIGURATION-${id}`,
          type: 'build_configuration' as const,
          description: `Mutation configuration for ${id}.`,
          location: `provider-configuration:${id}`,
          provider: providerId,
        };
  const allKilled =
    completeness === 'complete' &&
    orderedRecords.length > 0 &&
    orderedRecords.every((record) => record.outcome === 'killed') &&
    toolVersion !== null &&
    configurationFingerprint !== null;
  return MutationReportSchema.parse({
    schema_version: 1,
    kind: 'mutation_report',
    id,
    project_ref: projectRef,
    assurance_profile_ref: profileRef,
    assurance_plan_ref: 'PLAN-MUTATION',
    provider: {
      id: providerId,
      ...(toolVersion === null ? {} : { tool_version: toolVersion }),
      normalization_version: normalizationVersion,
      ...(configurationFingerprint === null
        ? {}
        : { configuration_fingerprint: configurationFingerprint }),
    },
    provider_run_id: `RUN-${id}`,
    run: {
      completeness,
      limitations:
        completeness === 'partial'
          ? ['Provider marked the run as partial.']
          : [],
    },
    scope: {
      primary_targets: primaryTargets,
      supporting_targets: supportingTargets,
      relevant_tests: relevantTests,
      confidence,
      limitations,
    },
    totals: totalsFor(orderedRecords),
    mutations: orderedRecords,
    evidence: [
      {
        id: `ASSURANCE-${id}`,
        type: 'mutation_run',
        status: allKilled ? 'passed' : 'conditional',
        summary: `Imported report ${id}.`,
        captured_at: '2026-07-27T12:00:00Z',
        references:
          configurationReference === undefined
            ? [reportReference]
            : [reportReference, configurationReference],
        execution: {
          tool: providerId,
          ...(toolVersion === null ? {} : { version: toolVersion }),
          ...(configurationFingerprint === null
            ? {}
            : {
                invocation: configurationFingerprint,
                configuration_evidence_ref: configurationReference?.id,
              }),
          run_id: `RUN-${id}`,
        },
      },
    ],
  });
};

interface ExceptionOptions {
  readonly id: string;
  readonly expiresOn: string;
  readonly mutationIds?: readonly string[];
}

interface ProfileOptions {
  readonly id?: string;
  readonly projectRef?: string;
  readonly exceptions?: readonly ExceptionOptions[];
  readonly exceptionsAllowed?: boolean;
  readonly reportScore?: boolean | null;
  readonly existingSurvivors?: 'classify_and_track' | 'not_available';
}

const profileFor = ({
  id = 'PROFILE-MUTATION',
  projectRef = 'PROJECT-MUTATION',
  exceptions = [],
  exceptionsAllowed = true,
  reportScore = true,
  existingSurvivors = 'classify_and_track',
}: ProfileOptions = {}): AssuranceProfile =>
  AssuranceProfileSchema.parse({
    schema_version: 1,
    kind: 'assurance_profile',
    id,
    project_ref: projectRef,
    project_criticality: 'high',
    agent_generated_code_share: 'high',
    review_policy: {
      default_level: 1,
      always_review: ['Business intent.'],
      selective_review: [],
    },
    testing_policy: {
      unit_tests_required: true,
      acceptance_tests_required_for: ['Business behavior.'],
      integration_tests_required_for: [],
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
        existing_survivors: existingSurvivors,
        regression: 'forbidden',
      },
      ...(reportScore === null
        ? {}
        : {
            score: {
              report: reportScore,
              decision_role: 'context_only',
            },
          }),
    },
    security_policy: {
      dependency_scanning_required: true,
      human_review_required_for: [],
    },
    exception_policy: {
      allowed: exceptionsAllowed,
      reason_required: true,
      owner_required: true,
      expiration_required: true,
      active_exceptions: exceptions.map((exception) => ({
        id: exception.id,
        reason: `Accepted mutation risk ${exception.id}.`,
        owner: 'platform-team',
        scope: `Mutation ${exception.id} only.`,
        ...(exception.mutationIds === undefined
          ? {}
          : {
              applies_to: {
                artifact_refs: [],
                mutation_ids: exception.mutationIds,
              },
            }),
        expires_on: exception.expiresOn,
        evidence: [humanEvidence(`EXCEPTION-${exception.id}`)],
      })),
    },
  });

const candidateBaseline = (
  sourceReport: MutationReport,
  id = 'BASELINE-MUTATION',
): MutationBaseline =>
  createMutationBaseline({
    id,
    report: sourceReport,
    createdAt: new Date('2026-07-27T12:34:56.789Z'),
  });

const activeBaseline = (
  sourceReport: MutationReport,
  id = 'BASELINE-MUTATION',
): MutationBaseline => {
  const candidate = candidateBaseline(sourceReport, id);
  return MutationBaselineSchema.parse({
    ...candidate,
    status: 'active',
    activation: {
      owner: 'platform-team',
      reviewed_on: '2026-07-27',
      decision_ref: `EV-ACTIVATE-${id}`,
      evidence: [
        {
          id: `EV-ACTIVATE-${id}`,
          type: 'human_decision',
          description: `Activate ${id}.`,
          location: `decision:${id}`,
        },
      ],
    },
  });
};

const expectIssue = (
  comparison: MutationReportComparison,
  code: MutationComparisonIssueCode,
  mutationIds: readonly string[] = [],
): void => {
  expect(comparison.status).toBe('incomparable');
  if (comparison.status !== 'incomparable') {
    return;
  }
  expect(comparison.issues).toContainEqual({
    code,
    mutationIds,
  });
};

interface CompatibilityChange {
  readonly project_ref?: string;
  readonly assurance_profile_ref?: string;
  readonly provider?: Readonly<{
    id?: string;
    tool_version?: string;
    normalization_version?: string;
    configuration_fingerprint?: string;
  }>;
  readonly scope?: Readonly<{
    primary_targets?: readonly string[];
    supporting_targets?: readonly string[];
    relevant_tests?: readonly string[];
    confidence?: number;
    limitations?: readonly string[];
  }>;
}

const compatibilityCases: readonly (readonly [
  MutationComparisonIssueCode,
  CompatibilityChange,
])[] = [
  ['project_mismatch', { project_ref: 'PROJECT-OTHER' }],
  ['assurance_profile_mismatch', { assurance_profile_ref: 'PROFILE-OTHER' }],
  ['provider_id_mismatch', { provider: { id: 'other' } }],
  [
    'normalization_version_mismatch',
    { provider: { normalization_version: 'other-v1' } },
  ],
  ['provider_tool_version_mismatch', { provider: { tool_version: '2.0.0' } }],
  [
    'configuration_fingerprint_mismatch',
    {
      provider: {
        configuration_fingerprint: `sha256:${'b'.repeat(64)}`,
      },
    },
  ],
  [
    'primary_targets_mismatch',
    { scope: { primary_targets: ['different.Target'] } },
  ],
  [
    'supporting_targets_mismatch',
    { scope: { supporting_targets: ['different.Support'] } },
  ],
  [
    'relevant_tests_mismatch',
    { scope: { relevant_tests: ['different.Test'] } },
  ],
  ['scope_confidence_mismatch', { scope: { confidence: 0.4 } }],
  [
    'scope_limitations_mismatch',
    { scope: { limitations: ['A material limitation.'] } },
  ],
];

describe('createMutationBaseline', () => {
  it('creates an inert candidate with exact provider, scope, source run, and debt records', () => {
    const report = reportFor({
      id: 'REPORT-BASELINE-SOURCE',
      completeness: 'partial',
      records: [
        debt({ id: 'M-SURVIVED' }),
        killed('M-KILLED'),
        debt({ id: 'M-NO-COVERAGE', outcome: 'no_coverage' }),
        timedOut('M-TIMEOUT'),
        providerError('M-ERROR'),
      ],
      limitations: ['Dynamic target resolution is incomplete.'],
    });
    const before = JSON.stringify(report);

    const baseline = createMutationBaseline({
      id: 'BASELINE-CANDIDATE',
      report,
      createdAt: new Date('2026-07-27T12:34:56.789Z'),
    });

    expect(baseline).toEqual({
      schema_version: 1,
      kind: 'mutation_baseline',
      id: 'BASELINE-CANDIDATE',
      project_ref: report.project_ref,
      assurance_profile_ref: report.assurance_profile_ref,
      source_report_ref: report.id,
      status: 'candidate',
      provider: report.provider,
      scope: report.scope,
      source_run: {
        completeness: report.run.completeness,
        totals: report.totals,
        limitations: report.run.limitations,
      },
      entries: report.mutations.filter(
        (record) =>
          record.outcome === 'survived' || record.outcome === 'no_coverage',
      ),
      created_at: '2026-07-27T12:34:56Z',
    });
    expect(baseline.activation).toBeUndefined();
    expect(baseline.superseded_by).toBeUndefined();
    expect(baseline.entries[0]).not.toBe(
      report.mutations.find((record) => record.id === baseline.entries[0]?.id),
    );
    expect(JSON.stringify(report)).toBe(before);
  });

  it('never activates even an eligible source report', () => {
    const baseline = candidateBaseline(
      reportFor({ records: [killed('M-KILLED')] }),
    );

    expect(baseline.status).toBe('candidate');
    expect(baseline.activation).toBeUndefined();
  });

  it('rejects an invalid creation time with a stable error', () => {
    try {
      createMutationBaseline({
        id: 'BASELINE-BAD-TIME',
        report: reportFor(),
        createdAt: new Date(Number.NaN),
      });
      expect.unreachable('Expected invalid createdAt to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MutationBaselineCreationError);
      expect(error).toMatchObject({ code: 'invalid_created_at' });
    }
  });

  it('rejects invalid and oversized unknown reports with stable errors', () => {
    const valid = reportFor();
    const invalid = {
      ...valid,
      mutations: [
        {
          ...valid.mutations[0],
          outcome: 'mysteriously_green',
        },
      ],
    };
    expect(() =>
      createMutationBaseline({
        id: 'BASELINE-INVALID-REPORT',
        report: invalid as unknown as MutationReport,
        createdAt: new Date('2026-07-27T12:00:00Z'),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_report',
      }),
    );

    const oversized = {
      ...valid,
      mutations: new Array<unknown>(MAX_MUTATION_ENGINE_RECORDS + 1),
    };
    expect(() =>
      createMutationBaseline({
        id: 'BASELINE-OVERSIZED-REPORT',
        report: oversized as unknown as MutationReport,
        createdAt: new Date('2026-07-27T12:00:00Z'),
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'input_limit_exceeded',
      }),
    );
  });
});

describe('compareMutationReport', () => {
  it('calculates sorted new, unchanged, resolved, and outcome-transition IDs', () => {
    const source = reportFor({
      id: 'REPORT-BASELINE',
      records: [
        debt({ id: 'M-A' }),
        debt({ id: 'M-B', outcome: 'no_coverage' }),
        debt({ id: 'M-C' }),
        debt({ id: 'M-D', outcome: 'no_coverage' }),
        killed('M-K'),
      ],
    });
    const baseline = activeBaseline(source);
    const current = reportFor({
      records: [
        debt({ id: 'M-E' }),
        debt({ id: 'M-C', outcome: 'no_coverage' }),
        killed('M-D'),
        debt({ id: 'M-B' }),
        debt({ id: 'M-A' }),
        killed('M-K'),
      ],
    });

    expect(compareMutationReport(current, baseline)).toEqual({
      status: 'comparable',
      reportId: current.id,
      baselineId: baseline.id,
      newDebtIds: ['M-E'],
      unchangedDebtIds: ['M-A'],
      resolvedDebtIds: ['M-D'],
      survivedToNoCoverageIds: ['M-C'],
      noCoverageToSurvivedIds: ['M-B'],
    });
  });

  it('canonicalizes exact target, test, and limitation sets', () => {
    const source = reportFor({
      records: [killed('M-KILLED')],
      primaryTargets: ['target.B', 'target.A'],
      supportingTargets: ['support.B', 'support.A'],
      relevantTests: ['test.B', 'test.A'],
      confidence: 0.8,
      limitations: ['Known B.', 'Known A.'],
    });
    const current = reportFor({
      records: [killed('M-KILLED')],
      primaryTargets: ['target.A', 'target.B'],
      supportingTargets: ['support.A', 'support.B'],
      relevantTests: ['test.A', 'test.B'],
      confidence: 0.8,
      limitations: ['Known A.', 'Known B.'],
    });

    expect(compareMutationReport(current, activeBaseline(source)).status).toBe(
      'comparable',
    );
  });

  it.each(compatibilityCases)(
    'reports %s as an exact compatibility failure',
    (expectedCode, change) => {
      const source = reportFor({ records: [killed('M-KILLED')] });
      const baseline = activeBaseline(source);
      const current = reportFor({
        records: [killed('M-KILLED')],
        ...(change.project_ref === undefined
          ? {}
          : { projectRef: change.project_ref }),
        ...(change.assurance_profile_ref === undefined
          ? {}
          : { profileRef: change.assurance_profile_ref }),
        ...(change.provider?.id === undefined
          ? {}
          : { providerId: change.provider.id }),
        ...(change.provider?.tool_version === undefined
          ? {}
          : { toolVersion: change.provider.tool_version }),
        ...(change.provider?.normalization_version === undefined
          ? {}
          : {
              normalizationVersion: change.provider.normalization_version,
            }),
        ...(change.provider?.configuration_fingerprint === undefined
          ? {}
          : {
              configurationFingerprint:
                change.provider.configuration_fingerprint,
            }),
        ...(change.scope?.primary_targets === undefined
          ? {}
          : { primaryTargets: change.scope.primary_targets }),
        ...(change.scope?.supporting_targets === undefined
          ? {}
          : { supportingTargets: change.scope.supporting_targets }),
        ...(change.scope?.relevant_tests === undefined
          ? {}
          : { relevantTests: change.scope.relevant_tests }),
        ...(change.scope?.confidence === undefined
          ? {}
          : { confidence: change.scope.confidence }),
        ...(change.scope?.limitations === undefined
          ? {}
          : { limitations: change.scope.limitations }),
      });

      expectIssue(compareMutationReport(current, baseline), expectedCode);
    },
  );

  it('requires exact tool versions on both sides', () => {
    const source = reportFor({ records: [killed('M-KILLED')] });
    const active = activeBaseline(source);
    const missingCurrentVersion = reportFor({
      records: [killed('M-KILLED')],
      toolVersion: null,
    });
    expectIssue(
      compareMutationReport(missingCurrentVersion, active),
      'current_tool_version_missing',
    );
    expectIssue(
      compareMutationReport(missingCurrentVersion, active),
      'provider_tool_version_mismatch',
    );

    const missingBaselineVersion = {
      ...active,
      provider: {
        id: active.provider.id,
        normalization_version: active.provider.normalization_version,
      },
    } as MutationBaseline;
    expectIssue(
      compareMutationReport(reportFor(), missingBaselineVersion),
      'baseline_invalid',
    );
  });

  it('requires an exact configuration fingerprint on both sides', () => {
    const source = reportFor({ records: [killed('M-KILLED')] });
    const active = activeBaseline(source);
    const missingCurrentFingerprint = reportFor({
      records: [killed('M-KILLED')],
      configurationFingerprint: null,
    });
    expectIssue(
      compareMutationReport(missingCurrentFingerprint, active),
      'current_configuration_fingerprint_missing',
    );
    expectIssue(
      compareMutationReport(missingCurrentFingerprint, active),
      'configuration_fingerprint_mismatch',
    );

    const missingBaselineFingerprint = {
      ...active,
      provider: {
        id: active.provider.id,
        tool_version: active.provider.tool_version,
        normalization_version: active.provider.normalization_version,
      },
    } as MutationBaseline;
    expectIssue(
      compareMutationReport(reportFor(), missingBaselineFingerprint),
      'baseline_invalid',
    );
  });

  it('rejects candidate and superseded baselines explicitly', () => {
    const source = reportFor({ records: [killed('M-KILLED')] });
    const candidate = candidateBaseline(source);
    expectIssue(
      compareMutationReport(reportFor(), candidate),
      'baseline_candidate',
    );

    const superseded = {
      ...candidate,
      status: 'superseded',
      superseded_by: 'BASELINE-NEXT',
    } as MutationBaseline;
    expectIssue(
      compareMutationReport(reportFor(), superseded),
      'baseline_superseded',
    );
  });

  it('rejects report totals that do not match the validated records', () => {
    const source = reportFor({ records: [killed('M-KILLED')] });
    const baseline = activeBaseline(source);
    const validCurrent = reportFor({ records: [killed('M-KILLED')] });
    const forgedTotals = {
      ...validCurrent,
      totals: {
        generated: 0,
        killed: 0,
        survived: 0,
        no_coverage: 0,
        timed_out: 99,
        errors: 99,
      },
    };

    expectIssue(
      compareMutationReport(forgedTotals, baseline),
      'current_report_invalid',
    );
  });

  it('rejects partial, empty, timed-out, and provider-error current records', () => {
    const baseline = activeBaseline(
      reportFor({ records: [killed('M-KILLED')] }),
    );
    expectIssue(
      compareMutationReport(
        reportFor({
          completeness: 'partial',
          records: [killed('M-KILLED')],
        }),
        baseline,
      ),
      'current_run_partial',
    );
    expectIssue(
      compareMutationReport(reportFor({ records: [] }), baseline),
      'current_run_zero_generated',
    );
    expectIssue(
      compareMutationReport(
        reportFor({ records: [killed('M-KILLED'), timedOut('M-TIME')] }),
        baseline,
      ),
      'current_run_timed_out',
      ['M-TIME'],
    );
    expectIssue(
      compareMutationReport(
        reportFor({
          records: [providerError('M-ERROR'), killed('M-KILLED')],
        }),
        baseline,
      ),
      'current_run_errors',
      ['M-ERROR'],
    );
  });

  it('rejects ineligible active-baseline source metadata defensively', () => {
    const baseline = activeBaseline(
      reportFor({ records: [killed('M-KILLED')] }),
    );
    const forged = {
      ...baseline,
      source_run: {
        completeness: 'partial',
        limitations: ['Forged partial source.'],
        totals: {
          generated: 0,
          killed: 0,
          survived: 0,
          no_coverage: 0,
          timed_out: 1,
          errors: 1,
        },
      },
    } as MutationBaseline;
    const comparison = compareMutationReport(reportFor(), forged);

    expectIssue(comparison, 'baseline_invalid');
  });

  it('returns stable incomparable results for malformed and oversized unknown inputs', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const valid = reportFor({ records: [killed('M-KILLED')] });
    const first = valid.mutations[0];
    expect(first).toBeDefined();
    const malformed = {
      ...valid,
      mutations: [
        {
          ...first,
          outcome: 'mysteriously_green',
        },
      ],
    } as unknown as MutationReport;
    expectIssue(
      compareMutationReport(malformed, baseline),
      'current_report_invalid',
    );

    const oversizedReport = {
      ...valid,
      mutations: new Array<unknown>(MAX_MUTATION_ENGINE_RECORDS + 1),
    } as unknown as MutationReport;
    expectIssue(
      compareMutationReport(oversizedReport, baseline),
      'current_report_input_limit_exceeded',
    );

    const oversizedBaseline = {
      ...baseline,
      entries: new Array<unknown>(MAX_MUTATION_ENGINE_RECORDS + 1),
    } as unknown as MutationBaseline;
    expectIssue(
      compareMutationReport(valid, oversizedBaseline),
      'baseline_input_limit_exceeded',
    );
  });

  it('requires exactly one mutation-run evidence record', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const valid = reportFor({ records: [killed('M-KILLED')] });
    expectIssue(
      compareMutationReport(
        {
          ...valid,
          evidence: [],
        },
        baseline,
      ),
      'current_execution_evidence_missing',
    );
    const runEvidence = valid.evidence[0];
    expect(runEvidence).toBeDefined();
    expectIssue(
      compareMutationReport(
        {
          ...valid,
          evidence: [
            runEvidence,
            {
              ...runEvidence,
              id: 'ASSURANCE-DUPLICATE-RUN',
            },
          ],
        } as MutationReport,
        baseline,
      ),
      'current_execution_evidence_ambiguous',
    );
  });

  it.each([
    [
      'current_execution_evidence_provider_mismatch',
      { tool: 'other-provider' },
    ],
    [
      'current_execution_evidence_tool_version_mismatch',
      { version: '999.0.0' },
    ],
    [
      'current_execution_evidence_configuration_mismatch',
      { invocation: `sha256:${'c'.repeat(64)}` },
    ],
    ['current_execution_evidence_run_id_mismatch', { run_id: 'RUN-OTHER' }],
  ] as const)(
    'reports %s for execution evidence that is not bound to its report',
    (expectedCode, executionChange) => {
      const baseline = activeBaseline(
        reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
      );
      const valid = reportFor({ records: [killed('M-KILLED')] });
      const runEvidence = valid.evidence[0];
      expect(runEvidence).toBeDefined();
      const forged = {
        ...valid,
        evidence: [
          {
            ...runEvidence,
            execution: {
              ...runEvidence?.execution,
              ...executionChange,
            },
          },
        ],
      } as MutationReport;

      expectIssue(compareMutationReport(forged, baseline), expectedCode);
      expectIssue(
        compareMutationReport(forged, baseline),
        'current_report_invalid',
      );
    },
  );

  it('rejects decision-ineligible mutation-run evidence status', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const valid = reportFor({ records: [killed('M-KILLED')] });
    const runEvidence = valid.evidence[0];
    expect(runEvidence).toBeDefined();
    const informational = {
      ...valid,
      evidence: [
        {
          ...runEvidence,
          status: 'informational',
        },
      ],
    } as MutationReport;

    expectIssue(
      compareMutationReport(informational, baseline),
      'current_execution_evidence_status_mismatch',
    );
  });

  it.each([
    [
      'operator',
      (record: MutationDebtRecord): MutationDebtRecord =>
        MutationDebtRecordSchema.parse({
          ...record,
          operator: 'other.Mutator',
        }),
    ],
    [
      'description',
      (record: MutationDebtRecord): MutationDebtRecord =>
        MutationDebtRecordSchema.parse({
          ...record,
          description: 'A different mutation identity.',
        }),
    ],
    [
      'location',
      (record: MutationDebtRecord): MutationDebtRecord =>
        MutationDebtRecordSchema.parse({
          ...record,
          location: {
            ...record.location,
            line: 99,
          },
        }),
    ],
    [
      'provider outcome',
      (record: MutationDebtRecord): MutationDebtRecord =>
        MutationDebtRecordSchema.parse({
          ...record,
          provider_outcome: 'SURVIVED-BUT-DIFFERENT',
        }),
    ],
  ] as const)(
    'treats a stable mutation ID with changed %s as incomparable',
    (_field, changeRecord) => {
      const sourceRecord = debt({ id: 'M-STABLE-ID' });
      const baseline = activeBaseline(
        reportFor({
          id: 'REPORT-BASE',
          records: [sourceRecord],
        }),
      );
      const current = reportFor({
        records: [changeRecord(sourceRecord)],
      });

      expectIssue(
        compareMutationReport(current, baseline),
        'mutation_identity_mismatch',
        ['M-STABLE-ID'],
      );
    },
  );
});

describe('evaluateMutationPolicy', () => {
  it('fails every category of new unexplained or unaccepted debt with sorted reasons and IDs', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const report = reportFor({
      records: [
        killed('M-KILLED'),
        debt({ id: 'M-UNRESOLVED' }),
        debt({
          id: 'M-TEST-GAP',
          classification: 'test_gap',
        }),
        debt({
          id: 'M-EQUIVALENT-CANDIDATE',
          classification: 'equivalent',
          status: 'candidate',
          humanDecision: false,
        }),
        debt({
          id: 'M-UNCONFIRMED',
          classification: 'unreachable_code',
          status: 'candidate',
          humanDecision: false,
        }),
        debt({
          id: 'M-NO-COVERAGE',
          outcome: 'no_coverage',
          classification: 'irrelevant_generated_code',
        }),
      ],
    });

    const evaluation = evaluateMutationPolicy({
      report,
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('failed');
    expect(evaluation.reasons).toEqual([
      {
        code: 'new_equivalent_candidate',
        mutationIds: ['M-EQUIVALENT-CANDIDATE'],
      },
      {
        code: 'new_no_coverage',
        mutationIds: ['M-NO-COVERAGE'],
      },
      {
        code: 'new_test_gap',
        mutationIds: ['M-TEST-GAP'],
      },
      {
        code: 'new_unconfirmed_classification',
        mutationIds: ['M-UNCONFIRMED'],
      },
      {
        code: 'new_unresolved_mutation',
        mutationIds: ['M-UNRESOLVED'],
      },
    ]);
    expect(evaluation.affectedMutationIds).toEqual([
      'M-EQUIVALENT-CANDIDATE',
      'M-NO-COVERAGE',
      'M-TEST-GAP',
      'M-UNCONFIRMED',
      'M-UNRESOLVED',
    ]);
  });

  it('passes only human-confirmed accepted classifications for new survivors', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const accepted: readonly MutationClassification[] = [
      'equivalent',
      'irrelevant_generated_code',
      'unreachable_code',
      'invalid_mutation',
      'tool_limitation',
    ];
    const report = reportFor({
      records: [
        killed('M-KILLED'),
        ...accepted.map((classification, index) =>
          debt({
            id: `M-ACCEPTED-${index}`,
            classification,
            status: 'confirmed',
            humanDecision: true,
          }),
        ),
      ],
    });

    const evaluation = evaluateMutationPolicy({
      report,
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation).toEqual(
      expect.objectContaining({
        status: 'passed',
        reasons: [
          {
            code: 'mutation_policy_satisfied',
            mutationIds: [],
          },
        ],
        affectedMutationIds: [],
      }),
    );
  });

  it('does not accept a forged confirmed classification without human evidence', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const valid = debt({
      id: 'M-FORGED-HUMAN',
      classification: 'equivalent',
      status: 'confirmed',
      humanDecision: true,
    });
    const forged = {
      ...valid,
      evidence: valid.evidence.filter(
        (evidence) => evidence.type !== 'human_decision',
      ),
    } as MutationDebtRecord;

    const evaluation = evaluateMutationPolicy({
      report: {
        ...reportFor({
          records: [killed('M-KILLED'), valid],
        }),
        mutations: [killed('M-KILLED'), forged],
      },
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('inconclusive');
    expect(evaluation.reasons).toContainEqual({
      code: 'current_report_invalid',
      mutationIds: [],
    });
  });

  it('accepts only an exact active accepted-risk exception through its expiry date', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const acceptedRisk = debt({
      id: 'M-ACCEPTED-RISK',
      classification: 'accepted_risk',
      exceptionRef: 'EX-MUTATION',
    });
    const request = {
      report: reportFor({
        records: [killed('M-KILLED'), acceptedRisk],
      }),
      baseline,
      profile: profileFor({
        exceptions: [
          {
            id: 'EX-MUTATION',
            expiresOn: '2026-07-27',
            mutationIds: ['M-ACCEPTED-RISK'],
          },
        ],
      }),
      now: new Date('2026-07-27T23:59:59Z'),
    };

    expect(evaluateMutationPolicy(request).status).toBe('passed');
  });

  it.each([
    [
      'accepted_risk_exception_missing',
      profileFor(),
      new Date('2026-07-27T12:00:00Z'),
    ],
    [
      'accepted_risk_exception_expired',
      profileFor({
        exceptions: [
          {
            id: 'EX-MUTATION',
            expiresOn: '2026-07-26',
            mutationIds: ['M-ACCEPTED-RISK'],
          },
        ],
      }),
      new Date('2026-07-27T12:00:00Z'),
    ],
    [
      'accepted_risk_exception_policy_disabled',
      profileFor({ exceptionsAllowed: false }),
      new Date('2026-07-27T12:00:00Z'),
    ],
  ] as const)(
    'fails new accepted risk with %s',
    (expectedCode, profile, now) => {
      const baseline = activeBaseline(
        reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
      );
      const evaluation = evaluateMutationPolicy({
        report: reportFor({
          records: [
            killed('M-KILLED'),
            debt({
              id: 'M-ACCEPTED-RISK',
              classification: 'accepted_risk',
              exceptionRef: 'EX-MUTATION',
            }),
          ],
        }),
        baseline,
        profile,
        now,
      });

      expect(evaluation.status).toBe('failed');
      expect(evaluation.reasons).toContainEqual({
        code: expectedCode,
        mutationIds: ['M-ACCEPTED-RISK'],
      });
    },
  );

  it('rejects an accepted-risk exception that does not select the mutation ID', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const evaluation = evaluateMutationPolicy({
      report: reportFor({
        records: [
          killed('M-KILLED'),
          debt({
            id: 'M-ACCEPTED-RISK',
            classification: 'accepted_risk',
            exceptionRef: 'EX-MUTATION',
          }),
        ],
      }),
      baseline,
      profile: profileFor({
        exceptions: [
          {
            id: 'EX-MUTATION',
            expiresOn: '2026-08-31',
            mutationIds: ['M-SOMEONE-ELSE'],
          },
        ],
      }),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('failed');
    expect(evaluation.reasons).toContainEqual({
      code: 'accepted_risk_exception_not_applicable',
      mutationIds: ['M-ACCEPTED-RISK'],
    });
  });

  it('does not fail persistent baseline debt merely because it is unresolved, a test gap, or an equivalent candidate', () => {
    const source = reportFor({
      id: 'REPORT-BASE',
      records: [
        debt({ id: 'M-UNRESOLVED' }),
        debt({ id: 'M-GAP', classification: 'test_gap' }),
        debt({
          id: 'M-EQUIVALENT',
          classification: 'equivalent',
          status: 'candidate',
          humanDecision: false,
        }),
        debt({ id: 'M-NO-COVERAGE', outcome: 'no_coverage' }),
      ],
    });
    const baseline = activeBaseline(source);
    const evaluation = evaluateMutationPolicy({
      report: reportFor({
        records: source.mutations,
      }),
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('passed');
  });

  it('fails survived-to-no-coverage regression but permits the reverse transition', () => {
    const survivedBaseline = activeBaseline(
      reportFor({
        id: 'REPORT-BASE-SURVIVED',
        records: [debt({ id: 'M-TRANSITION' })],
      }),
      'BASELINE-SURVIVED',
    );
    const regression = evaluateMutationPolicy({
      report: reportFor({
        records: [
          debt({
            id: 'M-TRANSITION',
            outcome: 'no_coverage',
          }),
        ],
      }),
      baseline: survivedBaseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(regression.status).toBe('failed');
    expect(regression.reasons).toContainEqual({
      code: 'survived_to_no_coverage_regression',
      mutationIds: ['M-TRANSITION'],
    });

    const noCoverageBaseline = activeBaseline(
      reportFor({
        id: 'REPORT-BASE-NO-COVERAGE',
        records: [
          debt({
            id: 'M-TRANSITION',
            outcome: 'no_coverage',
          }),
        ],
      }),
      'BASELINE-NO-COVERAGE',
    );
    const improvement = evaluateMutationPolicy({
      report: reportFor({
        records: [debt({ id: 'M-TRANSITION' })],
      }),
      baseline: noCoverageBaseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(improvement.status).toBe('passed');
  });

  it('fails a persistent accepted-risk debt with an expired exception but ignores a resolved one', () => {
    const baselineRecord = debt({
      id: 'M-BASELINE-RISK',
      classification: 'accepted_risk',
      exceptionRef: 'EX-BASELINE',
    });
    const baseline = activeBaseline(
      reportFor({
        id: 'REPORT-BASE-RISK',
        records: [baselineRecord],
      }),
    );
    const expiredProfile = profileFor({
      exceptions: [
        {
          id: 'EX-BASELINE',
          expiresOn: '2026-07-26',
          mutationIds: ['M-BASELINE-RISK'],
        },
      ],
    });

    const persistent = evaluateMutationPolicy({
      report: reportFor({ records: [baselineRecord] }),
      baseline,
      profile: expiredProfile,
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(persistent.status).toBe('failed');
    expect(persistent.reasons).toContainEqual({
      code: 'accepted_risk_exception_expired',
      mutationIds: ['M-BASELINE-RISK'],
    });

    const resolved = evaluateMutationPolicy({
      report: reportFor({ records: [killed('M-BASELINE-RISK')] }),
      baseline,
      profile: expiredProfile,
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(resolved.status).toBe('passed');
  });

  it('rejects swapping the exception reference for persistent accepted-risk debt', () => {
    const baselineRecord = debt({
      id: 'M-PERSISTENT-RISK',
      classification: 'accepted_risk',
      exceptionRef: 'EX-OLD',
    });
    const baseline = activeBaseline(
      reportFor({
        id: 'REPORT-BASE-RISK',
        records: [baselineRecord],
      }),
    );
    const currentRecord = debt({
      id: 'M-PERSISTENT-RISK',
      classification: 'accepted_risk',
      exceptionRef: 'EX-NEW',
    });
    const evaluation = evaluateMutationPolicy({
      report: reportFor({ records: [currentRecord] }),
      baseline,
      profile: profileFor({
        exceptions: [
          {
            id: 'EX-OLD',
            expiresOn: '2026-08-31',
            mutationIds: ['M-PERSISTENT-RISK'],
          },
          {
            id: 'EX-NEW',
            expiresOn: '2026-08-31',
            mutationIds: ['M-PERSISTENT-RISK'],
          },
        ],
      }),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('failed');
    expect(evaluation.reasons).toContainEqual({
      code: 'accepted_risk_exception_changed',
      mutationIds: ['M-PERSISTENT-RISK'],
    });
  });

  it('returns inconclusive when an active baseline contradicts a not-available baseline policy', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const evaluation = evaluateMutationPolicy({
      report: reportFor({ records: [killed('M-KILLED')] }),
      baseline,
      profile: profileFor({ existingSurvivors: 'not_available' }),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('inconclusive');
    expect(evaluation.reasons).toContainEqual({
      code: 'baseline_policy_not_available',
      mutationIds: [],
    });
  });

  it('returns stable inconclusive reasons for malformed unknown inputs', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const valid = reportFor({ records: [killed('M-KILLED')] });
    const first = valid.mutations[0];
    expect(first).toBeDefined();
    const malformed = {
      ...valid,
      mutations: [
        {
          ...first,
          outcome: 'mysteriously_green',
        },
      ],
    } as unknown as MutationReport;
    const malformedResult = evaluateMutationPolicy({
      report: malformed,
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(malformedResult.status).toBe('inconclusive');
    expect(malformedResult.reasons).toEqual([
      {
        code: 'current_report_invalid',
        mutationIds: [],
      },
    ]);

    let accessorEvaluated = false;
    const hostileMutations: unknown[] = [];
    Object.defineProperty(hostileMutations, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorEvaluated = true;
        return first;
      },
    });
    hostileMutations.length = 1;
    const hostileArrayResult = evaluateMutationPolicy({
      report: {
        ...valid,
        mutations: hostileMutations,
      } as unknown as MutationReport,
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(hostileArrayResult).toMatchObject({
      status: 'inconclusive',
      reasons: [{ code: 'current_report_invalid' }],
    });
    expect(accessorEvaluated).toBe(false);

    const missingEvidenceResult = evaluateMutationPolicy({
      report: {
        ...valid,
        evidence: [],
      },
      baseline,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(missingEvidenceResult.status).toBe('inconclusive');
    expect(missingEvidenceResult.reasons).toEqual([
      {
        code: 'current_execution_evidence_missing',
        mutationIds: [],
      },
      {
        code: 'current_report_invalid',
        mutationIds: [],
      },
    ]);

    const invalidRequest = evaluateMutationPolicy(
      null as unknown as Parameters<typeof evaluateMutationPolicy>[0],
    );
    expect(invalidRequest).toEqual({
      status: 'inconclusive',
      reportId: 'INVALID-REPORT',
      reasons: [
        {
          code: 'invalid_evaluation_request',
          mutationIds: [],
        },
      ],
      affectedMutationIds: [],
    });
  });

  it('returns inconclusive for missing or decision-ineligible evidence before classifying debt', () => {
    const partial = reportFor({
      completeness: 'partial',
      records: [timedOut('M-TIME'), providerError('M-ERROR')],
    });
    const missing = evaluateMutationPolicy({
      report: partial,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(missing.status).toBe('inconclusive');
    expect(missing.reasons).toEqual([
      {
        code: 'baseline_missing',
        mutationIds: [],
      },
      {
        code: 'current_run_errors',
        mutationIds: ['M-ERROR'],
      },
      {
        code: 'current_run_partial',
        mutationIds: [],
      },
      {
        code: 'current_run_timed_out',
        mutationIds: ['M-TIME'],
      },
    ]);

    const source = reportFor({
      id: 'REPORT-BASE',
      records: [killed('M-KILLED')],
    });
    const candidate = candidateBaseline(source);
    const candidateResult = evaluateMutationPolicy({
      report: reportFor(),
      baseline: candidate,
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });
    expect(candidateResult.status).toBe('inconclusive');
    expect(candidateResult.reasons).toContainEqual({
      code: 'baseline_candidate',
      mutationIds: [],
    });
  });

  it.each([
    [
      'current_run_partial',
      reportFor({
        completeness: 'partial',
        records: [killed('M-KILLED')],
      }),
    ],
    ['current_run_zero_generated', reportFor({ records: [] })],
    [
      'current_run_timed_out',
      reportFor({ records: [killed('M-KILLED'), timedOut('M-TIME')] }),
    ],
    [
      'current_run_errors',
      reportFor({
        records: [killed('M-KILLED'), providerError('M-ERROR')],
      }),
    ],
  ] as const)('returns inconclusive for %s', (expectedCode, report) => {
    const evaluation = evaluateMutationPolicy({
      report,
      baseline: activeBaseline(
        reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
      ),
      profile: profileFor(),
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(evaluation.status).toBe('inconclusive');
    expect(evaluation.reasons.map((reason) => reason.code)).toContain(
      expectedCode,
    );
  });

  it('returns inconclusive for policy-profile mismatch and invalid evaluation time', () => {
    const report = reportFor();
    const evaluation = evaluateMutationPolicy({
      report,
      baseline: activeBaseline(
        reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
      ),
      profile: profileFor({
        id: 'PROFILE-OTHER',
        projectRef: 'PROJECT-OTHER',
      }),
      now: new Date(Number.NaN),
    });

    expect(evaluation.status).toBe('inconclusive');
    expect(evaluation.reasons).toEqual([
      {
        code: 'invalid_evaluation_time',
        mutationIds: [],
      },
      {
        code: 'policy_profile_mismatch',
        mutationIds: [],
      },
    ]);
  });

  it('never lets score-reporting configuration decide the result', () => {
    const baseline = activeBaseline(
      reportFor({ id: 'REPORT-BASE', records: [killed('M-KILLED')] }),
    );
    const report = reportFor({
      records: [killed('M-KILLED'), debt({ id: 'M-UNRESOLVED' })],
    });
    const evaluateWith = (
      reportScore: boolean | null,
    ): MutationPolicyEvaluation =>
      evaluateMutationPolicy({
        report,
        baseline,
        profile: profileFor({ reportScore }),
        now: new Date('2026-07-27T12:00:00Z'),
      });

    expect(evaluateWith(true).status).toBe('failed');
    expect(evaluateWith(false).status).toBe('failed');
    expect(evaluateWith(null).status).toBe('failed');
    expect(evaluateWith(true).reasons).toEqual(evaluateWith(false).reasons);
    expect(evaluateWith(false).reasons).toEqual(evaluateWith(null).reasons);
  });
});

describe('registered mutation policy boundary', () => {
  const registryForPolicy = (
    currentReportId = 'REPORT-REGISTERED-CURRENT',
    records: readonly MutationRecord[] = [killed('M-KILLED')],
    profile: AssuranceProfile = profileFor(),
  ): {
    readonly registry: {
      readonly entries: readonly LocatedArtifact[];
    };
    readonly reportId: string;
    readonly baselineId: string;
    readonly profileId: string;
  } => {
    const source = reportFor({
      id: 'REPORT-REGISTERED-SOURCE',
      records,
    });
    const report = reportFor({
      id: currentReportId,
      records,
    });
    const baseline = activeBaseline(source, 'BASELINE-REGISTERED');
    const project = ProjectProfileSchema.parse({
      schema_version: 1,
      kind: 'project_profile',
      id: 'PROJECT-MUTATION',
      name: 'Registered mutation project',
      technologies: [],
      modules: [],
      observations: [
        {
          id: 'OBS-REGISTERED-MUTATION',
          type: 'fact',
          statement: 'The project uses the registered mutation policy path.',
          confidence: 1,
          evidence: [
            {
              id: 'EV-REGISTERED-PROJECT',
              type: 'test_result',
              description:
                'The registered policy fixture is covered by its boundary test.',
              location: 'packages/mutation-engine/src/mutation-engine.test.ts',
            },
          ],
        },
      ],
      constraints: [],
      uncertainties: [],
    });
    const plan = AssurancePlanSchema.parse({
      schema_version: 1,
      kind: 'assurance_plan',
      id: 'PLAN-MUTATION',
      change_id: 'CHANGE-MUTATION',
      project_ref: project.id,
      assurance_profile_ref: profile.id,
      risk: {
        overall: 'medium',
        likelihood: 'medium',
        impact: 'medium',
        confidence: 0.9,
        factors: ['Changed mutation-tested behavior.'],
        evidence: [
          {
            id: 'EV-REGISTERED-CHANGE',
            type: 'git_change',
            description: 'Synthetic registered-policy test change.',
            location: 'git:registered-policy',
          },
        ],
      },
      impacted_flows: ['Registered policy test flow'],
      required_gates: [
        {
          id: 'GATE-REGISTERED-MUTATION',
          type: 'mutation_tests',
          blocking: true,
          reason: 'The changed behavior requires mutation evidence.',
        },
      ],
      mutation_scope: report.scope,
      human_review: {
        level: 1,
        targets: ['Complete relevant diff.'],
        rationale: ['Automated gates run before human review.'],
      },
      rationale: ['Exercise the registry-backed policy boundary.'],
    });
    const entries: LocatedArtifact[] = [
      project,
      profile,
      plan,
      source,
      report,
      baseline,
    ].map((artifact) => ({
      origin: `test:${artifact.id}`,
      artifact,
    }));
    const result = createArtifactRegistry(entries);
    if (!result.success) {
      throw new Error(
        `Could not create registered-policy test registry: ${result.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      );
    }
    return {
      registry: result.registry,
      reportId: report.id,
      baselineId: baseline.id,
      profileId: profile.id,
    };
  };

  it('passes only through a complete rebuilt artifact registry', () => {
    const input = registryForPolicy();

    const evaluation = evaluateRegisteredMutationPolicy({
      ...input,
      now: new Date('2026-07-27T13:00:00Z'),
    });

    expect(evaluation.status).toBe('passed');
    expect(evaluation.reasons).toEqual([
      { code: 'mutation_policy_satisfied', mutationIds: [] },
    ]);
  });

  it('rejects incomplete or forged registry selections', () => {
    const input = registryForPolicy();
    const incomplete = {
      entries: input.registry.entries.filter(
        (entry) => entry.artifact.kind !== 'assurance_plan',
      ),
    };

    expect(
      evaluateRegisteredMutationPolicy({
        ...input,
        registry: incomplete,
        now: new Date('2026-07-27T13:00:00Z'),
      }),
    ).toMatchObject({
      status: 'inconclusive',
      reasons: [{ code: 'invalid_evaluation_registry' }],
    });
    expect(
      evaluateRegisteredMutationPolicy({
        ...input,
        reportId: 'REPORT-MISSING',
        now: new Date('2026-07-27T13:00:00Z'),
      }),
    ).toMatchObject({
      status: 'inconclusive',
      reasons: [{ code: 'invalid_evaluation_selection' }],
    });
    expect(
      evaluateRegisteredMutationPolicy({
        ...input,
        reportId: { id: input.reportId } as unknown as string,
        now: new Date('2026-07-27T13:00:00Z'),
      }),
    ).toMatchObject({
      status: 'inconclusive',
      reasons: [{ code: 'invalid_evaluation_selection' }],
    });
  });

  it('does not reserve a valid artifact ID as an internal sentinel', () => {
    const input = registryForPolicy('INVALID-REPORT');

    expect(
      evaluateRegisteredMutationPolicy({
        ...input,
        now: new Date('2026-07-27T13:00:00Z'),
      }),
    ).toMatchObject({
      status: 'passed',
      reportId: 'INVALID-REPORT',
    });
  });

  it('lets policy fail an applicable expired mutation exception', () => {
    const record = debt({
      id: 'M-REGISTERED-RISK',
      classification: 'accepted_risk',
      exceptionRef: 'EX-REGISTERED-RISK',
    });
    const input = registryForPolicy(
      'REPORT-REGISTERED-RISK',
      [record],
      profileFor({
        exceptions: [
          {
            id: 'EX-REGISTERED-RISK',
            expiresOn: '2026-07-26',
            mutationIds: [record.id],
          },
        ],
      }),
    );

    expect(
      evaluateRegisteredMutationPolicy({
        ...input,
        now: new Date('2026-07-27T13:00:00Z'),
      }),
    ).toMatchObject({
      status: 'failed',
      reasons: [
        {
          code: 'accepted_risk_exception_expired',
          mutationIds: [record.id],
        },
      ],
    });
  });
});
