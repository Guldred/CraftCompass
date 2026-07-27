import { createHash } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPOSITORY_SCAN_LIMITS,
  FileSystemRepositoryScanner,
} from './repository-scanner.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MULTI_BUILD_FIXTURE = path.join(
  REPOSITORY_ROOT,
  'fixtures/repositories/multi-build-reactor',
);

const EXPECTED_CAPABILITIES = [
  { id: 'CAP-BOUNDED-MANIFEST-DISCOVERY', status: 'partial' },
  { id: 'CAP-MAVEN-DECLARED-MODULES', status: 'supported' },
  { id: 'CAP-MAVEN-EFFECTIVE-MODEL', status: 'unsupported' },
  { id: 'CAP-MAVEN-PROFILE-MODULES', status: 'partial' },
  { id: 'CAP-NODE-PACKAGE-MANIFEST', status: 'supported' },
  { id: 'CAP-RUNTIME-ARCHITECTURE', status: 'unsupported' },
] as const;

const EXPECTED_POM_INPUTS = [
  'aggregate/child-a/pom.xml',
  'aggregate/child-b/pom.xml',
  'aggregate/pom.xml',
  'optional/pom.xml',
  'pom.xml',
  'service/pom.xml',
  'updater-scripts/pom.xml',
] as const;

const FREE_DISCOVERY_EXCLUSIONS = [
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
] as const;

type FingerprintKind = 'directory' | 'file' | 'other' | 'symlink';

interface FingerprintEntry {
  readonly path: string;
  readonly kind: FingerprintKind;
  readonly mode: number;
  readonly mtime_ns: string;
  readonly content_sha256?: string;
}

const fingerprintKind = (stats: BigIntStats): FingerprintKind => {
  if (stats.isDirectory()) {
    return 'directory';
  }
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  return 'other';
};

const normalizePath = (value: string): string =>
  value.split(path.sep).join('/');

const fingerprintRepository = async (
  repository: string,
): Promise<readonly FingerprintEntry[]> => {
  const fingerprint: FingerprintEntry[] = [];

  const visit = async (relativePath: string): Promise<void> => {
    const absolutePath =
      relativePath === '.' ? repository : path.join(repository, relativePath);
    const stats = await lstat(absolutePath, { bigint: true });
    const kind = fingerprintKind(stats);
    fingerprint.push({
      path: normalizePath(relativePath),
      kind,
      mode: Number(stats.mode),
      mtime_ns: stats.mtimeNs.toString(),
      ...(kind === 'file'
        ? {
            content_sha256: createHash('sha256')
              .update(await readFile(absolutePath))
              .digest('hex'),
          }
        : {}),
    });

    if (kind !== 'directory') {
      return;
    }
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await visit(
        relativePath === '.' ? child.name : path.join(relativePath, child.name),
      );
    }
  };

  await visit('.');
  return fingerprint;
};

const writeText = async (
  repository: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const target = path.join(repository, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const exclusionPom = (artifactId: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>example.craftcompass</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <build>
    <plugins>
      <plugin>
        <groupId>org.pitest</groupId>
        <artifactId>pitest-maven</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`;

describe('filesystem repository scanner acceptance', () => {
  it('reports the complete bounded multi-build observation contract', async () => {
    const profile = await new FileSystemRepositoryScanner().scan(
      MULTI_BUILD_FIXTURE,
    );
    const coverage = profile.observation_coverage;
    const updaterScripts = profile.modules.find(
      (module) => module.path === 'updater-scripts',
    );

    expect(updaterScripts).toEqual(
      expect.objectContaining({
        status: 'candidate',
        discovery: {
          basis: 'manifest_presence',
          selection: 'unknown',
        },
      }),
    );
    expect(
      updaterScripts?.evidence.map((evidence) => evidence.location),
    ).toEqual(['updater-scripts/pom.xml']);
    expect(profile.modules.map((module) => module.path)).not.toContain('src');

    const technologyNames = profile.technologies.map(
      (technology) => technology.name,
    );
    expect(technologyNames).not.toContain('PIT');
    expect(technologyNames).not.toContain('ArchUnit');
    expect(
      profile.technologies
        .find((technology) => technology.name === 'Maven')
        ?.evidence.map((evidence) => evidence.location),
    ).toEqual(EXPECTED_POM_INPUTS);

    expect(coverage?.provider).toEqual({
      id: 'filesystem',
      contract_version: '1.0.0',
    });
    expect(coverage?.capabilities).toEqual(EXPECTED_CAPABILITIES);
    expect(coverage?.limits).toEqual(DEFAULT_REPOSITORY_SCAN_LIMITS);

    const pomInputs = coverage?.inputs.filter((input) =>
      input.path.endsWith('pom.xml'),
    );
    expect(
      pomInputs?.map((input) => ({
        path: input.path,
        kind: input.kind,
        status: input.status,
      })),
    ).toEqual(
      EXPECTED_POM_INPUTS.map((inputPath) => ({
        path: inputPath,
        kind: 'manifest',
        status: 'parsed',
      })),
    );
    for (const expectedPath of EXPECTED_POM_INPUTS) {
      expect(
        pomInputs
          ?.find((input) => input.path === expectedPath)
          ?.evidence.map((evidence) => evidence.location),
      ).toEqual([expectedPath]);
    }
  });

  it.each(FREE_DISCOVERY_EXCLUSIONS)(
    'does not inspect manifests below the %s free-discovery exclusion',
    async (excludedDirectory) => {
      const repository = await mkdtemp(
        path.join(tmpdir(), 'craftcompass-excluded-discovery-'),
      );
      try {
        await writeText(
          repository,
          `${excludedDirectory}/pom.xml`,
          exclusionPom(`excluded-${excludedDirectory.replace('.', 'hidden-')}`),
        );
        await writeText(
          repository,
          `${excludedDirectory}/package.json`,
          JSON.stringify({
            name: 'excluded-node-build',
            devDependencies: {
              typescript: '5.9.3',
              vitest: '4.1.10',
            },
          }),
        );

        const profile = await new FileSystemRepositoryScanner().scan(
          repository,
          {
            id: 'PROJECT-EXCLUSION-ACCEPTANCE',
            name: 'exclusion-acceptance',
          },
        );
        const excludedPrefix = `${excludedDirectory}/`;

        expect(profile.modules).toEqual([]);
        expect(profile.technologies).toEqual([]);
        expect(
          profile.observation_coverage?.inputs.some((input) =>
            input.path.startsWith(excludedPrefix),
          ),
        ).toBe(false);
      } finally {
        await rm(repository, { recursive: true, force: true });
      }
    },
  );

  it('leaves fixture paths, contents, modes, and modification times unchanged', async () => {
    const before = await fingerprintRepository(MULTI_BUILD_FIXTURE);

    await new FileSystemRepositoryScanner().scan(MULTI_BUILD_FIXTURE);

    expect(await fingerprintRepository(MULTI_BUILD_FIXTURE)).toEqual(before);
  });
});
