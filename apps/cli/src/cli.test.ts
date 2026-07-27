import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import {
  checkAgentInstructionsFile,
  installAgentInstructionsFile,
} from './agent-instructions-file.js';
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
      readBytes: async (filePath, maximumBytes) => {
        const bytes = await readFile(filePath);
        if (bytes.byteLength > maximumBytes) {
          throw new Error(`Input exceeds ${maximumBytes} bytes`);
        }
        return bytes;
      },
      checkAgentInstructions: checkAgentInstructionsFile,
      installAgentInstructions: installAgentInstructionsFile,
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
    expect(harness.output[0]).toContain(
      'MUTANT-CANCEL-140=survived/test_gap/candidate',
    );
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
        '  craft assurance plan <plan-id> <project-id> <profile-id> <change-id> <impact-id> <artifact-path>...',
        '  craft instructions render <project-id> <profile-id> <artifact-path>...',
        '  craft instructions install <repository-root> <project-id> <profile-id> <artifact-path>...',
        '  craft instructions check <repository-root> <project-id> <profile-id> <artifact-path>...',
        '  craft mutation import-pit <report-id> <plan-id> <tool-version> <sha256:configuration> <execution-evidence-path> <mutations.xml> <artifact-path>...',
        '  craft mutation baseline create <baseline-id> <mutation-report-path>',
        '  craft mutation evaluate <report-id> <baseline-id|-> <profile-id> <artifact-path>...',
      ].join('\n'),
      [
        'Usage:',
        '  craft <validate|inspect> <artifact-path>',
        '  craft scan <repository-path>',
        '  craft project scan <repository-path>',
        '  craft registry validate <artifact-path>...',
        '  craft derive dependency-direction <project-id> <artifact-path>...',
        '  craft assurance plan <plan-id> <project-id> <profile-id> <change-id> <impact-id> <artifact-path>...',
        '  craft instructions render <project-id> <profile-id> <artifact-path>...',
        '  craft instructions install <repository-root> <project-id> <profile-id> <artifact-path>...',
        '  craft instructions check <repository-root> <project-id> <profile-id> <artifact-path>...',
        '  craft mutation import-pit <report-id> <plan-id> <tool-version> <sha256:configuration> <execution-evidence-path> <mutations.xml> <artifact-path>...',
        '  craft mutation baseline create <baseline-id> <mutation-report-path>',
        '  craft mutation evaluate <report-id> <baseline-id|-> <profile-id> <artifact-path>...',
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

  it('escapes terminal controls in dynamic file-error paths', async () => {
    const harness = createHarness();
    const hostilePath =
      '/ordinary/\u001b[31mred\nnext\u0085\u2028\u2029\u202e\u200e.yaml';

    const exitCode = await runCli(['validate', hostilePath], {
      ...harness.dependencies,
      readArtifact: (filePath) =>
        Promise.reject(new Error(`Could not read ${filePath}`)),
    });

    expect(exitCode).toBe(1);
    expect(harness.errors).toEqual([
      'Could not read /ordinary/\\u{1B}[31mred\\u{A}next\\u{85}\\u{2028}\\u{2029}\\u{202E}\\u{200E}.yaml',
    ]);
  });

  it('escapes terminal controls when reporting an invalid artifact path', async () => {
    const harness = createHarness();
    const hostilePath = '/ordinary/\u001b[2Jartifact\n\u2066.yaml';

    const exitCode = await runCli(['validate', hostilePath], {
      ...harness.dependencies,
      readArtifact: () => Promise.resolve({}),
    });

    expect(exitCode).toBe(1);
    expect(harness.errors[0]).toBe(
      'Invalid CraftCompass artifact: /ordinary/\\u{1B}[2Jartifact\\u{A}\\u{2066}.yaml',
    );
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

  it('escapes terminal controls in registry issue origins', async () => {
    const harness = createHarness();
    const project = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/java-spring-project-profile.yaml',
    );
    const rule = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/derived-architecture-rule.yaml',
    );
    const entries = await loadArtifactInputs(
      [project, rule],
      harness.dependencies.now(),
    );
    const hostileOrigin = '/ordinary/\u001b[2Jartifact\n\u202e.yaml';

    const exitCode = await runCli(['registry', 'validate', project, rule], {
      ...harness.dependencies,
      loadArtifacts: () =>
        Promise.resolve(
          entries.map((entry) => ({ ...entry, origin: hostileOrigin })),
        ),
    });

    expect(exitCode).toBe(1);
    expect(harness.errors[0]).toBe('Invalid CraftCompass artifact registry:');
    expect(harness.errors.slice(1)).not.toHaveLength(0);
    expect(harness.errors.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '/ordinary/\\u{1B}[2Jartifact\\u{A}\\u{202E}.yaml',
        ),
      ]),
    );
    expect(harness.errors.slice(1).join('')).not.toContain(
      String.fromCodePoint(0x1b),
    );
    expect(harness.errors.slice(1).join('')).not.toContain(
      String.fromCodePoint(0x202e),
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

  it('derives a change-specific assurance plan through validated artifacts', async () => {
    const harness = createHarness();
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);

    const exitCode = await runCli(
      [
        'assurance',
        'plan',
        'ASSURANCE-PLAN-CLI',
        'PROJECT-ORDER-SERVICE',
        'ASSURANCE-PROFILE-ORDER-SERVICE',
        'CHANGE-ORDER-CANCELLATION',
        'IMPACT-ORDER-CANCELLATION',
        valid('java-spring-project-profile.yaml'),
        valid('assurance-profile.yaml'),
        valid('change-context.yaml'),
        valid('change-impact.yaml'),
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    const artifact = parseArtifact(parse(harness.output[0] ?? ''), {
      now: VALIDATION_DATE,
    });
    expect(artifact).toMatchObject({
      kind: 'assurance_plan',
      id: 'ASSURANCE-PLAN-CLI',
      project_ref: 'PROJECT-ORDER-SERVICE',
      assurance_profile_ref: 'ASSURANCE-PROFILE-ORDER-SERVICE',
      change_context_ref: 'CHANGE-ORDER-CANCELLATION',
      impact_ref: 'IMPACT-ORDER-CANCELLATION',
      risk: {
        overall: 'high',
      },
    });
    if (artifact.kind === 'assurance_plan') {
      expect(
        artifact.required_gates.map((requirement) => requirement.type),
      ).toContain('mutation_tests');
      expect(artifact.mutation_scope?.primary_targets).toEqual([
        'example.order.domain.CancellationPolicy',
        'example.order.domain.OrderCancellationService',
      ]);
    }
  });

  it('renders deterministic managed agent instructions from a registry', async () => {
    const harness = createHarness();
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);

    const exitCode = await runCli(
      [
        'instructions',
        'render',
        'PROJECT-ORDER-SERVICE',
        'ASSURANCE-PROFILE-ORDER-SERVICE',
        path.join(
          REPOSITORY_ROOT,
          'knowledge/principles/dependency-direction.yaml',
        ),
        valid('java-spring-project-profile.yaml'),
        valid('assurance-profile.yaml'),
        valid('derived-architecture-rule.yaml'),
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(harness.output).toHaveLength(1);
    expect(harness.output[0]).toContain(
      '<!-- craftcompass-managed:agent-instructions version=1 project=PROJECT-ORDER-SERVICE',
    );
    expect(harness.output[0]).toContain('`RULE-DOMAIN-DEPENDENCY-001` — MUST:');
    expect(harness.output[0]).not.toContain(
      'Existing annotated types are retained',
    );
  });

  it('installs and checks managed agent instructions without overwriting human content', async () => {
    const harness = createHarness();
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-cli-instructions-'),
    );
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);
    const artifacts = [
      path.join(
        REPOSITORY_ROOT,
        'knowledge/principles/dependency-direction.yaml',
      ),
      valid('java-spring-project-profile.yaml'),
      valid('assurance-profile.yaml'),
      valid('derived-architecture-rule.yaml'),
    ];

    try {
      const installCode = await runCli(
        [
          'instructions',
          'install',
          repository,
          'PROJECT-ORDER-SERVICE',
          'ASSURANCE-PROFILE-ORDER-SERVICE',
          ...artifacts,
        ],
        harness.dependencies,
      );
      const checkCode = await runCli(
        [
          'instructions',
          'check',
          repository,
          'PROJECT-ORDER-SERVICE',
          'ASSURANCE-PROFILE-ORDER-SERVICE',
          ...artifacts,
        ],
        harness.dependencies,
      );

      expect(installCode).toBe(0);
      expect(checkCode).toBe(0);
      expect(harness.errors).toEqual([]);
      expect(harness.output[0]).toContain('Agent instructions created:');
      expect(harness.output[1]).toContain('Agent instructions current:');

      await writeFile(
        path.join(repository, 'AGENTS.md'),
        '# Human-owned instructions\n',
      );
      const refusedCode = await runCli(
        [
          'instructions',
          'install',
          repository,
          'PROJECT-ORDER-SERVICE',
          'ASSURANCE-PROFILE-ORDER-SERVICE',
          ...artifacts,
        ],
        harness.dependencies,
      );
      expect(refusedCode).toBe(1);
      expect(harness.errors.at(-1)).toContain(
        'refusing to overwrite human owned AGENTS.md',
      );
      expect(await readFile(path.join(repository, 'AGENTS.md'), 'utf8')).toBe(
        '# Human-owned instructions\n',
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('escapes terminal controls in installed instruction paths', async () => {
    const harness = createHarness();
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);
    const artifacts = [
      path.join(
        REPOSITORY_ROOT,
        'knowledge/principles/dependency-direction.yaml',
      ),
      valid('java-spring-project-profile.yaml'),
      valid('assurance-profile.yaml'),
      valid('derived-architecture-rule.yaml'),
    ];
    const hostilePath = '/ordinary/\u001b[2JAGENTS\n\u200e.md';

    const exitCode = await runCli(
      [
        'instructions',
        'install',
        '/repository',
        'PROJECT-ORDER-SERVICE',
        'ASSURANCE-PROFILE-ORDER-SERVICE',
        ...artifacts,
      ],
      {
        ...harness.dependencies,
        installAgentInstructions: () =>
          Promise.resolve({
            status: 'created',
            filePath: hostilePath,
            sha256: 'a'.repeat(64),
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(harness.output).toEqual([
      `Agent instructions created: /ordinary/\\u{1B}[2JAGENTS\\u{A}\\u{200E}.md (${'a'.repeat(64)})`,
    ]);
  });

  it('imports attested PIT XML into a lossless, scope-bound report', async () => {
    const harness = createHarness();
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);
    const xmlPath = 'fixtures/pitest/valid/all-killed.xml';

    const exitCode = await runCli(
      [
        'mutation',
        'import-pit',
        'MUTATION-REPORT-CLI',
        'ASSURANCE-PLAN-ORDER-CANCELLATION',
        '1.25.3',
        `sha256:${'a'.repeat(64)}`,
        'target/pit-reports/execution-configuration.json',
        xmlPath,
        valid('java-spring-project-profile.yaml'),
        valid('assurance-profile.yaml'),
        valid('change-assurance-plan.yaml'),
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    const artifact = parseArtifact(parse(harness.output[0] ?? ''), {
      now: VALIDATION_DATE,
    });
    expect(artifact).toMatchObject({
      kind: 'mutation_report',
      id: 'MUTATION-REPORT-CLI',
      provider: {
        id: 'pitest',
        tool_version: '1.25.3',
        normalization_version: 'pitest-xml-v1',
      },
      run: {
        completeness: 'complete',
      },
      totals: {
        generated: 1,
        killed: 1,
      },
    });
    if (artifact.kind === 'mutation_report') {
      expect(artifact.evidence[0]?.status).toBe('passed');
      expect(artifact.mutations[0]?.location).toEqual(
        expect.objectContaining({
          provider_source: 'OrderCancellationService.java',
        }),
      );
      expect(artifact.mutations[0]?.location.file).toBeUndefined();
    }
  });

  it('creates only an inert mutation-baseline candidate', async () => {
    const harness = createHarness();
    const report = path.join(
      REPOSITORY_ROOT,
      'fixtures/valid/mutation-report-with-survivor.yaml',
    );

    const exitCode = await runCli(
      ['mutation', 'baseline', 'create', 'MUTATION-BASELINE-CLI', report],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    const artifact = parseArtifact(parse(harness.output[0] ?? ''), {
      now: VALIDATION_DATE,
    });
    expect(artifact).toMatchObject({
      kind: 'mutation_baseline',
      id: 'MUTATION-BASELINE-CLI',
      status: 'candidate',
    });
    if (artifact.kind === 'mutation_baseline') {
      expect(artifact.activation).toBeUndefined();
      expect(artifact.entries.map((entry) => entry.id)).toEqual([
        'MUTANT-CANCEL-120',
        'MUTANT-CANCEL-140',
      ]);
    }
  });

  it('evaluates exact mutation debt without using a score', async () => {
    const harness = createHarness();
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);
    const loadArtifacts = harness.dependencies.loadArtifacts;
    let validationOptions: Parameters<CliDependencies['loadArtifacts']>[2];

    const exitCode = await runCli(
      [
        'mutation',
        'evaluate',
        'MUTATION-REPORT-ALL-KILLED',
        'MUTATION-BASELINE-ORDER-DOMAIN-ACTIVE',
        'ASSURANCE-PROFILE-ORDER-SERVICE',
        valid('java-spring-project-profile.yaml'),
        valid('assurance-profile.yaml'),
        valid('change-assurance-plan.yaml'),
        valid('mutation-report-all-killed.yaml'),
        valid('mutation-baseline-active.yaml'),
      ],
      {
        ...harness.dependencies,
        loadArtifacts: (paths, now, options) => {
          validationOptions = options;
          return loadArtifacts(paths, now, options);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(harness.errors).toEqual([]);
    expect(validationOptions).toEqual({
      preserveExpiredExceptions: true,
    });
    expect(harness.output[0]).toContain('Mutation policy: PASSED');
    expect(harness.output[0]).toContain('mutation_policy_satisfied');
    expect(harness.output[0]).not.toContain('score');
  });

  it('returns an inconclusive mutation decision when no active baseline exists', async () => {
    const harness = createHarness();
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);

    const exitCode = await runCli(
      [
        'mutation',
        'evaluate',
        'MUTATION-REPORT-ALL-KILLED',
        '-',
        'ASSURANCE-PROFILE-ORDER-SERVICE',
        valid('java-spring-project-profile.yaml'),
        valid('assurance-profile.yaml'),
        valid('change-assurance-plan.yaml'),
        valid('mutation-report-all-killed.yaml'),
      ],
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.errors).toEqual([]);
    expect(harness.output[0]).toContain('Mutation policy: INCONCLUSIVE');
    expect(harness.output[0]).toContain('baseline_missing');
  });

  it('rejects an active baseline whose source report is absent from the registry', async () => {
    const harness = createHarness();
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-cli-baseline-'),
    );
    const valid = (name: string): string =>
      path.join(REPOSITORY_ROOT, 'fixtures/valid', name);
    const forgedBaseline = path.join(
      temporaryDirectory,
      'forged-baseline.yaml',
    );

    try {
      await writeFile(
        forgedBaseline,
        (
          await readFile(valid('mutation-baseline-active.yaml'), 'utf8')
        ).replace(
          'source_report_ref: MUTATION-REPORT-ALL-KILLED',
          'source_report_ref: MUTATION-REPORT-MISSING',
        ),
      );

      const exitCode = await runCli(
        [
          'mutation',
          'evaluate',
          'MUTATION-REPORT-ALL-KILLED',
          'MUTATION-BASELINE-ORDER-DOMAIN-ACTIVE',
          'ASSURANCE-PROFILE-ORDER-SERVICE',
          valid('java-spring-project-profile.yaml'),
          valid('assurance-profile.yaml'),
          valid('change-assurance-plan.yaml'),
          valid('mutation-report-all-killed.yaml'),
          forgedBaseline,
        ],
        harness.dependencies,
      );

      expect(exitCode).toBe(1);
      expect(harness.output).toEqual([]);
      expect(harness.errors.join('\n')).toContain('MUTATION-REPORT-MISSING');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
