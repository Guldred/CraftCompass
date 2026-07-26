import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseArtifact,
  QualityGateResultSchema,
  validateArtifact,
  type CraftArtifact,
  type MutationReport,
  type ProjectProfile,
  type ProjectRule,
} from '@craftcompass/domain';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readYamlArtifact, serializeYamlArtifact } from './artifact-file.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VALIDATION_DATE = new Date('2026-07-26T12:00:00.000Z');

const artifactPath = (relativePath: string): string =>
  path.join(REPOSITORY_ROOT, relativePath);

const validFixtures = [
  {
    path: 'knowledge/principles/dependency-direction.yaml',
    kind: 'craftsmanship_principle',
    id: 'ARCH-DEPENDENCY-DIRECTION-001',
  },
  {
    path: 'knowledge/principles/semantic-stability.yaml',
    kind: 'craftsmanship_principle',
    id: 'ASSURANCE-SEMANTIC-STABILITY-001',
  },
  {
    path: 'knowledge/current-positions/agent-written-code-review.yaml',
    kind: 'practice_statement',
    id: 'CURRENT-AI-REVIEW-001',
  },
  {
    path: 'fixtures/valid/java-spring-project-profile.yaml',
    kind: 'project_profile',
    id: 'PROJECT-ORDER-SERVICE',
  },
  {
    path: 'fixtures/valid/derived-architecture-rule.yaml',
    kind: 'project_rule',
    id: 'RULE-DOMAIN-DEPENDENCY-001',
  },
  {
    path: 'fixtures/valid/assurance-profile.yaml',
    kind: 'assurance_profile',
    id: 'ASSURANCE-PROFILE-ORDER-SERVICE',
  },
  {
    path: 'fixtures/valid/change-assurance-plan.yaml',
    kind: 'assurance_plan',
    id: 'ASSURANCE-PLAN-ORDER-CANCELLATION',
  },
  {
    path: 'fixtures/valid/mutation-report-with-survivor.yaml',
    kind: 'mutation_report',
    id: 'MUTATION-REPORT-FEATURE-482',
  },
] as const;

const invalidFixtures = [
  {
    path: 'fixtures/invalid/unknown-schema-version.yaml',
    issuePath: '$.schema_version',
    code: 'unsupported_schema_version',
  },
  {
    path: 'fixtures/invalid/invalid-confidence.yaml',
    issuePath: '$.observations[0].confidence',
    code: 'too_big',
  },
  {
    path: 'fixtures/invalid/invalid-rule-level.yaml',
    issuePath: '$.level',
    code: 'invalid_value',
  },
  {
    path: 'fixtures/invalid/invalid-mutation-classification.yaml',
    issuePath: '$.survivors[0].classification',
    code: 'invalid_value',
  },
  {
    path: 'fixtures/invalid/expired-exception.yaml',
    issuePath: '$.exceptions.active_exceptions[0].expires_on',
    code: 'expired_exception',
  },
  {
    path: 'fixtures/invalid/current-position-as-foundational.yaml',
    issuePath: '$.maturity',
    code: 'invalid_value',
  },
  {
    path: 'fixtures/invalid/global-score-only-policy.yaml',
    issuePath: '$.mutation_policy.strategy',
    code: 'invalid_value',
  },
  {
    path: 'fixtures/invalid/review-level-3.yaml',
    issuePath: '$.human_review.level',
    code: 'invalid_union',
  },
] as const;

const loadValidArtifact = async (
  relativePath: string,
): Promise<CraftArtifact> =>
  parseArtifact(await readYamlArtifact(artifactPath(relativePath)), {
    now: VALIDATION_DATE,
  });

describe('versioned YAML artifacts', () => {
  it.each(validFixtures)(
    'validates $path as $kind',
    async ({ path: relativePath, kind, id }) => {
      const result = validateArtifact(
        await readYamlArtifact(artifactPath(relativePath)),
        { now: VALIDATION_DATE },
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.artifact.kind).toBe(kind);
        expect(result.artifact.id).toBe(id);
      }
    },
  );

  it.each(invalidFixtures)(
    'rejects $path at $issuePath',
    async ({ path: relativePath, issuePath, code }) => {
      const result = validateArtifact(
        await readYamlArtifact(artifactPath(relativePath)),
        { now: VALIDATION_DATE },
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: issuePath,
              code,
            }),
          ]),
        );
      }
    },
  );

  it.each(validFixtures)(
    'round-trips $path semantically and deterministically',
    async ({ path: relativePath }) => {
      const artifact = await loadValidArtifact(relativePath);
      const firstSerialization = serializeYamlArtifact(artifact);
      const secondSerialization = serializeYamlArtifact(artifact);
      const reparsed = parseArtifact(parse(firstSerialization), {
        now: VALIDATION_DATE,
      });

      expect(firstSerialization).toBe(secondSerialization);
      expect(reparsed).toEqual(artifact);
    },
  );

  it('preserves project and rule evidence references', async () => {
    const profile = (await loadValidArtifact(
      'fixtures/valid/java-spring-project-profile.yaml',
    )) as ProjectProfile;
    const rule = (await loadValidArtifact(
      'fixtures/valid/derived-architecture-rule.yaml',
    )) as ProjectRule;
    const roundTrippedProfile = parseArtifact(
      parse(serializeYamlArtifact(profile)),
      { now: VALIDATION_DATE },
    ) as ProjectProfile;
    const roundTrippedRule = parseArtifact(parse(serializeYamlArtifact(rule)), {
      now: VALIDATION_DATE,
    }) as ProjectRule;

    expect(roundTrippedProfile.observations[1]?.evidence).toEqual(
      profile.observations[1]?.evidence,
    );
    expect(roundTrippedRule.evidence).toEqual(rule.evidence);
    expect(roundTrippedRule.exceptions.active_exceptions[0]?.evidence).toEqual(
      rule.exceptions.active_exceptions[0]?.evidence,
    );
  });

  it.each([-0.01, 1.01])(
    'rejects confidence outside the inclusive range: %s',
    async (confidence) => {
      const profile = (await loadValidArtifact(
        'fixtures/valid/java-spring-project-profile.yaml',
      )) as ProjectProfile;
      const input = structuredClone(profile);
      const observation = input.observations[0];
      expect(observation).toBeDefined();
      if (observation === undefined) {
        return;
      }
      observation.confidence = confidence;

      const result = validateArtifact(input, { now: VALIDATION_DATE });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.path).toBe('$.observations[0].confidence');
      }
    },
  );

  it.each([0, 1, 2] as const)(
    'accepts supported Review Level %s',
    async (reviewLevel) => {
      const plan = await loadValidArtifact(
        'fixtures/valid/change-assurance-plan.yaml',
      );
      expect(plan.kind).toBe('assurance_plan');
      if (plan.kind !== 'assurance_plan') {
        return;
      }
      const input = structuredClone(plan);
      input.human_review.level = reviewLevel;

      const result = validateArtifact(input, { now: VALIDATION_DATE });

      expect(result.success).toBe(true);
    },
  );

  it('reports the supported Review Levels when Level 3 is rejected', async () => {
    const result = validateArtifact(
      await readYamlArtifact(
        artifactPath('fixtures/invalid/review-level-3.yaml'),
      ),
      { now: VALIDATION_DATE },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.human_review.level',
            message: 'Review level must be 0, 1, or 2',
          }),
        ]),
      );
    }
  });

  it('keeps the attributed current position separate from product interpretation', async () => {
    const position = await loadValidArtifact(
      'knowledge/current-positions/agent-written-code-review.yaml',
    );

    expect(position.kind).toBe('practice_statement');
    if (position.kind === 'practice_statement') {
      expect(position.maturity).toBe('current_position');
      expect(position.source_references[0]?.author).toBe('Robert C. Martin');
      expect(position.statement).not.toBe(position.product_interpretation);
      expect(position.product_interpretation).toContain('Review Levels 0');
    }
  });

  it.each(['missing', 'mismatched'] as const)(
    'rejects a current position with a %s author attribution',
    async (variant) => {
      const position = await loadValidArtifact(
        'knowledge/current-positions/agent-written-code-review.yaml',
      );
      expect(position.kind).toBe('practice_statement');
      if (position.kind !== 'practice_statement') {
        return;
      }
      const input = structuredClone(position);
      if (variant === 'missing') {
        delete input.author;
      } else {
        input.author = 'A different author';
      }

      const result = validateArtifact(input, { now: VALIDATION_DATE });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: '$.author',
              message:
                'A current position requires an author and a matching authored source reference',
            }),
          ]),
        );
      }
    },
  );

  it('keeps the eight fixtures connected without adding a registry abstraction', async () => {
    const artifacts = await Promise.all(
      validFixtures.map(({ path: relativePath }) =>
        loadValidArtifact(relativePath),
      ),
    );
    const ids = new Set(artifacts.map((artifact) => artifact.id));
    const rule = artifacts.find(
      (artifact): artifact is ProjectRule => artifact.kind === 'project_rule',
    );
    const profile = artifacts.find(
      (artifact): artifact is ProjectProfile =>
        artifact.kind === 'project_profile',
    );
    const assuranceArtifacts = artifacts.filter(
      (artifact) =>
        artifact.kind === 'assurance_profile' ||
        artifact.kind === 'assurance_plan',
    );

    expect(rule).toBeDefined();
    expect(profile).toBeDefined();
    expect(rule?.principle_refs.every((reference) => ids.has(reference))).toBe(
      true,
    );
    expect(
      assuranceArtifacts.every(
        (artifact) => artifact.project_ref === profile?.id,
      ),
    ).toBe(true);
  });

  it('rejects a blocking AI judgment without explicit human-decision evidence', async () => {
    const rule = (await loadValidArtifact(
      'fixtures/valid/derived-architecture-rule.yaml',
    )) as ProjectRule;
    const input = structuredClone(rule);
    input.enforcement = [
      {
        mechanism: 'ai_review',
        blocking: true,
        description: 'A subjective AI-only block.',
      },
    ];
    input.evidence = input.evidence.filter(
      (evidence) => evidence.type !== 'human_decision',
    );

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.issues.find(
        (candidate) =>
          candidate.path === '$.enforcement[0].authorization_decision_ref',
      );
      expect(issue?.message).toContain('matching human-decision evidence');
    }
  });

  it('rejects a mismatched blocking-AI authorization reference', async () => {
    const rule = (await loadValidArtifact(
      'fixtures/valid/derived-architecture-rule.yaml',
    )) as ProjectRule;
    const input = structuredClone(rule);
    input.enforcement = [
      {
        mechanism: 'ai_review',
        blocking: true,
        description: 'A subjectively evaluated block.',
        authorization_decision_ref: 'EV-NOT-THE-AUTHORIZATION',
      },
    ];

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.path).toBe(
        '$.enforcement[0].authorization_decision_ref',
      );
    }
  });

  it.each(['recommended', 'contextual', 'aspirational'] as const)(
    'rejects blocking enforcement for a %s outcome',
    async (level) => {
      const rule = (await loadValidArtifact(
        'fixtures/valid/derived-architecture-rule.yaml',
      )) as ProjectRule;
      const input: Record<string, unknown> = {
        ...structuredClone(rule),
        level,
      };

      const result = validateArtifact(input, { now: VALIDATION_DATE });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.message).toContain(
          'active rule at the mandatory level',
        );
      }
    },
  );

  it('rejects blocking enforcement on a candidate rule', async () => {
    const rule = (await loadValidArtifact(
      'fixtures/valid/derived-architecture-rule.yaml',
    )) as ProjectRule;
    const input: Record<string, unknown> = {
      ...structuredClone(rule),
      status: 'candidate',
    };

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.message).toContain(
        'active rule at the mandatory level',
      );
    }
  });

  it('requires decision observations to cite human-decision evidence', async () => {
    const profile = (await loadValidArtifact(
      'fixtures/valid/java-spring-project-profile.yaml',
    )) as ProjectProfile;
    const input = structuredClone(profile);
    const decision = input.observations[4];
    expect(decision?.type).toBe('decision');
    if (decision === undefined) {
      return;
    }
    decision.evidence[0] = {
      id: 'EV-ADR-MIGRATION',
      type: 'source_file',
      description: 'A file exists, but it is not evidence of authorization.',
      location: 'docs/decisions/architecture-migration.md',
    };

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.observations[4].evidence',
            message: 'A decision observation requires human-decision evidence',
          }),
        ]),
      );
    }
  });

  it('rejects duplicate observation identities', async () => {
    const profile = (await loadValidArtifact(
      'fixtures/valid/java-spring-project-profile.yaml',
    )) as ProjectProfile;
    const input = structuredClone(profile);
    const firstObservation = input.observations[0];
    expect(firstObservation).toBeDefined();
    if (firstObservation === undefined) {
      return;
    }
    input.observations.push(structuredClone(firstObservation));

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.observations[6].id',
            message: 'Observation IDs must be unique',
          }),
        ]),
      );
    }
  });

  it('rejects duplicate quality-gate identities', async () => {
    const plan = await loadValidArtifact(
      'fixtures/valid/change-assurance-plan.yaml',
    );
    expect(plan.kind).toBe('assurance_plan');
    if (plan.kind !== 'assurance_plan') {
      return;
    }
    const input = structuredClone(plan);
    const firstGate = input.required_gates[0];
    expect(firstGate).toBeDefined();
    if (firstGate === undefined) {
      return;
    }
    input.required_gates.push(structuredClone(firstGate));

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.required_gates[5].id',
            message: 'Quality gate requirement IDs must be unique',
          }),
        ]),
      );
    }
  });

  it('requires an exception reference for accepted mutation exceptions', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;
    const input = structuredClone(report);
    const survivor = input.survivors[0];
    expect(survivor).toBeDefined();
    if (survivor === undefined) {
      return;
    }
    survivor.classification_status = 'accepted_exception';

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.path).toBe('$.survivors[0].exception_ref');
    }
  });

  it('keeps equivalent mutants as candidates until human confirmation exists', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;
    const input = structuredClone(report);
    const survivor = input.survivors[0];
    expect(survivor).toBeDefined();
    if (survivor === undefined) {
      return;
    }
    survivor.classification = 'equivalent';
    survivor.classification_status = 'confirmed';

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.message).toContain('human-decision evidence');
    }
  });

  it('rejects duplicate survivor identities', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;
    const input = structuredClone(report);
    const survivor = input.survivors[0];
    expect(survivor).toBeDefined();
    if (survivor === undefined) {
      return;
    }
    input.survivors.push(structuredClone(survivor));
    input.totals.survived = 2;
    input.totals.generated = 51;

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.survivors[1].id',
            message: 'Surviving mutant IDs must be unique',
          }),
        ]),
      );
    }
  });

  it('rejects impossible baseline survivor counts', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;
    const input = structuredClone(report);
    expect(input.baseline_comparison).toBeDefined();
    if (input.baseline_comparison === undefined) {
      return;
    }
    input.baseline_comparison.new_survivors = 2;

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.path).toBe(
        '$.baseline_comparison.new_survivors',
      );
    }
  });

  it('correlates baseline counts with concrete survivor identities', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;

    expect(report.baseline_comparison).toMatchObject({
      new_survivors: 1,
      new_survivor_ids: ['MUTANT-CANCEL-140'],
      resolved_survivors: 0,
      resolved_survivor_ids: [],
    });
    expect(
      validateArtifact(structuredClone(report), { now: VALIDATION_DATE })
        .success,
    ).toBe(true);
  });

  it('rejects a baseline new-survivor reference absent from the report', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;
    const input = structuredClone(report);
    expect(input.baseline_comparison).toBeDefined();
    if (input.baseline_comparison === undefined) {
      return;
    }
    input.baseline_comparison.new_survivor_ids = ['MUTANT-NOT-CURRENT'];

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.baseline_comparison.new_survivor_ids[0]',
            message: 'A new survivor ID must identify a current survivor',
          }),
        ]),
      );
    }
  });

  it('rejects a resolved baseline survivor that remains current', async () => {
    const report = (await loadValidArtifact(
      'fixtures/valid/mutation-report-with-survivor.yaml',
    )) as MutationReport;
    const input = structuredClone(report);
    expect(input.baseline_comparison).toBeDefined();
    if (input.baseline_comparison === undefined) {
      return;
    }
    input.baseline_comparison.resolved_survivors = 1;
    input.baseline_comparison.resolved_survivor_ids = ['MUTANT-CANCEL-140'];

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$.baseline_comparison.resolved_survivor_ids[0]',
            message:
              'A resolved survivor ID cannot remain in current survivors',
          }),
        ]),
      );
    }
  });

  it('requires an exception reference when a gate is waived', () => {
    const result = QualityGateResultSchema.safeParse({
      requirement_id: 'GATE-MUTATION',
      status: 'waived',
      summary: 'The gate was waived without a linked exception.',
      evidence: [
        {
          id: 'EV-WAIVED-GATE',
          type: 'human_decision',
          description: 'A waiver decision exists but is not linked.',
          location: 'docs/waiver.md',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['exception_ref']);
    }
  });

  it('rejects unknown fields instead of silently dropping likely typos', async () => {
    const profile = await loadValidArtifact(
      'fixtures/valid/java-spring-project-profile.yaml',
    );
    const input: Record<string, unknown> = {
      ...structuredClone(profile),
      confidnce: 0.8,
    };

    const result = validateArtifact(input, { now: VALIDATION_DATE });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '$',
            code: 'unrecognized_keys',
          }),
        ]),
      );
    }
  });
});
