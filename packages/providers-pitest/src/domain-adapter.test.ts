import { readFile } from 'node:fs/promises';

import { AssurancePlanSchema, type AssurancePlan } from '@craftcompass/domain';
import { describe, expect, it } from 'vitest';

import {
  PIT_NORMALIZATION_VERSION,
  PitMutationReportError,
  normalizePitMutationRun,
  type PitExecutionAttestation,
  type NormalizePitRunRequest,
} from './domain-adapter.js';
import { parsePitXml } from './pit-xml-parser.js';
import type { PitMutation, PitMutationRun } from './types.js';

const ALL_STATUSES = new URL(
  '../../../fixtures/pitest/valid/all-statuses.xml',
  import.meta.url,
);
const EMPTY_PARTIAL = new URL(
  '../../../fixtures/pitest/valid/empty-partial.xml',
  import.meta.url,
);
const EMPTY_COMPLETE = new URL(
  '../../../fixtures/pitest/valid/empty-complete.xml',
  import.meta.url,
);
const ALL_KILLED = new URL(
  '../../../fixtures/pitest/valid/all-killed.xml',
  import.meta.url,
);
const NO_METHOD_CONTEXT = new URL(
  '../../../fixtures/pitest/valid/no-method-context.xml',
  import.meta.url,
);

const actionCategoryOf = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const action = (value as Record<string, unknown>)['action'];
  if (typeof action !== 'object' || action === null) {
    return undefined;
  }
  const category = (action as Record<string, unknown>)['category'];
  return typeof category === 'string' ? category : undefined;
};

const plan = (): AssurancePlan =>
  AssurancePlanSchema.parse({
    schema_version: 1,
    kind: 'assurance_plan',
    id: 'PLAN-PIT-TEST',
    change_id: 'CHANGE-PIT-TEST',
    project_ref: 'PROJECT-PIT-TEST',
    assurance_profile_ref: 'PROFILE-PIT-TEST',
    risk: {
      overall: 'high',
      likelihood: 'medium',
      impact: 'high',
      confidence: 0.8,
      factors: ['Changed business behavior.'],
      evidence: [
        {
          id: 'EV-CHANGE-PIT',
          type: 'git_change',
          description: 'Changed mutation target.',
          location: 'git:change',
        },
      ],
    },
    impacted_flows: ['Example flow'],
    required_gates: [
      {
        id: 'GATE-PIT',
        type: 'mutation_tests',
        blocking: true,
        reason: 'Changed behavior requires mutation evidence.',
      },
    ],
    mutation_scope: {
      primary_targets: ['example.order.domain.OrderCancellationService'],
      supporting_targets: [],
      relevant_tests: ['example.order.domain.OrderCancellationServiceTest'],
      confidence: 0.8,
      limitations: [],
    },
    human_review: {
      level: 1,
      targets: ['Mutation debt.'],
      rationale: ['The complete relevant diff remains reviewed.'],
    },
    rationale: ['Mutation testing is evidence about test strength.'],
  });

const attestation = (assurancePlan: AssurancePlan): PitExecutionAttestation => {
  if (assurancePlan.mutation_scope === undefined) {
    throw new Error('Test plan must define mutation scope.');
  }
  return {
    assurancePlanRef: assurancePlan.id,
    scope: assurancePlan.mutation_scope,
    configurationFingerprint: `sha256:${'a'.repeat(64)}`,
    evidence: {
      id: 'EV-PIT-EXECUTION-CONFIG',
      type: 'build_configuration',
      description:
        'PIT execution configuration bound to the selected assurance scope.',
      location: 'target/pit-reports/execution-attestation.json',
      provider: 'pitest',
    },
  };
};

describe('normalizePitMutationRun', () => {
  it('maps every PIT outcome without accepting an equivalent candidate', async () => {
    const run = parsePitXml(
      await readFile(ALL_STATUSES),
      'target/pit-reports/mutations.xml',
    );

    const report = normalizePitMutationRun({
      reportId: 'REPORT-PIT-TEST',
      run,
      plan: plan(),
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      toolVersion: '1.25.3',
    });

    expect(report.provider).toEqual({
      id: 'pitest',
      tool_version: '1.25.3',
      normalization_version: PIT_NORMALIZATION_VERSION,
    });
    expect(report.provider_run_id).toBe(run.id);
    expect(report.totals).toEqual({
      generated: 8,
      killed: 1,
      survived: 2,
      no_coverage: 1,
      timed_out: 1,
      errors: 3,
    });
    expect(report.mutations).toHaveLength(8);
    expect(report.run).toEqual({
      completeness: 'partial',
      limitations: [
        'The imported mutations.xml report has no execution attestation binding it to the assurance-plan scope.',
      ],
    });
    const equivalent = report.mutations.find(
      (mutation) => mutation.provider_outcome === 'EQUIVALENT',
    );
    expect(equivalent).toBeDefined();
    if (equivalent === undefined) {
      return;
    }
    expect(equivalent.outcome).toBe('survived');
    if (equivalent.outcome !== 'survived') {
      return;
    }
    expect(equivalent.classification).toBe('equivalent');
    expect(equivalent.classification_status).toBe('candidate');
    expect(actionCategoryOf(equivalent)).toBe('review_equivalent_candidate');
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        status: 'conditional',
        captured_at: '2026-07-26T12:00:00Z',
      }),
    );
  });

  it('passes a non-empty all-killed report only with an exact execution attestation', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(ALL_KILLED),
      'target/pit-reports/mutations.xml',
    );
    const firstMutation = run.mutations[0];
    expect(firstMutation).toBeDefined();
    if (firstMutation === undefined) {
      return;
    }

    const report = normalizePitMutationRun({
      reportId: 'REPORT-PIT-PASS',
      run,
      plan: assurancePlan,
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      toolVersion: '1.25.3',
      executionAttestation: attestation(assurancePlan),
      resolvedSourcePaths: {
        [firstMutation.id]:
          'src/main/java/example/order/domain/OrderCancellationService.java',
      },
    });

    expect(report.run).toEqual({
      completeness: 'complete',
      limitations: [],
    });
    expect(report.provider.configuration_fingerprint).toBe(
      `sha256:${'a'.repeat(64)}`,
    );
    expect(report.evidence[0]?.execution?.configuration_evidence_ref).toBe(
      'EV-PIT-EXECUTION-CONFIG',
    );
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        status: 'passed',
        summary: 'Every imported PIT mutation was killed by a selected test.',
      }),
    );
    expect(report.mutations[0]?.location).toEqual({
      provider_source: 'OrderCancellationService.java',
      file: 'src/main/java/example/order/domain/OrderCancellationService.java',
      symbol: 'example.order.domain.OrderCancellationService.total()I',
      line: 12,
    });
  });

  it('rejects a structurally fabricated run with contradictory PIT status', async () => {
    const assurancePlan = plan();
    const parsedRun = parsePitXml(
      await readFile(ALL_KILLED),
      'target/pit-reports/mutations.xml',
    );
    const parsedMutation = parsedRun.mutations[0];
    expect(parsedMutation).toBeDefined();
    if (parsedMutation === undefined) {
      return;
    }
    const fabricatedRun: PitMutationRun = {
      ...parsedRun,
      mutations: [
        {
          ...parsedMutation,
          pit_status: 'SURVIVED',
          detected: false,
          outcome: 'killed',
          action: null,
          equivalent_classification: null,
        },
      ],
    };

    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-FABRICATED',
        run: fabricatedRun,
        plan: assurancePlan,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
        toolVersion: '1.25.3',
        executionAttestation: attestation(assurancePlan),
      }),
    ).toThrow(
      'PIT run must be the immutable result returned directly by parsePitXml',
    );
  });

  it('deeply freezes authenticated parser output before normalization', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(ALL_KILLED),
      'target/pit-reports/mutations.xml',
    );
    const mutation = run.mutations[0];
    expect(mutation).toBeDefined();
    if (mutation === undefined) {
      return;
    }

    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.totals)).toBe(true);
    expect(Object.isFrozen(run.mutations)).toBe(true);
    expect(Object.isFrozen(mutation)).toBe(true);
    expect(Object.isFrozen(mutation.tests)).toBe(true);
    expect(Object.isFrozen(mutation.tests.killing_tests)).toBe(true);
    expect(() => {
      (mutation as { outcome: string }).outcome = 'survived';
    }).toThrow(TypeError);
    expect(() => {
      (run.mutations as PitMutation[]).push(mutation);
    }).toThrow(TypeError);

    const report = normalizePitMutationRun({
      reportId: 'REPORT-PIT-IMMUTABLE',
      run,
      plan: assurancePlan,
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      toolVersion: '1.25.3',
      executionAttestation: attestation(assurancePlan),
    });

    expect(report.evidence[0]?.status).toBe('passed');
  });

  it('rejects wrappers around an authentic parser result', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(ALL_KILLED),
      'target/pit-reports/mutations.xml',
    );

    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-WRAPPED',
        run: new Proxy(run, {}),
        plan: assurancePlan,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
        toolVersion: '1.25.3',
        executionAttestation: attestation(assurancePlan),
      }),
    ).toThrow(
      'PIT run must be the immutable result returned directly by parsePitXml',
    );
  });

  it('uses the authenticated run snapshot when a request getter changes', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(ALL_KILLED),
      'target/pit-reports/mutations.xml',
    );
    const parsedMutation = run.mutations[0];
    expect(parsedMutation).toBeDefined();
    if (parsedMutation === undefined) {
      return;
    }
    const fabricatedRun: PitMutationRun = {
      ...run,
      mutations: [
        {
          ...parsedMutation,
          pit_status: 'SURVIVED',
          detected: false,
          outcome: 'killed',
          action: null,
          equivalent_classification: null,
        },
      ],
    };
    let runReads = 0;
    const request: NormalizePitRunRequest = {
      reportId: 'REPORT-PIT-RUN-GETTER',
      get run() {
        runReads += 1;
        return runReads === 1 ? run : fabricatedRun;
      },
      plan: assurancePlan,
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      toolVersion: '1.25.3',
      executionAttestation: attestation(assurancePlan),
    };

    const report = normalizePitMutationRun(request);

    expect(runReads).toBe(1);
    expect(report.mutations[0]?.provider_outcome).toBe('KILLED');
    expect(report.evidence[0]?.status).toBe('passed');
  });

  it('keeps an attested zero-mutation complete report inconclusive', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(EMPTY_COMPLETE),
      'target/pit-reports/empty.xml',
    );

    const report = normalizePitMutationRun({
      reportId: 'REPORT-PIT-EMPTY',
      run,
      plan: assurancePlan,
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      toolVersion: '1.25.3',
      executionAttestation: attestation(assurancePlan),
    });

    expect(report.run.completeness).toBe('complete');
    expect(report.totals.generated).toBe(0);
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        status: 'conditional',
        summary: 'PIT produced zero mutation records; the run is inconclusive.',
      }),
    );
  });

  it('rejects attested reports containing mutation classes outside scope', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(ALL_STATUSES),
      'target/pit-reports/mutations.xml',
    );

    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-OFF-SCOPE',
        run,
        plan: assurancePlan,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
        toolVersion: '1.25.3',
        executionAttestation: attestation(assurancePlan),
      }),
    ).toThrow(/outside the attested scope/u);
  });

  it('rejects a mismatched or unversioned execution attestation', async () => {
    const assurancePlan = plan();
    const run = parsePitXml(
      await readFile(ALL_KILLED),
      'target/pit-reports/mutations.xml',
    );
    const valid = attestation(assurancePlan);

    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-BAD-ATTESTATION',
        run,
        plan: assurancePlan,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
        executionAttestation: {
          ...valid,
          assurancePlanRef: 'PLAN-OTHER',
        },
      }),
    ).toThrow(/not assurance plan/u);
    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-BAD-FINGERPRINT',
        run,
        plan: assurancePlan,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
        executionAttestation: {
          ...valid,
          configurationFingerprint: 'not-a-fingerprint',
        },
      }),
    ).toThrow(/sha256 configuration fingerprint/u);
    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-BAD-EVIDENCE',
        run,
        plan: assurancePlan,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
        executionAttestation: {
          ...valid,
          evidence: {
            ...valid.evidence,
            type: 'test_result',
          },
        },
      }),
    ).toThrow(/build-configuration evidence/u);
  });

  it('keeps a PIT partial report explicit and decision-ineligible', async () => {
    const run = parsePitXml(
      await readFile(EMPTY_PARTIAL),
      'target/pit-reports/mutations.xml',
    );

    const report = normalizePitMutationRun({
      reportId: 'REPORT-PIT-PARTIAL',
      run,
      plan: plan(),
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
    });

    expect(report.run.completeness).toBe('partial');
    expect(report.run.limitations).toEqual([
      'PIT marked the imported mutations.xml report as partial; it cannot authorize a mutation gate.',
      'The imported mutations.xml report has no execution attestation binding it to the assurance-plan scope.',
    ]);
    expect(report.provider.tool_version).toBeUndefined();
    expect(report.evidence[0]?.status).toBe('conditional');
  });

  it('rejects plans without an explicit mutation scope', async () => {
    const run = parsePitXml(
      await readFile(EMPTY_PARTIAL),
      'target/pit-reports/mutations.xml',
    );
    const planWithoutScope = {
      ...plan(),
      mutation_scope: undefined,
    } as unknown as AssurancePlan;

    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-NO-SCOPE',
        run,
        plan: planWithoutScope,
        capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      }),
    ).toThrow(PitMutationReportError);
  });

  it('preserves a provider line zero while omitting an unknown domain line', async () => {
    const run = parsePitXml(
      await readFile(NO_METHOD_CONTEXT),
      'target/pit-reports/no-method-context.xml',
    );
    const assurancePlan = AssurancePlanSchema.parse({
      ...plan(),
      mutation_scope: {
        primary_targets: ['example.GeneratedBridge'],
        supporting_targets: [],
        relevant_tests: ['example.GeneratedBridgeTest'],
        confidence: 0.8,
        limitations: [],
      },
    });

    const report = normalizePitMutationRun({
      reportId: 'REPORT-PIT-NO-METHOD-CONTEXT',
      run,
      plan: assurancePlan,
      capturedAt: new Date('2026-07-26T12:00:00.000Z'),
      toolVersion: '1.25.3',
      executionAttestation: attestation(assurancePlan),
    });

    expect(run.mutations[0]?.line).toBe(0);
    expect(report.mutations[0]?.location).toEqual({
      provider_source: 'src/main/java/example/GeneratedBridge.java',
      symbol: 'example.GeneratedBridge.bridge()Ljava/lang/Object;',
    });
  });

  it('rejects an invalid injected capture time', async () => {
    const run = parsePitXml(
      await readFile(EMPTY_PARTIAL),
      'target/pit-reports/mutations.xml',
    );

    expect(() =>
      normalizePitMutationRun({
        reportId: 'REPORT-PIT-BAD-TIME',
        run,
        plan: plan(),
        capturedAt: new Date(Number.NaN),
      }),
    ).toThrow('capturedAt must be a valid date');
  });
});
