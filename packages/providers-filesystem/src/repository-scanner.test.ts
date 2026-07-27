import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createArtifactRegistry } from '@craftcompass/domain';

import {
  DEFAULT_REPOSITORY_SCAN_LIMITS,
  FileSystemRepositoryScanner,
  RepositoryScanError,
  type RepositoryFileSystem,
} from './repository-scanner.js';

const lstatRaceControl = vi.hoisted(() => ({
  afterObserved: undefined as (() => Promise<void>) | undefined,
  mode: undefined as 'missing' | 'present' | undefined,
  target: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const runRace = async (
    candidate: string,
    mode: 'missing' | 'present',
  ): Promise<void> => {
    if (
      candidate !== lstatRaceControl.target ||
      lstatRaceControl.mode !== mode ||
      lstatRaceControl.afterObserved === undefined
    ) {
      return;
    }
    const afterObserved = lstatRaceControl.afterObserved;
    lstatRaceControl.afterObserved = undefined;
    await afterObserved();
  };
  return {
    ...actual,
    lstat: async (candidate: string, options: { readonly bigint: true }) => {
      try {
        const state = await actual.lstat(candidate, options);
        await runRace(candidate, 'present');
        return state;
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          await runRace(candidate, 'missing');
        }
        throw error;
      }
    },
  };
});

const resetLstatRace = (): void => {
  lstatRaceControl.afterObserved = undefined;
  lstatRaceControl.mode = undefined;
  lstatRaceControl.target = undefined;
};

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePath = (name: string): string =>
  path.join(REPOSITORY_ROOT, 'fixtures/repositories', name);

const technologyNames = (
  profile: Awaited<ReturnType<FileSystemRepositoryScanner['scan']>>,
): string[] => profile.technologies.map((technology) => technology.name);

const writeText = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const simplePom = (
  artifactId: string,
  modules: readonly string[] = [],
): string => `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>${artifactId}</artifactId>
  ${
    modules.length === 0
      ? ''
      : `<modules>${modules
          .map((modulePath) => `<module>${modulePath}</module>`)
          .join('')}</modules>`
  }
</project>
`;

describe('FileSystemRepositoryScanner', () => {
  it('detects a Java Maven Spring project from declarations', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('java-spring-service'));

    expect(profile.id).toBe('PROJECT-ORDER-SERVICE');
    expect(profile.name).toBe('order-service');
    expect(technologyNames(profile)).toEqual(
      expect.arrayContaining([
        'Java',
        'Maven',
        'Spring Boot',
        'JUnit',
        'PIT',
        'JaCoCo',
        'ArchUnit',
      ]),
    );
    expect(
      profile.technologies.find((technology) => technology.name === 'Java')
        ?.version,
    ).toBe('21');
    expect(profile.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/main/java',
          discovery: {
            basis: 'source_layout',
            selection: 'unconditional',
          },
        }),
      ]),
    );
    expect(profile.observations[0]?.evidence[0]?.location).toBe('pom.xml');
    expect(
      profile.technologies.every(
        (technology) => technology.evidence.length > 0,
      ),
    ).toBe(true);
    expect(profile.observation_coverage).toEqual(
      expect.objectContaining({
        status: 'partial',
        provider: {
          id: 'filesystem',
          contract_version: '1.0.0',
        },
        limits: DEFAULT_REPOSITORY_SCAN_LIMITS,
      }),
    );
  });

  it('detects a different TypeScript pnpm technology profile', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('typescript-pnpm-service'));

    expect(profile.id).toBe('PROJECT-CATALOG-SERVICE');
    expect(technologyNames(profile)).toEqual(
      expect.arrayContaining([
        'TypeScript',
        'Node.js',
        'pnpm',
        'Express',
        'Vitest',
        'ESLint',
        'Prettier',
      ]),
    );
    expect(technologyNames(profile)).not.toContain('Java');
    expect(profile.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src',
          discovery: {
            basis: 'source_layout',
            selection: 'unconditional',
          },
        }),
      ]),
    );
  });

  it('composes a profile-bound Maven reactor and embedded frontend without inventing a root src module', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('multi-build-reactor'));

    expect(profile.name).toBe('multi-build-reactor');
    expect(technologyNames(profile)).toEqual(
      expect.arrayContaining([
        'Java',
        'Maven',
        'JUnit',
        'JaCoCo',
        'Spring Framework',
        'Spring Security',
        'npm',
        'TypeScript',
        'ESLint',
        'typescript-eslint',
        'Vitest',
        'Webpack',
        'Sass',
      ]),
    );
    expect(technologyNames(profile)).not.toEqual(
      expect.arrayContaining(['PIT', 'ArchUnit']),
    );
    expect(profile.modules.map((module) => module.path)).toEqual([
      'aggregate',
      'aggregate/child-a',
      'aggregate/child-b',
      'frontend',
      'optional',
      'service',
      'updater-scripts',
    ]);
    expect(profile.modules.map((module) => module.path)).not.toContain('src');
    for (const modulePath of [
      'aggregate',
      'aggregate/child-a',
      'aggregate/child-b',
      'service',
    ]) {
      const discovery = profile.modules.find(
        (module) => module.path === modulePath,
      )?.discovery;
      expect(discovery).toEqual(
        expect.objectContaining({
          basis: 'manifest_declaration',
          selection: 'default_candidate',
        }),
      );
      expect(discovery?.context).toContain('activeByDefault');
    }
    const optionalDiscovery = profile.modules.find(
      (module) => module.path === 'optional',
    )?.discovery;
    expect(optionalDiscovery).toEqual(
      expect.objectContaining({
        basis: 'manifest_declaration',
        selection: 'conditional',
      }),
    );
    expect(optionalDiscovery?.context).toContain('requires explicit');
    expect(
      profile.modules.find((module) => module.path === 'frontend')?.discovery,
    ).toEqual({
      basis: 'manifest_presence',
      selection: 'unknown',
    });
    expect(
      profile.modules.find((module) => module.path === 'updater-scripts')
        ?.discovery,
    ).toEqual({
      basis: 'manifest_presence',
      selection: 'unknown',
    });
    expect(
      profile.technologies
        .find((technology) => technology.name === 'JaCoCo')
        ?.evidence.map((evidence) => evidence.location),
    ).toEqual(['service/pom.xml']);
    expect(profile.observation_coverage?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'frontend/package.json',
          status: 'parsed',
        }),
        expect.objectContaining({
          path: 'frontend/package-lock.json',
          kind: 'lockfile',
          status: 'observed',
        }),
        expect.objectContaining({
          path: 'frontend/tsconfig.json',
          kind: 'configuration',
          status: 'observed',
        }),
      ]),
    );
    expect(profile.observation_coverage?.status).toBe('partial');
    expect(profile.observation_coverage?.limitations.length).toBeGreaterThan(0);
    expect(profile.observation_coverage?.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[DISCOVERY-EXCLUSIONS]'),
      ]),
    );
    expect(
      profile.uncertainties.some(
        (uncertainty) =>
          uncertainty.id === 'UNCERTAINTY-REPOSITORY-OBSERVATION-COVERAGE',
      ),
    ).toBe(true);
    expect(
      createArtifactRegistry([
        {
          origin: 'multi-build-scan',
          artifact: profile,
        },
      ]),
    ).toEqual(expect.objectContaining({ success: true }));
  });

  it('links inferred language facts to the files that actually support them', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const typescriptProfile = await scanner.scan(fixturePath('tsconfig-only'));
    const javaProfile = await scanner.scan(fixturePath('java-source-only'));

    expect(
      typescriptProfile.technologies
        .find((technology) => technology.name === 'TypeScript')
        ?.evidence.map((evidence) => evidence.location),
    ).toEqual(['tsconfig.json']);
    expect(
      javaProfile.technologies
        .find((technology) => technology.name === 'Java')
        ?.evidence.map((evidence) => evidence.location),
    ).toEqual(['src/main/java']);
  });

  it('requires trusted Maven group and artifact coordinates for technology claims', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(
      fixturePath('maven-coordinate-lookalikes'),
    );

    expect(technologyNames(profile)).toEqual(['Maven']);
  });

  it('does not classify dependencyManagement or pluginManagement declarations as active', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('multi-build-reactor'));
    const pit = profile.technologies.find(
      (technology) => technology.name === 'PIT',
    );
    const archUnit = profile.technologies.find(
      (technology) => technology.name === 'ArchUnit',
    );

    expect(pit).toBeUndefined();
    expect(archUnit).toBeUndefined();
  });

  it('keeps unsupported and conflicting package-manager evidence uncertain per build root', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const unsupportedProfile = await scanner.scan(
      fixturePath('package-manager-conflict'),
    );
    const conflictingProfile = await scanner.scan(
      fixturePath('package-manager-multiple-locks'),
    );

    expect(technologyNames(unsupportedProfile)).not.toEqual(
      expect.arrayContaining(['npm', 'pnpm', 'Yarn']),
    );
    expect(
      unsupportedProfile.uncertainties.some(
        (uncertainty) =>
          uncertainty.id.endsWith('-MANAGER-DECLARATION') &&
          uncertainty.resolution_required,
      ),
    ).toBe(true);
    expect(technologyNames(conflictingProfile)).not.toEqual(
      expect.arrayContaining(['npm', 'pnpm', 'Yarn']),
    );
    const conflict = conflictingProfile.uncertainties.find((uncertainty) =>
      uncertainty.id.endsWith('-MANAGER-CONFLICT'),
    );
    expect(conflict?.evidence.map((evidence) => evidence.location)).toEqual([
      'package-lock.json',
      'package.json',
      'yarn.lock',
    ]);
  });

  it('keeps normalized missing Maven declarations distinct and excludes them from the module map', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(
      fixturePath('maven-module-normalization'),
    );
    const moduleUncertainties = profile.uncertainties.filter((uncertainty) =>
      uncertainty.id.startsWith('UNCERTAINTY-MAVEN-MODULE-'),
    );

    expect(profile.modules).toEqual([]);
    expect(moduleUncertainties).toHaveLength(5);
    expect(new Set(moduleUncertainties.map((item) => item.id)).size).toBe(5);
    expect(
      moduleUncertainties.map((item) => item.statement).join('\n'),
    ).toContain('foo/../bar');
    expect(
      moduleUncertainties.map((item) => item.statement).join('\n'),
    ).toContain('foo-bar');
    expect(
      moduleUncertainties.map((item) => item.statement).join('\n'),
    ).toContain('foo/bar');
  });

  it('is stable and never leaks the absolute repository path', async () => {
    const scanner = new FileSystemRepositoryScanner();
    const repository = fixturePath('multi-build-reactor');

    const first = await scanner.scan(repository);
    const second = await scanner.scan(repository);
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    expect(serialized).not.toContain(repository);
    expect(
      first.observation_coverage?.inputs.map((input) => input.path),
    ).toEqual(
      [...(first.observation_coverage?.inputs ?? [])]
        .map((input) => input.path)
        .sort(),
    );
  });

  it('returns explicit partial evidence and uncertainty for unknown projects', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('unknown-project'));

    expect(technologyNames(profile)).toEqual([]);
    expect(profile.modules).toEqual([]);
    expect(profile.observations[0]?.statement).toContain('without recognizing');
    expect(profile.observation_coverage?.status).toBe('partial');
    expect(profile.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'UNCERTAINTY-PROJECT-TECHNOLOGY',
          resolution_required: false,
        }),
        expect.objectContaining({
          id: 'UNCERTAINTY-REPOSITORY-OBSERVATION-COVERAGE',
        }),
      ]),
    );
  });

  it('keeps malformed Maven input visible without inventing Maven or Java facts', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('malformed-maven'));

    expect(profile.technologies).toEqual([]);
    expect(
      profile.uncertainties.some(
        (uncertainty) =>
          uncertainty.id.startsWith('UNCERTAINTY-MAVEN-MANIFEST-') &&
          uncertainty.resolution_required,
      ),
    ).toBe(true);
    expect(
      profile.observation_coverage?.inputs.find(
        (input) => input.path === 'pom.xml',
      )?.status,
    ).toBe('failed');
  });

  it('rejects Maven DOCTYPE declarations without processing entities', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('doctype-maven'));

    expect(profile.technologies).toEqual([]);
    expect(
      profile.uncertainties.find((uncertainty) =>
        uncertainty.id.startsWith('UNCERTAINTY-MAVEN-MANIFEST-'),
      )?.evidence[0]?.description,
    ).toContain('must not contain a DOCTYPE');
  });

  it('bounds long Maven property-reference chains without exhausting the stack', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-maven-property-chain-'),
    );
    try {
      const propertyCount = 12_000;
      const chainedProperties = Array.from(
        { length: propertyCount },
        (_value, index) => {
          const name = `p${index}`;
          const value =
            index === propertyCount - 1 ? '17' : `\${p${index + 1}}`;
          return `<${name}>${value}</${name}>`;
        },
      ).join('');
      await writeText(
        repository,
        'pom.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>long-property-chain</artifactId>
  <properties>
    <java.version>\${p0}</java.version>
    ${chainedProperties}
  </properties>
</project>`,
      );

      const profile = await new FileSystemRepositoryScanner().scan(repository);

      expect(technologyNames(profile)).toContain('Maven');
      expect(technologyNames(profile)).not.toContain('Java');
      expect(
        profile.observation_coverage?.inputs.find(
          (input) => input.path === 'pom.xml',
        )?.status,
      ).toBe('parsed');
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('rejects Maven module paths that escape the repository root', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('unsafe-maven-module'));

    expect(profile.modules).toEqual([]);
    const uncertainty = profile.uncertainties.find((item) =>
      item.id.startsWith('UNCERTAINTY-MAVEN-MODULE-'),
    );
    expect(uncertainty?.statement).toContain('../outside-repository');
    expect(uncertainty?.resolution_required).toBe(true);
  });

  it('detects recursive Maven module cycles without recurring indefinitely', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-maven-cycle-'),
    );
    try {
      await writeText(repository, 'pom.xml', simplePom('cycle-root', ['a']));
      await writeText(repository, 'a/pom.xml', simplePom('a', ['../b']));
      await writeText(repository, 'b/pom.xml', simplePom('b', ['../a']));

      const profile = await new FileSystemRepositoryScanner().scan(repository, {
        id: 'PROJECT-CYCLE',
        name: 'cycle',
      });

      expect(profile.modules.map((module) => module.path)).toEqual(['a', 'b']);
      expect(
        profile.uncertainties.some((uncertainty) =>
          uncertainty.id.startsWith('UNCERTAINTY-MAVEN-MODULE-CYCLE-'),
        ),
      ).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('keeps duplicate unconditional and profile-bound declarations distinct without conflicting evidence IDs', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-duplicate-module-context-'),
    );
    try {
      await writeText(
        repository,
        'pom.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>duplicate-context</artifactId>
  <modules><module>child</module></modules>
  <profiles>
    <profile>
      <id>default</id>
      <activation><activeByDefault>true</activeByDefault></activation>
      <modules><module>child</module></modules>
    </profile>
  </profiles>
</project>`,
      );
      await writeText(repository, 'child/pom.xml', simplePom('child'));

      const profile = await new FileSystemRepositoryScanner().scan(repository);
      const child = profile.modules.find((module) => module.path === 'child');

      expect(child?.discovery).toEqual({
        basis: 'manifest_declaration',
        selection: 'unconditional',
      });
      expect(new Set(child?.evidence.map((evidence) => evidence.id)).size).toBe(
        child?.evidence.length,
      );
      expect(
        createArtifactRegistry([
          { origin: 'duplicate-context', artifact: profile },
        ]),
      ).toEqual(expect.objectContaining({ success: true }));
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('does not treat a permission failure as a missing manifest', async () => {
    const permissionFailure = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const root = '/virtual/repository';
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) => {
        if (candidate === root) {
          return Promise.resolve({
            kind: 'directory',
            size: 0,
            identity: 'root',
          });
        }
        if (candidate === `${root}/package.json`) {
          return Promise.resolve({
            kind: 'file',
            size: 20,
            identity: 'package',
          });
        }
        return Promise.resolve(undefined);
      },
      readBoundedText: () => Promise.reject(permissionFailure),
      list: () => Promise.resolve([]),
    };
    const scanner = new FileSystemRepositoryScanner(fileSystem);

    await expect(scanner.scan(root)).rejects.toEqual(
      expect.objectContaining<Partial<RepositoryScanError>>({
        name: 'RepositoryScanError',
        code: 'manifest_read_failed',
        message: 'Could not read repository manifest: package.json',
        cause: permissionFailure,
      }),
    );
  });

  it.each([
    {
      name: 'TypeScript configuration',
      manifest: 'package.json',
      probe: 'tsconfig.json',
      source: '{"name":"example","dependencies":{}}',
    },
    {
      name: 'package-manager lockfile',
      manifest: 'package.json',
      probe: 'package-lock.json',
      source: '{"name":"example","dependencies":{}}',
    },
    {
      name: 'Java source root',
      manifest: 'pom.xml',
      probe: 'src/main/java',
      source:
        '<project><modelVersion>4.0.0</modelVersion><artifactId>example</artifactId></project>',
    },
  ])(
    'propagates a filesystem failure while probing $name',
    async ({ manifest, probe, source }) => {
      const permissionFailure = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      const root = '/virtual/repository';
      const fileSystem: RepositoryFileSystem = {
        canonicalize: () => Promise.resolve(root),
        inspect: (_scanRoot, candidate) => {
          if (candidate === root) {
            return Promise.resolve({
              kind: 'directory',
              size: 0,
              identity: 'root',
            });
          }
          if (candidate === `${root}/${manifest}`) {
            return Promise.resolve({
              kind: 'file',
              size: source.length,
              identity: manifest,
            });
          }
          if (candidate === `${root}/${probe}`) {
            return Promise.reject(permissionFailure);
          }
          return Promise.resolve(undefined);
        },
        readBoundedText: () => Promise.resolve(source),
        list: () => Promise.resolve([]),
      };
      const scanner = new FileSystemRepositoryScanner(fileSystem);

      await expect(scanner.scan(root)).rejects.toEqual(
        expect.objectContaining<Partial<RepositoryScanError>>({
          name: 'RepositoryScanError',
          code: 'filesystem_inspection_failed',
          message: `Could not inspect repository path: ${probe}`,
          cause: permissionFailure,
        }),
      );
    },
  );

  it('rejects oversized manifests before reading their contents with a stable code', async () => {
    let attemptedRead = false;
    const root = '/virtual/repository';
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) =>
        Promise.resolve(
          candidate === root
            ? { kind: 'directory', size: 0, identity: 'root' }
            : candidate === `${root}/package.json`
              ? {
                  kind: 'file',
                  size: 2 * 1024 * 1024 + 1,
                  identity: 'package',
                }
              : undefined,
        ),
      readBoundedText: () => {
        attemptedRead = true;
        return Promise.resolve('{}');
      },
      list: () => Promise.resolve([]),
    };
    const scanner = new FileSystemRepositoryScanner(fileSystem);

    await expect(scanner.scan(root)).rejects.toEqual(
      expect.objectContaining({
        code: 'manifest_too_large',
        message: 'Manifest exceeds 2097152 bytes: package.json',
      }),
    );
    expect(attemptedRead).toBe(false);
  });

  it('rejects malformed UTF-8 in a real repository manifest', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-malformed-manifest-'),
    );
    try {
      await writeFile(
        path.join(repository, 'package.json'),
        Uint8Array.from([
          0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0xc3, 0x28,
        ]),
      );

      await expect(
        new FileSystemRepositoryScanner().scan(repository),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'manifest_invalid_utf8',
        }),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('refuses to follow final supported-manifest symlinks', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-manifest-symlink-'),
    );
    try {
      await writeText(repository, 'actual-package.json', '{"name":"actual"}');
      await symlink(
        path.join(repository, 'actual-package.json'),
        path.join(repository, 'package.json'),
      );

      await expect(
        new FileSystemRepositoryScanner().scan(repository),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'input_symlink',
          message: 'Refusing to follow manifest symlink: package.json',
        }),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('refuses declared modules whose path contains a symlinked ancestor', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-ancestor-symlink-'),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-ancestor-outside-'),
    );
    try {
      await writeText(
        repository,
        'pom.xml',
        simplePom('ancestor-root', ['linked/child']),
      );
      await writeText(outside, 'child/pom.xml', simplePom('outside-child'));
      await symlink(outside, path.join(repository, 'linked'));

      await expect(
        new FileSystemRepositoryScanner().scan(repository),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'path_symlink',
        }),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when an ancestor changes during a filesystem inspection', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-inspection-race-'),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-inspection-race-outside-'),
    );
    const nested = path.join(repository, 'nested');
    const movedNested = path.join(repository, 'nested-before-swap');
    try {
      await writeText(repository, 'nested/package.json', '{"name":"inside"}');
      await writeText(outside, 'package.json', '{"name":"outside"}');
      lstatRaceControl.target = await realpath(
        path.join(nested, 'package.json'),
      );
      lstatRaceControl.mode = 'present';
      lstatRaceControl.afterObserved = async () => {
        await rename(nested, movedNested);
        await symlink(outside, nested);
      };

      await expect(
        new FileSystemRepositoryScanner().scan(repository),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'directory_changed',
        }),
      );
      expect(lstatRaceControl.afterObserved).toBeUndefined();
    } finally {
      resetLstatRace();
      await rm(repository, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when a missing path appears before absence is accepted', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-missing-input-race-'),
    );
    try {
      lstatRaceControl.target = path.join(
        await realpath(repository),
        'package.json',
      );
      lstatRaceControl.mode = 'missing';
      lstatRaceControl.afterObserved = () =>
        writeText(repository, 'package.json', '{"name":"created-during-scan"}');

      await expect(
        new FileSystemRepositoryScanner().scan(repository),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'directory_changed',
        }),
      );
      expect(lstatRaceControl.afterObserved).toBeUndefined();
    } finally {
      resetLstatRace();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('propagates a bounded no-follow read refusal after a manifest swap', async () => {
    const root = '/virtual/repository';
    let receivedLimit: number | undefined;
    const swapFailure = new RepositoryScanError(
      'manifest_changed',
      'Manifest changed before its bounded read completed',
    );
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) =>
        Promise.resolve(
          candidate === root
            ? { kind: 'directory', size: 0, identity: 'root' }
            : candidate === `${root}/package.json`
              ? { kind: 'file', size: 20, identity: 'package' }
              : undefined,
        ),
      readBoundedText: (_scanRoot, _candidate, maxBytes) => {
        receivedLimit = maxBytes;
        return Promise.reject(swapFailure);
      },
      list: () => Promise.resolve([]),
    };
    const scanner = new FileSystemRepositoryScanner(fileSystem);

    await expect(scanner.scan(root)).rejects.toBe(swapFailure);
    expect(receivedLimit).toBe(2 * 1024 * 1024);
  });

  it('rejects an oversized directory without consuming an order-dependent prefix', async () => {
    const root = '/virtual/repository';
    let requestedLimit: number | undefined;
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) =>
        Promise.resolve(
          candidate === root
            ? { kind: 'directory', size: 0, identity: 'root' }
            : undefined,
        ),
      readBoundedText: () => Promise.reject(new Error('unexpected read')),
      list: (_scanRoot, _candidate, maxEntries) => {
        requestedLimit = maxEntries;
        return Promise.resolve(
          Array.from({ length: maxEntries + 1 }, (_value, index) => ({
            name: `entry-${String(index).padStart(5, '0')}`,
            kind: 'directory' as const,
          })).reverse(),
        );
      },
    };

    await expect(
      new FileSystemRepositoryScanner(fileSystem).scan(root),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'directory_entry_limit_exceeded',
      }),
    );
    expect(requestedLimit).toBe(
      DEFAULT_REPOSITORY_SCAN_LIMITS.max_entries_per_directory,
    );
  });

  it('caps considered declared manifests and candidate-module output', async () => {
    const root = '/virtual/repository';
    const moduleNames = Array.from(
      { length: DEFAULT_REPOSITORY_SCAN_LIMITS.max_entries_per_directory },
      (_value, index) => `module-${String(index).padStart(4, '0')}`,
    );
    const rootPom = simplePom('bounded-root', moduleNames);
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) => {
        if (candidate === root) {
          return Promise.resolve({
            kind: 'directory',
            size: 0,
            identity: 'root',
          });
        }
        if (candidate === `${root}/pom.xml`) {
          return Promise.resolve({
            kind: 'file',
            size: rootPom.length,
            identity: 'root-pom',
          });
        }
        if (/\/module-\d{4}$/u.test(candidate)) {
          return Promise.resolve({
            kind: 'directory',
            size: 0,
            identity: candidate,
          });
        }
        if (/\/module-\d{4}\/pom\.xml$/u.test(candidate)) {
          return Promise.resolve({
            kind: 'file',
            size: 100,
            identity: candidate,
          });
        }
        return Promise.resolve(undefined);
      },
      readBoundedText: (_scanRoot, candidate) =>
        Promise.resolve(
          candidate === `${root}/pom.xml`
            ? rootPom
            : simplePom(path.basename(path.dirname(candidate))),
        ),
      list: () => Promise.resolve([]),
    };

    const profile = await new FileSystemRepositoryScanner(fileSystem).scan(
      root,
    );

    expect(profile.modules).toHaveLength(
      DEFAULT_REPOSITORY_SCAN_LIMITS.max_manifests,
    );
    expect(
      profile.observation_coverage?.inputs.filter(
        (input) => input.kind === 'manifest',
      ).length,
    ).toBeLessThanOrEqual(DEFAULT_REPOSITORY_SCAN_LIMITS.max_manifests);
    expect(profile.observation_coverage?.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining('[MODULE-LIMIT]')]),
    );
  });

  it('caps Maven declaration processing across recursive manifests', async () => {
    const root = '/virtual/repository';
    const repeatedModules = (modulePath: string): readonly string[] =>
      Array.from(
        {
          length:
            DEFAULT_REPOSITORY_SCAN_LIMITS.max_declared_module_declarations / 2,
        },
        () => modulePath,
      );
    const rootPom = simplePom('root', repeatedModules('a'));
    const childPom = simplePom('a', repeatedModules('b'));
    const grandchildPom = simplePom('b', repeatedModules('missing-module'));
    const manifests = new Map([
      [`${root}/pom.xml`, rootPom],
      [`${root}/a/pom.xml`, childPom],
      [`${root}/a/b/pom.xml`, grandchildPom],
    ]);
    const directories = new Set([root, `${root}/a`, `${root}/a/b`]);
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) => {
        const manifest = manifests.get(candidate);
        if (manifest !== undefined) {
          return Promise.resolve({
            kind: 'file',
            size: manifest.length,
            identity: candidate,
          });
        }
        return Promise.resolve(
          directories.has(candidate)
            ? { kind: 'directory', size: 0, identity: candidate }
            : undefined,
        );
      },
      readBoundedText: (_scanRoot, candidate) =>
        Promise.resolve(manifests.get(candidate) ?? ''),
      list: () => Promise.resolve([]),
    };

    const profile = await new FileSystemRepositoryScanner(fileSystem).scan(
      root,
    );

    expect(profile.modules.map((module) => module.path)).toEqual(['a', 'a/b']);
    expect(profile.observation_coverage?.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[DECLARED-MODULE-LIMIT]'),
      ]),
    );
  });

  it('rejects overlong Maven scalar values as malformed input', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-long-maven-scalar-'),
    );
    try {
      await writeText(
        repository,
        'pom.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>long-scalar</artifactId>
  <profiles>
    <profile>
      <id>${'x'.repeat(4_097)}</id>
      <modules><module>conditional-child</module></modules>
    </profile>
  </profiles>
</project>`,
      );

      const profile = await new FileSystemRepositoryScanner().scan(repository);
      const pomInput = profile.observation_coverage?.inputs.find(
        (input) => input.path === 'pom.xml',
      );

      expect(pomInput?.status).toBe('failed');
      expect(pomInput?.evidence[0]?.description).toContain(
        'Manifest scalar exceeds 4096 characters.',
      );
      expect(profile.modules).toEqual([]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('rejects a Maven manifest whose aggregate module declarations exceed the parser bound', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-maven-module-parser-bound-'),
    );
    try {
      const topLevelModules = Array.from(
        { length: 2_048 },
        (_value, index) => `top-${String(index).padStart(4, '0')}`,
      );
      await writeText(
        repository,
        'pom.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>parser-bound</artifactId>
  <modules>${topLevelModules
    .map((modulePath) => `<module>${modulePath}</module>`)
    .join('')}</modules>
  <profiles>
    <profile>
      <id>one-too-many</id>
      <modules><module>profile-child</module></modules>
    </profile>
  </profiles>
</project>`,
      );

      const profile = await new FileSystemRepositoryScanner().scan(repository);
      const pomInput = profile.observation_coverage?.inputs.find(
        (input) => input.path === 'pom.xml',
      );

      expect(pomInput?.status).toBe('failed');
      expect(pomInput?.evidence[0]?.description).toContain(
        'Maven modules exceeds 2048 declarations.',
      );
      expect(profile.modules).toEqual([]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('stops free discovery at the configured depth and records the limitation', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-discovery-depth-'),
    );
    try {
      await writeText(
        repository,
        'one/two/three/four/package.json',
        '{"name":"too-deep","devDependencies":{"vitest":"4.1.0"}}',
      );

      const profile = await new FileSystemRepositoryScanner().scan(repository, {
        id: 'PROJECT-DEPTH',
        name: 'depth',
      });

      expect(technologyNames(profile)).not.toContain('Vitest');
      expect(
        profile.observation_coverage?.inputs.some((input) =>
          input.path.endsWith('package.json'),
        ),
      ).toBe(false);
      expect(profile.observation_coverage?.limitations).toEqual(
        expect.arrayContaining([expect.stringContaining('[DISCOVERY-DEPTH]')]),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('visits shallow discovery candidates before lexicographically earlier descendants', async () => {
    const root = '/virtual/repository';
    const listedPaths: string[] = [];
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) =>
        Promise.resolve(
          candidate === root
            ? { kind: 'directory', size: 0, identity: 'root' }
            : undefined,
        ),
      readBoundedText: () => Promise.reject(new Error('unexpected read')),
      list: (_scanRoot, candidate) => {
        listedPaths.push(candidate);
        if (candidate === root) {
          return Promise.resolve([
            { name: 'a', kind: 'directory' },
            { name: 'z', kind: 'directory' },
          ]);
        }
        if (candidate === `${root}/a`) {
          return Promise.resolve([{ name: 'a', kind: 'directory' }]);
        }
        return Promise.resolve([]);
      },
    };

    await new FileSystemRepositoryScanner(fileSystem).scan(root);

    expect(listedPaths.slice(0, 4)).toEqual([
      root,
      `${root}/a`,
      `${root}/z`,
      `${root}/a/a`,
    ]);
  });

  it('emits identical output regardless of directory creation order', async () => {
    const firstRepository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-order-first-'),
    );
    const secondRepository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-order-second-'),
    );
    try {
      const files = [
        [
          'zeta/package.json',
          '{"name":"zeta","devDependencies":{"vitest":"4.1.0"}}',
        ],
        [
          'alpha/package.json',
          '{"name":"alpha","devDependencies":{"eslint":"9.0.0"}}',
        ],
        ['middle/pom.xml', simplePom('middle')],
      ] as const;
      for (const [relativePath, content] of files) {
        await writeText(firstRepository, relativePath, content);
      }
      for (const [relativePath, content] of [...files].reverse()) {
        await writeText(secondRepository, relativePath, content);
      }

      const scanner = new FileSystemRepositoryScanner();
      const first = await scanner.scan(firstRepository, {
        id: 'PROJECT-ORDER',
        name: 'order',
      });
      const second = await scanner.scan(secondRepository, {
        id: 'PROJECT-ORDER',
        name: 'order',
      });

      expect(second).toEqual(first);
    } finally {
      await rm(firstRepository, { recursive: true, force: true });
      await rm(secondRepository, { recursive: true, force: true });
    }
  });

  it('omits a single technology version and records conflicts across build roots', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-version-conflict-'),
    );
    try {
      await writeText(
        repository,
        'first/package.json',
        '{"name":"first","devDependencies":{"typescript":"5.8.0"}}',
      );
      await writeText(
        repository,
        'second/package.json',
        '{"name":"second","devDependencies":{"typescript":"5.9.3"}}',
      );

      const profile = await new FileSystemRepositoryScanner().scan(repository, {
        id: 'PROJECT-VERSION-CONFLICT',
        name: 'version-conflict',
      });

      expect(
        profile.technologies.find(
          (technology) => technology.name === 'TypeScript',
        )?.version,
      ).toBeUndefined();
      expect(
        profile.uncertainties.some((uncertainty) =>
          uncertainty.id.startsWith('UNCERTAINTY-TECHNOLOGY-VERSION-'),
        ),
      ).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('preserves conflicting dependency-section versions within one package manifest', async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), 'craftcompass-package-section-conflict-'),
    );
    try {
      await writeText(
        repository,
        'package.json',
        JSON.stringify({
          name: 'section-conflict',
          dependencies: { typescript: '5.8.0' },
          devDependencies: { typescript: '5.9.3' },
        }),
      );

      const profile = await new FileSystemRepositoryScanner().scan(repository);

      expect(
        profile.technologies.find(
          (technology) => technology.name === 'TypeScript',
        )?.version,
      ).toBeUndefined();
      expect(
        profile.uncertainties.some((uncertainty) =>
          uncertainty.id.startsWith('UNCERTAINTY-TECHNOLOGY-VERSION-'),
        ),
      ).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('rejects a repository root whose identity changes during observation', async () => {
    const root = '/virtual/repository';
    let rootInspections = 0;
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve(root),
      inspect: (_scanRoot, candidate) => {
        if (candidate !== root) {
          return Promise.resolve(undefined);
        }
        rootInspections += 1;
        return Promise.resolve({
          kind: 'directory',
          size: 0,
          identity: rootInspections === 1 ? 'before' : 'after',
        });
      },
      readBoundedText: () => Promise.reject(new Error('unexpected read')),
      list: () => Promise.resolve([]),
    };

    await expect(
      new FileSystemRepositoryScanner(fileSystem).scan(root),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'directory_changed',
        message: 'Repository root changed before observation completed.',
      }),
    );
  });
});
