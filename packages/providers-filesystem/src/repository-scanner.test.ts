import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileSystemRepositoryScanner,
  RepositoryScanError,
  type RepositoryFileSystem,
} from './repository-scanner.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePath = (name: string): string =>
  path.join(REPOSITORY_ROOT, 'fixtures/repositories', name);

const technologyNames = (
  profile: Awaited<ReturnType<FileSystemRepositoryScanner['scan']>>,
): string[] => profile.technologies.map((technology) => technology.name);

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
    expect(profile.modules.map((module) => module.path)).toContain(
      'src/main/java',
    );
    expect(profile.observations[0]?.evidence[0]?.location).toBe('pom.xml');
    expect(
      profile.technologies.every(
        (technology) => technology.evidence.length > 0,
      ),
    ).toBe(true);
    expect(profile.modules[0]?.status).toBe('candidate');
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
        }),
      ]),
    );
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

  it('keeps unsupported and conflicting package-manager evidence uncertain', async () => {
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
    expect(unsupportedProfile.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'UNCERTAINTY-PACKAGE-MANAGER-DECLARATION',
          resolution_required: true,
        }),
      ]),
    );
    expect(technologyNames(conflictingProfile)).not.toEqual(
      expect.arrayContaining(['npm', 'pnpm', 'Yarn']),
    );
    expect(
      conflictingProfile.uncertainties.some(
        (uncertainty) =>
          uncertainty.id === 'UNCERTAINTY-PACKAGE-MANAGER-CONFLICT',
      ),
    ).toBe(true);
    expect(
      conflictingProfile.uncertainties
        .find(
          (uncertainty) =>
            uncertainty.id === 'UNCERTAINTY-PACKAGE-MANAGER-CONFLICT',
        )
        ?.evidence.map((evidence) => evidence.location),
    ).toEqual(['package-lock.json', 'package.json', 'yarn.lock']);
  });

  it('canonicalizes Maven module paths without collapsing distinct names', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(
      fixturePath('maven-module-normalization'),
    );

    expect(profile.modules.map((module) => module.path)).toEqual([
      'bar',
      'foo-bar',
      'foo/bar',
    ]);
    expect(profile.modules.map((module) => module.name)).toEqual([
      'bar',
      'foo-bar',
      'foo/bar',
    ]);
    expect(
      profile.uncertainties.some(
        (uncertainty) =>
          uncertainty.statement ===
          'Maven declares an invalid module path: ".".',
      ),
    ).toBe(true);
  });

  it('is stable and never leaks the absolute repository path', async () => {
    const scanner = new FileSystemRepositoryScanner();
    const repository = fixturePath('typescript-pnpm-service');

    const first = await scanner.scan(repository);
    const second = await scanner.scan(repository);
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    expect(serialized).not.toContain(repository);
    expect(
      first.observations.flatMap((observation) =>
        observation.evidence.map((evidence) => evidence.location),
      ),
    ).toEqual(expect.arrayContaining(['package.json']));
  });

  it('returns partial evidence and explicit uncertainty for unknown projects', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('unknown-project'));

    expect(technologyNames(profile)).toEqual([]);
    expect(profile.modules).toEqual([]);
    expect(profile.observations[0]?.statement).toContain('without recognizing');
    expect(profile.uncertainties).toEqual([
      expect.objectContaining({
        id: 'UNCERTAINTY-PROJECT-TECHNOLOGY',
        resolution_required: false,
      }),
    ]);
  });

  it('keeps malformed Maven input visible without inventing Maven or Java facts', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('malformed-maven'));

    expect(profile.technologies).toEqual([]);
    expect(profile.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'UNCERTAINTY-MAVEN-MANIFEST',
          resolution_required: true,
        }),
      ]),
    );
  });

  it('rejects Maven DOCTYPE declarations without processing entities', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('doctype-maven'));

    expect(profile.technologies).toEqual([]);
    expect(
      profile.uncertainties.find(
        (uncertainty) => uncertainty.id === 'UNCERTAINTY-MAVEN-MANIFEST',
      )?.evidence[0]?.description,
    ).toContain('must not contain a DOCTYPE');
  });

  it('rejects Maven module paths that escape the repository root', async () => {
    const scanner = new FileSystemRepositoryScanner();

    const profile = await scanner.scan(fixturePath('unsafe-maven-module'));

    expect(profile.modules).toEqual([]);
    const uncertainty = profile.uncertainties.find(
      (item) => item.id === 'UNCERTAINTY-MAVEN-MODULE-1',
    );
    expect(uncertainty?.statement).toContain('../outside-repository');
    expect(uncertainty?.resolution_required).toBe(true);
  });

  it('does not treat a permission failure as a missing manifest', async () => {
    const permissionFailure = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve('/virtual/repository'),
      inspect: (candidate) => {
        if (candidate === '/virtual/repository') {
          return Promise.resolve({ kind: 'directory', size: 0 });
        }
        if (candidate === '/virtual/repository/package.json') {
          return Promise.resolve({ kind: 'file', size: 20 });
        }
        return Promise.resolve(undefined);
      },
      readText: () => Promise.reject(permissionFailure),
      list: () => Promise.resolve([]),
    };
    const scanner = new FileSystemRepositoryScanner(fileSystem);

    await expect(scanner.scan('/virtual/repository')).rejects.toEqual(
      expect.objectContaining<Partial<RepositoryScanError>>({
        name: 'RepositoryScanError',
        message: 'Could not read repository manifest: package.json',
        cause: permissionFailure,
      }),
    );
  });

  it('rejects oversized manifests before reading their contents', async () => {
    let attemptedRead = false;
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve('/virtual/repository'),
      inspect: (candidate) =>
        Promise.resolve(
          candidate === '/virtual/repository'
            ? { kind: 'directory', size: 0 }
            : candidate === '/virtual/repository/package.json'
              ? { kind: 'file', size: 2 * 1024 * 1024 + 1 }
              : undefined,
        ),
      readText: () => {
        attemptedRead = true;
        return Promise.resolve('{}');
      },
      list: () => Promise.resolve([]),
    };
    const scanner = new FileSystemRepositoryScanner(fileSystem);

    await expect(scanner.scan('/virtual/repository')).rejects.toThrow(
      'Manifest exceeds 2097152 bytes: package.json',
    );
    expect(attemptedRead).toBe(false);
  });

  it('refuses to follow supported manifest symlinks', async () => {
    const fileSystem: RepositoryFileSystem = {
      canonicalize: () => Promise.resolve('/virtual/repository'),
      inspect: (candidate) =>
        Promise.resolve(
          candidate === '/virtual/repository'
            ? { kind: 'directory', size: 0 }
            : candidate === '/virtual/repository/package.json'
              ? { kind: 'symlink', size: 12 }
              : undefined,
        ),
      readText: () => Promise.resolve('{}'),
      list: () => Promise.resolve([]),
    };
    const scanner = new FileSystemRepositoryScanner(fileSystem);

    await expect(scanner.scan('/virtual/repository')).rejects.toThrow(
      'Refusing to follow manifest symlink: package.json',
    );
  });
});
