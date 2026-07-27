import { describe, expect, it } from 'vitest';

import { validateArtifact } from './artifact.js';
import { MutationBaselineSchema } from './mutation-baseline.js';

const reportEvidence = {
  id: 'EV-MUTATION-REPORT',
  type: 'test_result' as const,
  description: 'Normalized mutation report.',
  location: 'artifacts/mutations.xml',
};

const activeBaselineInput = (): Record<string, unknown> => ({
  schema_version: 1,
  kind: 'mutation_baseline',
  id: 'BASELINE-1',
  project_ref: 'PROJECT-1',
  assurance_profile_ref: 'ASSURANCE-1',
  source_report_ref: 'REPORT-1',
  status: 'active',
  provider: {
    id: 'pitest',
    tool_version: '1.25.3',
    normalization_version: 'pitest-xml-v1',
    configuration_fingerprint:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  scope: {
    primary_targets: ['example.Policy'],
    supporting_targets: [],
    relevant_tests: ['example.PolicyTest'],
    confidence: 0.9,
    limitations: [],
  },
  source_run: {
    completeness: 'complete',
    totals: {
      generated: 2,
      killed: 1,
      survived: 1,
      no_coverage: 0,
      timed_out: 0,
      errors: 0,
    },
    limitations: [],
  },
  entries: [
    {
      id: 'MUTANT-1',
      provider_outcome: 'SURVIVED',
      outcome: 'survived',
      operator: 'CONDITIONALS_BOUNDARY',
      description: 'Changed a boundary.',
      location: {
        provider_source: 'Policy.java',
        file: 'src/main/java/example/Policy.java',
        symbol: 'allows',
        line: 12,
      },
      classification: 'equivalent',
      classification_status: 'confirmed',
      action: {
        required: true,
        category: 'investigate_survivor',
        reason: 'The mutation survived.',
      },
      evidence: [
        reportEvidence,
        {
          id: 'EV-MUTANT-CLASSIFICATION',
          type: 'human_decision',
          description: 'A human confirmed the equivalent classification.',
          location: 'decisions/MUTANT-1.md',
        },
      ],
    },
  ],
  created_at: '2026-07-26T12:00:00Z',
  activation: {
    owner: 'quality-team',
    reviewed_on: '2026-07-26',
    decision_ref: 'EV-BASELINE-ACTIVATION',
    evidence: [
      {
        id: 'EV-BASELINE-ACTIVATION',
        type: 'human_decision',
        description: 'The team activated this mutation baseline.',
        location: 'decisions/baseline.md',
      },
    ],
  },
});

describe('MutationBaselineSchema', () => {
  it('accepts an eligible, human-activated baseline', () => {
    expect(
      MutationBaselineSchema.safeParse(activeBaselineInput()).success,
    ).toBe(true);
  });

  it.each([
    {
      name: 'human activation',
      mutate: (input: Record<string, unknown>): void => {
        delete input.activation;
      },
      path: ['activation'],
    },
    {
      name: 'exact tool version',
      mutate: (input: Record<string, unknown>): void => {
        const provider = input.provider as Record<string, unknown>;
        delete provider.tool_version;
      },
      path: ['provider', 'tool_version'],
    },
    {
      name: 'exact configuration fingerprint',
      mutate: (input: Record<string, unknown>): void => {
        const provider = input.provider as Record<string, unknown>;
        delete provider.configuration_fingerprint;
      },
      path: ['provider', 'configuration_fingerprint'],
    },
    {
      name: 'complete source run',
      mutate: (input: Record<string, unknown>): void => {
        const sourceRun = input.source_run as Record<string, unknown>;
        sourceRun.completeness = 'partial';
        sourceRun.limitations = ['The report is partial.'];
      },
      path: ['source_run', 'completeness'],
    },
    {
      name: 'zero indeterminate outcomes',
      mutate: (input: Record<string, unknown>): void => {
        const sourceRun = input.source_run as Record<string, unknown>;
        const totals = sourceRun.totals as Record<string, unknown>;
        totals.timed_out = 1;
        totals.generated = 3;
      },
      path: ['source_run', 'totals'],
    },
    {
      name: 'at least one generated mutation',
      mutate: (input: Record<string, unknown>): void => {
        const sourceRun = input.source_run as Record<string, unknown>;
        sourceRun.totals = {
          generated: 0,
          killed: 0,
          survived: 0,
          no_coverage: 0,
          timed_out: 0,
          errors: 0,
        };
        input.entries = [];
      },
      path: ['source_run', 'totals', 'generated'],
    },
  ])('requires $name before activation', ({ mutate, path }) => {
    const input = activeBaselineInput();
    mutate(input);

    const result = MutationBaselineSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    }
  });

  it('does not let generated candidates carry an activation decision', () => {
    const input = activeBaselineInput();
    input.status = 'candidate';

    const result = MutationBaselineSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['activation'],
            message: 'A candidate baseline cannot carry activation',
          }),
        ]),
      );
    }
  });

  it('requires exact source totals and retained debt entries', () => {
    const input = activeBaselineInput();
    const sourceRun = input.source_run as Record<string, unknown>;
    const totals = sourceRun.totals as Record<string, unknown>;
    totals.survived = 0;
    totals.killed = 2;

    const result = MutationBaselineSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['source_run', 'totals', 'survived'],
            message:
              'Baseline survived total must equal the number of surviving entries',
          }),
        ]),
      );
    }
  });

  it('requires activation to point to matching human-decision evidence', () => {
    const input = activeBaselineInput();
    const activation = input.activation as Record<string, unknown>;
    activation.decision_ref = 'EV-OTHER';

    const result = MutationBaselineSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['activation', 'decision_ref'],
          }),
        ]),
      );
    }
  });

  it('rejects activation before creation and future governance dates', () => {
    const beforeCreation = activeBaselineInput();
    beforeCreation.created_at = '2026-07-27T12:00:00Z';
    const earlyActivation = beforeCreation.activation as Record<
      string,
      unknown
    >;
    earlyActivation.reviewed_on = '2026-07-26';

    expect(MutationBaselineSchema.safeParse(beforeCreation)).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ['activation', 'reviewed_on'],
          }),
        ],
      },
    });

    const future = activeBaselineInput();
    future.created_at = '2026-07-28T12:00:00Z';
    const futureActivation = future.activation as Record<string, unknown>;
    futureActivation.reviewed_on = '2026-07-28';
    const validation = validateArtifact(future, {
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(validation).toMatchObject({
      success: false,
      issues: [
        { code: 'future_baseline_creation', path: '$.created_at' },
        {
          code: 'future_baseline_activation',
          path: '$.activation.reviewed_on',
        },
      ],
    });
  });
});
