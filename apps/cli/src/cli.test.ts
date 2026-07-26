import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readYamlArtifact } from './artifact-file.js';
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
  return {
    output,
    errors,
    dependencies: {
      readArtifact: readYamlArtifact,
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

    const exitCode = await runCli(['scan'], harness.dependencies);

    expect(exitCode).toBe(2);
    expect(harness.errors).toEqual(['Usage: craft <validate|inspect> <path>']);
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
});
