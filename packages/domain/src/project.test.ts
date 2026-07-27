import { describe, expect, it } from 'vitest';

import type { EvidenceReference } from './common.js';
import {
  ProjectModuleSchema,
  ProjectProfileSchema,
  type ProjectModule,
  type ProjectProfile,
  type RepositoryObservationCoverage,
} from './project.js';

const evidence = (id: string, location: string): EvidenceReference => ({
  id,
  type: 'build_configuration' as const,
  description: `Repository evidence from ${location}.`,
  location,
  provider: 'filesystem',
});

const moduleCandidate = (): Record<string, unknown> => ({
  name: 'application',
  path: 'application',
  status: 'candidate' as const,
  discovery: {
    basis: 'manifest_declaration' as const,
    selection: 'unconditional' as const,
  },
  responsibilities: [],
  evidence: [evidence('EV-MODULE-APPLICATION', 'pom.xml')],
});

const observationCoverage = (): Record<string, unknown> => ({
  status: 'complete_for_declared_scope' as const,
  provider: {
    id: 'filesystem',
    contract_version: '1',
  },
  capabilities: [
    {
      id: 'declared_modules',
      status: 'supported' as const,
    },
    {
      id: 'nested_build_roots',
      status: 'supported' as const,
    },
  ],
  inputs: [
    {
      path: '.' as const,
      kind: 'directory' as const,
      status: 'observed' as const,
      evidence: [evidence('EV-REPOSITORY-ROOT', '.')],
    },
    {
      path: 'pom.xml',
      kind: 'manifest' as const,
      status: 'parsed' as const,
      evidence: [evidence('EV-MAVEN-MANIFEST', 'pom.xml')],
    },
  ],
  limits: {
    max_declared_module_depth: 3,
    max_declared_module_declarations: 4_096,
    max_discovery_depth: 3,
    max_directories: 256,
    max_entries_per_directory: 512,
    max_manifests: 128,
    max_total_manifest_bytes: 16 * 1024 * 1024,
  },
  limitations: [],
});

const projectProfile = (): Record<string, unknown> => ({
  schema_version: 1 as const,
  kind: 'project_profile' as const,
  id: 'PROJECT-OBSERVATION-COVERAGE',
  name: 'Observation coverage fixture',
  technologies: [],
  modules: [moduleCandidate()],
  observations: [
    {
      id: 'OBS-REPOSITORY-MANIFEST',
      type: 'fact' as const,
      statement: 'A supported repository manifest was observed.',
      confidence: 1,
      evidence: [evidence('EV-MAVEN-MANIFEST', 'pom.xml')],
    },
  ],
  constraints: [],
  uncertainties: [],
  observation_coverage: observationCoverage(),
});

const parsedModuleCandidate = (): ProjectModule =>
  ProjectModuleSchema.parse(moduleCandidate());

const parsedProjectProfile = (): {
  readonly profile: ProjectProfile;
  readonly coverage: RepositoryObservationCoverage;
} => {
  const profile = ProjectProfileSchema.parse(projectProfile());
  if (profile.observation_coverage === undefined) {
    throw new Error('Expected observation coverage in the test fixture');
  }
  return {
    profile,
    coverage: profile.observation_coverage,
  };
};

describe('project observation provenance', () => {
  it('accepts provider-neutral module discovery and bounded coverage', () => {
    expect(ProjectProfileSchema.parse(projectProfile())).toMatchObject({
      modules: [
        {
          discovery: {
            basis: 'manifest_declaration',
            selection: 'unconditional',
          },
        },
      ],
      observation_coverage: {
        status: 'complete_for_declared_scope',
        provider: {
          id: 'filesystem',
          contract_version: '1',
        },
      },
    });
  });

  it.each(['default_candidate', 'conditional'] as const)(
    'requires context for %s module discovery',
    (selection) => {
      const module = parsedModuleCandidate();
      if (module.discovery === undefined) {
        throw new Error('Expected module discovery in the test fixture');
      }
      module.discovery.selection = selection;

      const result = ProjectModuleSchema.safeParse(module);

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected module discovery validation to fail');
      }
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['discovery', 'context'],
          }),
        ]),
      );
    },
  );

  it('accepts conditional module discovery with non-empty context', () => {
    const module = parsedModuleCandidate();
    module.discovery = {
      basis: 'manifest_declaration',
      selection: 'conditional',
      context: 'Declared by Maven profile release.',
    };

    expect(ProjectModuleSchema.safeParse(module).success).toBe(true);
  });

  it.each(['partial', 'unknown'] as const)(
    'requires limitations when observation coverage is %s',
    (status) => {
      const { profile, coverage } = parsedProjectProfile();
      coverage.status = status;

      const result = ProjectProfileSchema.safeParse(profile);

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected observation coverage validation to fail');
      }
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['observation_coverage', 'limitations'],
          }),
        ]),
      );
    },
  );

  it('accepts partial coverage when its limitation remains explicit', () => {
    const { profile, coverage } = parsedProjectProfile();
    coverage.status = 'partial';
    coverage.limitations = [
      'Nested manifests beyond the declared scan depth were not inspected.',
    ];

    expect(ProjectProfileSchema.safeParse(profile).success).toBe(true);
  });

  it.each([
    {
      label: 'has no capabilities',
      mutate: (coverage: RepositoryObservationCoverage) => {
        coverage.capabilities = [];
      },
      issuePath: ['observation_coverage', 'capabilities'],
    },
    {
      label: 'has a partial capability',
      mutate: (coverage: RepositoryObservationCoverage) => {
        const capability = coverage.capabilities[0];
        if (capability === undefined) {
          throw new Error('Expected a coverage capability');
        }
        capability.status = 'partial';
      },
      issuePath: ['observation_coverage', 'capabilities', 0, 'status'],
    },
    {
      label: 'has no inputs',
      mutate: (coverage: RepositoryObservationCoverage) => {
        coverage.inputs = [];
      },
      issuePath: ['observation_coverage', 'inputs'],
    },
    {
      label: 'has a failed input',
      mutate: (coverage: RepositoryObservationCoverage) => {
        const input = coverage.inputs[0];
        if (input === undefined) {
          throw new Error('Expected a coverage input');
        }
        input.status = 'failed';
      },
      issuePath: ['observation_coverage', 'inputs', 0, 'status'],
    },
    {
      label: 'retains a limitation',
      mutate: (coverage: RepositoryObservationCoverage) => {
        coverage.limitations = [
          'One input remains outside the declared scope.',
        ];
      },
      issuePath: ['observation_coverage', 'limitations'],
    },
  ])('rejects complete coverage that $label', ({ mutate, issuePath }) => {
    const { profile, coverage } = parsedProjectProfile();
    mutate(coverage);

    const result = ProjectProfileSchema.safeParse(profile);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected complete observation coverage to fail');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: issuePath,
        }),
      ]),
    );
  });

  it('allows coverage without filesystem traversal limits', () => {
    const { profile, coverage } = parsedProjectProfile();
    delete coverage.limits;

    expect(ProjectProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('rejects duplicate capability IDs and input paths', () => {
    const { profile, coverage } = parsedProjectProfile();
    const firstCapability = coverage.capabilities[0];
    const firstInput = coverage.inputs[0];
    if (firstCapability === undefined || firstInput === undefined) {
      throw new Error('Expected coverage fixture entries');
    }
    coverage.capabilities.push({
      ...firstCapability,
      status: 'unsupported',
    });
    coverage.inputs.push({
      ...firstInput,
      kind: 'configuration',
      status: 'unsupported',
      evidence: [evidence('EV-REPOSITORY-ROOT-DUPLICATE', '.')],
    });

    const result = ProjectProfileSchema.safeParse(profile);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected duplicate observation entries to fail');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['observation_coverage', 'capabilities', 2, 'id'],
        }),
        expect.objectContaining({
          path: ['observation_coverage', 'inputs', 2, 'path'],
        }),
      ]),
    );
  });

  it('rejects unsafe observation input paths and invalid limits', () => {
    const { profile, coverage } = parsedProjectProfile();
    if (coverage.limits === undefined) {
      throw new Error('Expected observation limits in the test fixture');
    }
    coverage.inputs[1] = {
      path: '../outside/pom.xml',
      kind: 'manifest',
      status: 'parsed',
      evidence: [evidence('EV-UNSAFE-MANIFEST', '../outside/pom.xml')],
    };
    coverage.limits.max_declared_module_declarations = -1;

    const result = ProjectProfileSchema.safeParse(profile);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected unsafe observation boundaries to fail');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['observation_coverage', 'inputs', 1, 'path'],
        }),
        expect.objectContaining({
          path: [
            'observation_coverage',
            'limits',
            'max_declared_module_declarations',
          ],
        }),
      ]),
    );
  });
});
