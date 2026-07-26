import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  parseArtifact,
  type ProjectProfile,
  type ProjectRule,
} from '@craftcompass/domain';
import { FileSystemRepositoryScanner } from '@craftcompass/providers-filesystem';

import { readYamlArtifact, serializeYamlArtifact } from './artifact-file.js';
import { loadArtifactInputs } from './artifact-directory.js';
import { runCli, type CliDependencies } from './cli.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VALIDATION_DATE = new Date('2026-07-26T12:00:00.000Z');

interface CliHarness {
  readonly dependencies: CliDependencies;
  readonly output: string[];
  readonly errors: string[];
}

const createHarness = (): CliHarness => {
  const output: string[] = [];
  const errors: string[] = [];
  const scanner = new FileSystemRepositoryScanner();
  return {
    output,
    errors,
    dependencies: {
      readArtifact: readYamlArtifact,
      loadArtifacts: loadArtifactInputs,
      scanRepository: (path) => scanner.scan(path),
      serializeArtifact: serializeYamlArtifact,
      writeOut: (message) => output.push(message),
      writeError: (message) => errors.push(message),
      now: () => VALIDATION_DATE,
    },
  };
};

describe('craft CLI', () => {
  it('validates a detected artifact and reports its public identity', async () => {
    const harness = createHarness();
    const fixture = path.join(
      REPOSITORY_ROOT,
      'knowledge/principles/dependency-direction.yaml',
    );

    const exitCode = await runCli(['validate', fixture], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(harness.output).toEqual([
      'Valid craftsmanship_principle ARCH-DEPENDENCY-DIRECTION-001 (schema version 1)',
    ]);
  });

  it('prints a concise deterministic artifact summary', async () => {
    const harness = createHarness();
    const fixture = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/mutation-report-with-survivor.yaml',
    );

    const exitCode = await runCli(['inspect', fixture], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.output).toHaveLength(1);
    expect(harness.output[0]).toContain(
      'Mutation report MUTATION-REPORT-FEATURE-482',
    );
    expect(harness.output[0]).toContain('MUTANT-CANCEL-140=test_gap/candidate');
    expect(harness.output[0]).not.toContain('Zod');
  });

  it('returns non-zero and actionable paths for invalid input', async () => {
    const harness = createHarness();
    const fixture = path.join(
      REPOSITORY_ROOT,
      'fixtures/invalid/invalid-confidence.yaml',
    );

    const exitCode = await runCli(['validate', fixture], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.output).toEqual([]);
    expect(harness.errors.join('\n')).toContain('$.observations[0].confidence');
    expect(harness.errors.join('\n')).toContain('Confidence must be at most 1');
  });

  it('returns a usage error for unsupported command shapes', async () => {
    const harness = createHarness();

    const missingPathExitCode = await runCli(['scan'], harness.dependencies);
    const extraArgumentExitCode = await runCli(
      ['project', 'scan', '/repository', 'extra'],
      harness.dependencies,
    );

    expect(missingPathExitCode).toBe(2);
    expect(extraArgumentExitCode).toBe(2);
    expect(harness.errors).toEqual([
      [
        'Usage:',
        '  craft <validate|inspect> <artifact-path>',
        '  craft scan <repository-path>',
        '  craft project scan <repository-path>',
        '  craft registry validate <artifact-path>...',
        '  craft derive dependency-direction <project-id> <artifact-path>...',
      ].join('\n'),
      [
        'Usage:',
        '  craft <validate|inspect> <artifact-path>',
        '  craft scan <repository-path>',
        '  craft project scan <repository-path>',
        '  craft registry validate <artifact-path>...',
        '  craft derive dependency-direction <project-id> <artifact-path>...',
      ].join('\n'),
    ]);
  });

  it('reports file adapter errors without a stack trace', async () => {
    const harness = createHarness();
    const missingPath = path.join(REPOSITORY_ROOT, 'fixtures/missing.yaml');

    const exitCode = await runCli(
      ['validate', missingPath],
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.errors).toEqual([`Could not read ${missingPath}`]);
  });

  it.each([
    ['scan', 'fixtures/repositories/typescript-pnpm-service'],
    ['project scan', 'fixtures/repositories/java-spring-service'],
  ] as const)(
    'emits a valid evidence-linked profile for %s',
    async (command, relativePath) => {
      const harness = createHarness();
      const repository = path.join(REPOSITORY_ROOT, relativePath);
      const args =
        command === 'scan'
          ? ['scan', repository]
          : ['project', 'scan', repository];

      const exitCode = await runCli(args, harness.dependencies);

      expect(exitCode).toBe(0);
      expect(harness.errors).toEqual([]);
      expect(harness.output).toHaveLength(1);
      const profile = parseArtifact(parse(harness.output[0] ?? ''), {
        now: VALIDATION_DATE,
      }) as ProjectProfile;
      expect(profile.kind).toBe('project_profile');
      expect(profile.technologies.length).toBeGreaterThan(0);
      expect(harness.output[0]).not.toContain(repository);
    },
  );

  it('validates a cross-artifact registry with resolved references', async () => {
    const harness = createHarness();
    const principle = path.join(
      REPOSITORY_ROOT,
      'knowledge/principles/dependency-direction.yaml',
    );
    const project = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/java-spring-project-profile.yaml',
    );

    const exitCode = await runCli(
      ['registry', 'validate', project, principle],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(harness.output).toEqual([
      'Valid artifact registry: 2 artifacts; 4 supported references resolved',
    ]);
  });

  it('reports unresolved registry references with their origin and path', async () => {
    const harness = createHarness();
    const project = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/java-spring-project-profile.yaml',
    );
    const rule = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/derived-architecture-rule.yaml',
    );

    const exitCode = await runCli(
      ['registry', 'validate', project, rule],
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.output).toEqual([]);
    expect(harness.errors.join('\n')).toContain(
      '$.principle_refs[0]: Artifact reference ARCH-DEPENDENCY-DIRECTION-001 does not resolve',
    );
  });

  it('derives a deterministic non-blocking dependency-direction candidate', async () => {
    const harness = createHarness();
    const principle = path.join(
      REPOSITORY_ROOT,
      'knowledge/principles/dependency-direction.yaml',
    );
    const project = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/java-spring-project-profile.yaml',
    );

    const exitCode = await runCli(
      [
        'derive',
        'dependency-direction',
        'PROJECT-ORDER-SERVICE',
        principle,
        project,
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    const rule = parseArtifact(parse(harness.output[0] ?? ''), {
      now: VALIDATION_DATE,
    }) as ProjectRule;
    expect(rule.kind).toBe('project_rule');
    expect(rule.status).toBe('candidate');
    expect(rule.scope.existing_violations).toBe('baseline');
    expect(rule.scope.include).toEqual([
      'src/main/java/example/order/domain/**',
    ]);
    expect(rule.enforcement.every((requirement) => !requirement.blocking)).toBe(
      true,
    );
  });

  it.each([
    {
      fixture: 'new-business-service.yaml',
      projectId: 'PROJECT-PAYMENTS-NEW',
      level: 'mandatory',
      existingViolations: 'forbidden',
      include: ['src/payments/domain/**'],
    },
    {
      fixture: 'legacy-monolith.yaml',
      projectId: 'PROJECT-LEGACY-ORDERS',
      level: 'mandatory',
      existingViolations: 'baseline',
      include: ['src/main/java/example/orders/**'],
    },
    {
      fixture: 'intentionally-simple-tool.yaml',
      projectId: 'PROJECT-IMPORT-TOOL',
      level: 'contextual',
      existingViolations: 'allowed',
      include: ['**/*'],
    },
  ] as const)(
    'derives the $fixture scenario through the public YAML CLI path',
    async ({ fixture, projectId, level, existingViolations, include }) => {
      const harness = createHarness();
      const principle = path.join(
        REPOSITORY_ROOT,
        'knowledge/principles/dependency-direction.yaml',
      );
      const project = path.join(
        REPOSITORY_ROOT,
        'fixtures/derivation',
        fixture,
      );

      const exitCode = await runCli(
        ['derive', 'dependency-direction', projectId, principle, project],
        harness.dependencies,
      );

      expect(exitCode).toBe(0);
      expect(harness.errors).toEqual([]);
      const rule = parseArtifact(parse(harness.output[0] ?? ''), {
        now: VALIDATION_DATE,
      }) as ProjectRule;
      expect(rule).toMatchObject({
        kind: 'project_rule',
        project_ref: projectId,
        status: 'candidate',
        level,
        scope: {
          existing_violations: existingViolations,
          include,
        },
      });
      expect(
        rule.enforcement.every((requirement) => !requirement.blocking),
      ).toBe(true);
    },
  );
});
