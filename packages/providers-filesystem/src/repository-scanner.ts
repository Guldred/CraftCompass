import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import {
  ProjectProfileSchema,
  type EvidenceReference,
  type ProjectModule,
  type ProjectObservation,
  type ProjectProfile,
  type ProjectUncertainty,
  type Technology,
} from '@craftcompass/domain';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';

type TechnologyCategory = Technology['category'];

interface PackageManifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly engines?: {
    readonly node?: string;
  };
  readonly dependencies: Readonly<Record<string, string>>;
}

interface MavenCoordinate {
  readonly groupId?: string;
  readonly artifactId: string;
}

interface MavenModel {
  readonly artifactId?: string;
  readonly javaVersion?: string;
  readonly springBootVersion?: string;
  readonly dependencyCoordinates: readonly MavenCoordinate[];
  readonly pluginCoordinates: readonly MavenCoordinate[];
  readonly modules: readonly string[];
}

interface RepositoryEntry {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
}

interface RepositoryDirectoryEntry {
  readonly name: string;
  readonly kind: RepositoryEntry['kind'];
}

/** Injectable filesystem contract used to prove error and symlink behavior. */
export interface RepositoryFileSystem {
  canonicalize(path: string): Promise<string>;
  inspect(path: string): Promise<RepositoryEntry | undefined>;
  readText(path: string): Promise<string>;
  list(path: string): Promise<readonly RepositoryDirectoryEntry[]>;
}

/** Optional stable identity overrides for repository scanning. */
export interface RepositoryScanOptions {
  readonly id?: string;
  readonly name?: string;
}

/** Filesystem-backed, evidence-preserving project-profile provider. */
export interface RepositoryScanner {
  scan(
    repositoryPath: string,
    options?: RepositoryScanOptions,
  ): Promise<ProjectProfile>;
}

export class RepositoryScanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepositoryScanError';
  }
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

const frameworkPackages = new Map<string, string>([
  ['@angular/core', 'Angular'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
]);

const testFrameworkPackages = new Map<string, string>([
  ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'],
  ['jest', 'Jest'],
  ['mocha', 'Mocha'],
  ['vitest', 'Vitest'],
]);

const qualityToolPackages = new Map<string, string>([
  ['@stryker-mutator/core', 'Stryker'],
  ['eslint', 'ESLint'],
  ['prettier', 'Prettier'],
  ['typescript-eslint', 'typescript-eslint'],
]);

const toEntryKind = (
  entry: Pick<Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>,
): RepositoryEntry['kind'] => {
  if (entry.isSymbolicLink()) {
    return 'symlink';
  }
  if (entry.isFile()) {
    return 'file';
  }
  if (entry.isDirectory()) {
    return 'directory';
  }
  return 'other';
};

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const nodeRepositoryFileSystem: RepositoryFileSystem = {
  canonicalize: realpath,
  inspect: async (candidate) => {
    try {
      const entry = await lstat(candidate);
      return {
        kind: toEntryKind(entry),
        size: entry.size,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  },
  readText: (candidate) => readFile(candidate, 'utf8'),
  list: async (candidate) => {
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: toEntryKind(entry),
      }));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  },
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeRelativePath = (value: string): string =>
  value.split(path.sep).join('/');

const stableToken = (value: string): string => {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  return normalized.length > 0 ? normalized : 'REPOSITORY';
};

const resolveInside = (
  repositoryPath: string,
  relativePath: string,
): string | undefined => {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  const resolved = path.resolve(repositoryPath, relativePath);
  const relative = path.relative(repositoryPath, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return resolved;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const stringRecord = (value: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
};

const recordArray = (value: unknown): readonly Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  return isRecord(value) ? [value] : [];
};

const stringArray = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter((item): item is string => !!item);
  }
  const item = stringValue(value);
  return item === undefined ? [] : [item];
};

const parsePackageManifest = (source: string): PackageManifest => {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) {
    throw new RepositoryScanError('package.json must contain an object');
  }
  const dependencies = {
    ...stringRecord(parsed.dependencies),
    ...stringRecord(parsed.devDependencies),
    ...stringRecord(parsed.peerDependencies),
  };
  const engines = isRecord(parsed.engines)
    ? stringValue(parsed.engines.node)
    : undefined;
  const name = stringValue(parsed.name);
  const packageManager = stringValue(parsed.packageManager);
  return {
    ...(name === undefined ? {} : { name }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(engines === undefined ? {} : { engines: { node: engines } }),
    dependencies,
  };
};

const mavenParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
  isArray: (_tagName, jPath) =>
    [
      'project.dependencies.dependency',
      'project.build.plugins.plugin',
      'project.modules.module',
    ].includes(String(jPath)),
});

const resolveMavenProperty = (
  value: string | undefined,
  properties: Readonly<Record<string, unknown>>,
  visited: ReadonlySet<string> = new Set(),
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const reference = /^\$\{([^}]+)\}$/.exec(value)?.[1];
  if (reference === undefined) {
    return value.includes('${') ? undefined : value;
  }
  if (visited.has(reference)) {
    return undefined;
  }
  const resolved = stringValue(properties[reference]);
  return resolveMavenProperty(
    resolved,
    properties,
    new Set([...visited, reference]),
  );
};

const parseMavenModel = (source: string): MavenModel => {
  if (/<!DOCTYPE/i.test(source)) {
    throw new RepositoryScanError('Maven POM must not contain a DOCTYPE');
  }
  const validation = SyntaxValidator.validate(source, {
    docType: {
      maxEntityCount: 0,
      maxEntitySize: 0,
    },
    invalidCharSequence: {
      attrLt: true,
      comment: true,
      tagValue: true,
    },
  });
  if (validation !== true) {
    throw new RepositoryScanError(
      `Invalid Maven XML at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`,
    );
  }
  const parsed: unknown = mavenParser.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed.project)) {
    throw new RepositoryScanError(
      'Maven POM must contain one project root element',
    );
  }
  const project = parsed.project;
  const properties = isRecord(project.properties) ? project.properties : {};
  const parent = isRecord(project.parent) ? project.parent : {};
  const dependencies = isRecord(project.dependencies)
    ? recordArray(project.dependencies.dependency)
    : [];
  const build = isRecord(project.build) ? project.build : {};
  const plugins = isRecord(build.plugins)
    ? recordArray(build.plugins.plugin)
    : [];
  const toCoordinate = (
    value: Record<string, unknown>,
  ): MavenCoordinate | undefined => {
    const artifactId = stringValue(value.artifactId);
    const groupId = stringValue(value.groupId);
    return artifactId === undefined
      ? undefined
      : {
          artifactId,
          ...(groupId === undefined ? {} : { groupId }),
        };
  };
  const compareCoordinate = (
    left: MavenCoordinate,
    right: MavenCoordinate,
  ): number =>
    compareText(
      `${left.groupId ?? ''}:${left.artifactId}`,
      `${right.groupId ?? ''}:${right.artifactId}`,
    );
  const dependencyCoordinates = dependencies
    .map(toCoordinate)
    .filter((value): value is MavenCoordinate => value !== undefined)
    .sort(compareCoordinate);
  const pluginCoordinates = plugins
    .map(toCoordinate)
    .filter((value): value is MavenCoordinate => value !== undefined)
    .sort(compareCoordinate);
  const parentGroupId = stringValue(parent.groupId);
  const parentArtifactId = stringValue(parent.artifactId);
  const parentVersion = resolveMavenProperty(
    stringValue(parent.version),
    properties,
  );
  const springBootVersion =
    resolveMavenProperty(
      stringValue(properties['spring-boot.version']),
      properties,
    ) ??
    (parentGroupId === 'org.springframework.boot' &&
    parentArtifactId === 'spring-boot-starter-parent'
      ? parentVersion
      : undefined);
  const artifactId = stringValue(project.artifactId);
  const javaVersion =
    resolveMavenProperty(
      stringValue(properties['maven.compiler.release']),
      properties,
    ) ??
    resolveMavenProperty(stringValue(properties['java.version']), properties) ??
    resolveMavenProperty(
      stringValue(properties['maven.compiler.source']),
      properties,
    );

  return {
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(javaVersion === undefined ? {} : { javaVersion }),
    ...(springBootVersion === undefined ? {} : { springBootVersion }),
    dependencyCoordinates,
    pluginCoordinates,
    modules: isRecord(project.modules)
      ? [...stringArray(project.modules.module)].sort(compareText)
      : [],
  };
};

const evidenceFor = (
  id: string,
  description: string,
  location: string,
  type: EvidenceReference['type'] = 'build_configuration',
): EvidenceReference => ({
  id,
  type,
  description,
  location: normalizeRelativePath(location),
  provider: 'filesystem',
});

const mergeEvidence = (
  current: readonly EvidenceReference[],
  additional: EvidenceReference,
): EvidenceReference[] =>
  current.some((evidence) => evidence.id === additional.id)
    ? [...current]
    : [...current, additional].sort((left, right) =>
        compareText(left.id, right.id),
      );

const isEvidenceList = (
  evidence: EvidenceReference | readonly EvidenceReference[],
): evidence is readonly EvidenceReference[] => Array.isArray(evidence);

const hasMavenCoordinate = (
  coordinates: readonly MavenCoordinate[],
  groupId: string,
  artifactId: string | RegExp,
): boolean =>
  coordinates.some(
    (coordinate) =>
      coordinate.groupId === groupId &&
      (typeof artifactId === 'string'
        ? coordinate.artifactId === artifactId
        : artifactId.test(coordinate.artifactId)),
  );

/**
 * Detects only declarations supported by fixture-backed parsers. Anything else
 * remains absent or uncertain instead of becoming a fabricated technology.
 */
export class FileSystemRepositoryScanner implements RepositoryScanner {
  constructor(
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  async scan(
    repositoryPath: string,
    options: RepositoryScanOptions = {},
  ): Promise<ProjectProfile> {
    let canonicalRepositoryPath: string;
    try {
      canonicalRepositoryPath =
        await this.fileSystem.canonicalize(repositoryPath);
    } catch (error) {
      throw new RepositoryScanError(
        `Could not access repository directory: ${repositoryPath}`,
        { cause: error },
      );
    }
    const rootEntry = await this.fileSystem.inspect(canonicalRepositoryPath);
    if (rootEntry?.kind !== 'directory') {
      throw new RepositoryScanError(
        `Repository path is not a directory: ${repositoryPath}`,
      );
    }

    const technologies = new Map<string, Technology>();
    const observations: ProjectObservation[] = [];
    const uncertainties: ProjectUncertainty[] = [];
    const modules = new Map<string, ProjectModule>();
    let detectedName = path.basename(canonicalRepositoryPath);

    const inspectRelative = async (
      relativePath: string,
    ): Promise<RepositoryEntry | undefined> => {
      const resolved = resolveInside(canonicalRepositoryPath, relativePath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          `Repository-relative path escapes the root: ${relativePath}`,
        );
      }
      try {
        return await this.fileSystem.inspect(resolved);
      } catch (error) {
        throw new RepositoryScanError(
          `Could not inspect repository path: ${normalizeRelativePath(relativePath)}`,
          { cause: error },
        );
      }
    };

    const readManifest = async (
      relativePath: string,
    ): Promise<string | undefined> => {
      const resolved = resolveInside(canonicalRepositoryPath, relativePath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          `Manifest path escapes the repository: ${relativePath}`,
        );
      }
      const entry = await inspectRelative(relativePath);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.kind === 'symlink') {
        throw new RepositoryScanError(
          `Refusing to follow manifest symlink: ${relativePath}`,
        );
      }
      if (entry.kind !== 'file') {
        throw new RepositoryScanError(
          `Expected a regular manifest file: ${relativePath}`,
        );
      }
      if (entry.size > MAX_MANIFEST_BYTES) {
        throw new RepositoryScanError(
          `Manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${relativePath}`,
        );
      }
      try {
        return await this.fileSystem.readText(resolved);
      } catch (error) {
        throw new RepositoryScanError(
          `Could not read repository manifest: ${relativePath}`,
          { cause: error },
        );
      }
    };

    const addTechnology = (
      category: TechnologyCategory,
      name: string,
      evidence: EvidenceReference,
      version?: string,
    ): void => {
      const key = `${category}\u0000${name.toLowerCase()}`;
      const current = technologies.get(key);
      technologies.set(key, {
        category,
        name,
        ...(version === undefined
          ? current?.version === undefined
            ? {}
            : { version: current.version }
          : { version }),
        evidence:
          current === undefined
            ? [evidence]
            : mergeEvidence(current.evidence, evidence),
      });
    };

    const addObservation = (
      id: string,
      statement: string,
      evidence: EvidenceReference,
    ): void => {
      observations.push({
        id,
        type: 'fact',
        statement,
        confidence: 1,
        evidence: [evidence],
      });
    };

    const addUncertainty = (
      id: string,
      statement: string,
      impact: string,
      evidence: EvidenceReference | readonly EvidenceReference[],
      resolutionRequired = false,
    ): void => {
      const evidenceList = isEvidenceList(evidence) ? evidence : [evidence];
      const evidenceItems = [
        ...new Map(evidenceList.map((item) => [item.id, item])).values(),
      ].sort((left, right) => compareText(left.id, right.id));
      uncertainties.push({
        id,
        statement,
        impact,
        resolution_required: resolutionRequired,
        evidence: evidenceItems,
      });
    };

    const addModule = (
      relativePath: string,
      evidence: EvidenceReference,
    ): void => {
      const resolved = resolveInside(canonicalRepositoryPath, relativePath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          `Module path escapes the repository: ${relativePath}`,
        );
      }
      const normalizedPath = normalizeRelativePath(
        path.relative(canonicalRepositoryPath, resolved),
      );
      if (normalizedPath.length === 0) {
        throw new RepositoryScanError(
          `Module path resolves to the repository root: ${relativePath}`,
        );
      }
      const current = modules.get(normalizedPath);
      modules.set(normalizedPath, {
        name: normalizedPath,
        path: normalizedPath,
        status: 'candidate',
        responsibilities: current?.responsibilities ?? [],
        evidence:
          current === undefined
            ? [evidence]
            : mergeEvidence(current.evidence, evidence),
      });
    };

    const packageJson = await readManifest('package.json');
    if (packageJson !== undefined) {
      const packageEvidence = evidenceFor(
        'EV-PACKAGE-MANIFEST',
        'Node.js package manifest was inspected.',
        'package.json',
      );
      try {
        const manifest = parsePackageManifest(packageJson);
        if (manifest.name !== undefined) {
          detectedName = manifest.name;
        }
        const hasTsconfig =
          (await inspectRelative('tsconfig.json'))?.kind === 'file';
        const typescriptVersion = manifest.dependencies.typescript?.replace(
          /^[~^]/,
          '',
        );
        if (typescriptVersion !== undefined) {
          addTechnology(
            'language',
            'TypeScript',
            packageEvidence,
            typescriptVersion,
          );
        }
        if (hasTsconfig) {
          addTechnology(
            'language',
            'TypeScript',
            evidenceFor(
              'EV-TYPESCRIPT-CONFIG',
              'A TypeScript compiler configuration was observed.',
              'tsconfig.json',
            ),
            typescriptVersion,
          );
        }
        if (manifest.engines?.node !== undefined) {
          addTechnology(
            'runtime',
            'Node.js',
            packageEvidence,
            manifest.engines.node,
          );
        }
        const packageManagers = [
          {
            key: 'npm',
            displayName: 'npm',
            lockfile: 'package-lock.json',
            evidenceId: 'EV-NPM-LOCK',
          },
          {
            key: 'pnpm',
            displayName: 'pnpm',
            lockfile: 'pnpm-lock.yaml',
            evidenceId: 'EV-PNPM-LOCK',
          },
          {
            key: 'yarn',
            displayName: 'Yarn',
            lockfile: 'yarn.lock',
            evidenceId: 'EV-YARN-LOCK',
          },
        ] as const;
        const declaredPackageManager = manifest.packageManager
          ?.split('@')[0]
          ?.toLowerCase();
        const declaredManager = packageManagers.find(
          (manager) => manager.key === declaredPackageManager,
        );
        const presentLocks: (typeof packageManagers)[number][] = [];
        for (const manager of packageManagers) {
          if ((await inspectRelative(manager.lockfile))?.kind === 'file') {
            presentLocks.push(manager);
          }
        }
        const managerConflict =
          presentLocks.length > 1 ||
          (declaredManager !== undefined &&
            presentLocks.some(
              (manager) => manager.key !== declaredManager.key,
            ));
        if (
          declaredPackageManager !== undefined &&
          declaredManager === undefined
        ) {
          addUncertainty(
            'UNCERTAINTY-PACKAGE-MANAGER-DECLARATION',
            `Unsupported package-manager declaration: ${declaredPackageManager}.`,
            'Install and quality-gate commands cannot be selected reliably.',
            packageEvidence,
            true,
          );
        } else if (managerConflict) {
          const managerNames = [
            ...(declaredManager === undefined ? [] : [declaredManager.key]),
            ...presentLocks.map((manager) => manager.key),
          ]
            .filter((value, index, values) => values.indexOf(value) === index)
            .sort(compareText);
          addUncertainty(
            'UNCERTAINTY-PACKAGE-MANAGER-CONFLICT',
            `Conflicting package-manager evidence was found: ${managerNames.join(', ')}.`,
            'Install and quality-gate commands cannot be selected reliably.',
            [
              packageEvidence,
              ...presentLocks.map((manager) =>
                evidenceFor(
                  manager.evidenceId,
                  `${manager.displayName} lockfile declares the package manager.`,
                  manager.lockfile,
                ),
              ),
            ],
            true,
          );
        } else if (declaredManager !== undefined) {
          addTechnology(
            'build_tool',
            declaredManager.displayName,
            packageEvidence,
          );
          const matchingLock = presentLocks[0];
          if (matchingLock !== undefined) {
            addTechnology(
              'build_tool',
              matchingLock.displayName,
              evidenceFor(
                matchingLock.evidenceId,
                `${matchingLock.displayName} lockfile declares the package manager.`,
                matchingLock.lockfile,
              ),
            );
          }
        } else if (presentLocks.length === 1) {
          const manager = presentLocks[0];
          if (manager !== undefined) {
            addTechnology(
              'build_tool',
              manager.displayName,
              evidenceFor(
                manager.evidenceId,
                `${manager.displayName} lockfile declares the package manager.`,
                manager.lockfile,
              ),
            );
          }
        } else {
          addUncertainty(
            'UNCERTAINTY-PACKAGE-MANAGER',
            'No package-manager declaration or recognized lockfile was found.',
            'Install and quality-gate commands cannot be selected reliably.',
            packageEvidence,
          );
        }
        frameworkPackages.forEach((displayName, packageName) => {
          const version = manifest.dependencies[packageName];
          if (version !== undefined) {
            addTechnology(
              'framework',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          }
        });
        testFrameworkPackages.forEach((displayName, packageName) => {
          const version = manifest.dependencies[packageName];
          if (version !== undefined) {
            addTechnology(
              'test_framework',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          }
        });
        qualityToolPackages.forEach((displayName, packageName) => {
          const version = manifest.dependencies[packageName];
          if (version !== undefined) {
            addTechnology(
              'quality_tool',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          }
        });
        addObservation(
          'OBS-PACKAGE-MANIFEST',
          'package.json declares the package and dependency model.',
          packageEvidence,
        );
      } catch (error) {
        addUncertainty(
          'UNCERTAINTY-PACKAGE-MANIFEST',
          'package.json exists but is not a valid supported package manifest.',
          'Node.js technologies and project identity may be incomplete.',
          evidenceFor(
            'EV-PACKAGE-MANIFEST-PARSE',
            error instanceof Error
              ? error.message
              : 'The package manifest could not be decoded.',
            'package.json',
          ),
          true,
        );
      }
    }

    const pomXml = await readManifest('pom.xml');
    if (pomXml !== undefined) {
      const mavenEvidence = evidenceFor(
        'EV-MAVEN-MANIFEST',
        'Maven project model was structurally parsed.',
        'pom.xml',
      );
      try {
        const model = parseMavenModel(pomXml);
        if (packageJson === undefined && model.artifactId !== undefined) {
          detectedName = model.artifactId;
        }
        addTechnology('build_tool', 'Maven', mavenEvidence);
        const hasJavaSource =
          (await inspectRelative('src/main/java'))?.kind === 'directory';
        if (model.javaVersion !== undefined) {
          addTechnology('language', 'Java', mavenEvidence, model.javaVersion);
        }
        if (hasJavaSource) {
          addTechnology(
            'language',
            'Java',
            evidenceFor(
              'EV-JAVA-SOURCE-ROOT',
              'A Java production source root was observed.',
              'src/main/java',
              'source_file',
            ),
            model.javaVersion,
          );
        }
        if (
          hasMavenCoordinate(
            model.dependencyCoordinates,
            'org.springframework.boot',
            /^spring-boot(?:-|$)/,
          ) ||
          hasMavenCoordinate(
            model.pluginCoordinates,
            'org.springframework.boot',
            /^spring-boot(?:-|$)/,
          )
        ) {
          addTechnology(
            'framework',
            'Spring Boot',
            mavenEvidence,
            model.springBootVersion,
          );
        }
        if (
          hasMavenCoordinate(
            model.dependencyCoordinates,
            'org.junit.jupiter',
            /^junit-jupiter(?:-|$)/,
          ) ||
          hasMavenCoordinate(
            model.dependencyCoordinates,
            'org.junit.platform',
            /^junit-platform(?:-|$)/,
          ) ||
          hasMavenCoordinate(model.dependencyCoordinates, 'junit', 'junit')
        ) {
          addTechnology('test_framework', 'JUnit', mavenEvidence);
        }
        for (const [groupId, artifactId, displayName] of [
          ['org.pitest', 'pitest-maven', 'PIT'],
          ['org.jacoco', 'jacoco-maven-plugin', 'JaCoCo'],
          ['org.apache.maven.plugins', 'maven-checkstyle-plugin', 'Checkstyle'],
          ['com.github.spotbugs', 'spotbugs-maven-plugin', 'SpotBugs'],
        ] as const) {
          if (
            hasMavenCoordinate(model.pluginCoordinates, groupId, artifactId)
          ) {
            addTechnology('quality_tool', displayName, mavenEvidence);
          }
        }
        if (
          hasMavenCoordinate(
            model.dependencyCoordinates,
            'com.tngtech.archunit',
            /^archunit(?:-|$)/,
          )
        ) {
          addTechnology('quality_tool', 'ArchUnit', mavenEvidence);
        }
        model.modules.forEach((modulePath, index) => {
          const resolved = resolveInside(canonicalRepositoryPath, modulePath);
          const normalizedModulePath =
            resolved === undefined
              ? undefined
              : normalizeRelativePath(
                  path.relative(canonicalRepositoryPath, resolved),
                );
          if (
            normalizedModulePath === undefined ||
            normalizedModulePath.length === 0
          ) {
            addUncertainty(
              `UNCERTAINTY-MAVEN-MODULE-${index + 1}`,
              `Maven declares an invalid module path: "${modulePath}".`,
              normalizedModulePath === ''
                ? 'The module was excluded because it resolves to the repository root.'
                : 'The module was excluded because it escapes the repository root.',
              mavenEvidence,
              true,
            );
          } else {
            addModule(normalizedModulePath, mavenEvidence);
          }
        });
        addObservation(
          'OBS-MAVEN-MANIFEST',
          'pom.xml declares a Maven project model.',
          mavenEvidence,
        );
      } catch (error) {
        addUncertainty(
          'UNCERTAINTY-MAVEN-MANIFEST',
          'pom.xml exists but is not a valid supported Maven project model.',
          'Maven, Java, and framework declarations may be incomplete.',
          evidenceFor(
            'EV-MAVEN-MANIFEST-PARSE',
            error instanceof Error
              ? error.message
              : 'The Maven model could not be decoded.',
            'pom.xml',
          ),
          true,
        );
      }
    }

    for (const parent of ['apps', 'packages']) {
      const parentEntry = await inspectRelative(parent);
      if (parentEntry?.kind !== 'directory') {
        continue;
      }
      const absoluteParent = resolveInside(canonicalRepositoryPath, parent);
      if (absoluteParent === undefined) {
        continue;
      }
      const children = await this.fileSystem.list(absoluteParent);
      children
        .filter(
          (entry) => entry.kind === 'directory' && !entry.name.startsWith('.'),
        )
        .sort((left, right) => compareText(left.name, right.name))
        .forEach((entry) => {
          const modulePath = `${parent}/${entry.name}`;
          addModule(
            modulePath,
            evidenceFor(
              `EV-MODULE-${stableToken(modulePath)}`,
              'A candidate module directory was observed.',
              modulePath,
              'source_file',
            ),
          );
        });
    }

    if (modules.size === 0) {
      for (const sourceRoot of ['src/main/java', 'src']) {
        if ((await inspectRelative(sourceRoot))?.kind === 'directory') {
          addModule(
            sourceRoot,
            evidenceFor(
              `EV-SOURCE-ROOT-${stableToken(sourceRoot)}`,
              'A candidate source root was observed.',
              sourceRoot,
              'source_file',
            ),
          );
          break;
        }
      }
    }

    if (observations.length === 0) {
      const rootEvidence = evidenceFor(
        'EV-REPOSITORY-ROOT',
        'No supported project manifest supplied reliable declarations.',
        '.',
        'source_file',
      );
      addObservation(
        'OBS-REPOSITORY-INSPECTED',
        'The repository root was inspected without recognizing a supported project manifest.',
        rootEvidence,
      );
      addUncertainty(
        'UNCERTAINTY-PROJECT-TECHNOLOGY',
        'The repository technology could not be determined from supported manifests.',
        'Generated rules and assurance guidance must remain conservative.',
        rootEvidence,
      );
    }

    const name = options.name ?? detectedName;
    const profile: ProjectProfile = {
      schema_version: 1,
      kind: 'project_profile',
      id: options.id ?? `PROJECT-${stableToken(name)}`,
      name,
      technologies: [...technologies.values()].sort((left, right) =>
        compareText(
          `${left.category}\u0000${left.name}`,
          `${right.category}\u0000${right.name}`,
        ),
      ),
      modules: [...modules.values()].sort((left, right) =>
        compareText(left.path, right.path),
      ),
      observations: observations.sort((left, right) =>
        compareText(left.id, right.id),
      ),
      constraints: [],
      uncertainties: uncertainties.sort((left, right) =>
        compareText(left.id, right.id),
      ),
    };

    return ProjectProfileSchema.parse(profile);
  }
}
