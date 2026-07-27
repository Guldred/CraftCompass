import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  ProjectProfileSchema,
  type EvidenceReference,
  type ProjectModule,
  type ProjectModuleDiscovery,
  type ProjectObservation,
  type ProjectProfile,
  type ProjectUncertainty,
  type RepositoryObservationCoverage,
  type Technology,
} from '@craftcompass/domain';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';

type TechnologyCategory = Technology['category'];
type CoverageInput = RepositoryObservationCoverage['inputs'][number];
type CoverageInputKind = CoverageInput['kind'];
type CoverageInputStatus = CoverageInput['status'];
type ScanLimits = NonNullable<RepositoryObservationCoverage['limits']>;
type ModuleSelection = ProjectModuleDiscovery['selection'];

interface PackageManifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly engines?: {
    readonly node?: string;
  };
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
}

interface MavenCoordinate {
  readonly groupId?: string;
  readonly artifactId: string;
}

interface MavenModuleDeclaration {
  readonly path: string;
  readonly selection: ModuleSelection;
  readonly context?: string;
}

interface MavenModel {
  readonly artifactId?: string;
  readonly packaging?: string;
  readonly javaVersion?: string;
  readonly springBootVersion?: string;
  readonly dependencyCoordinates: readonly MavenCoordinate[];
  readonly pluginCoordinates: readonly MavenCoordinate[];
  readonly modules: readonly MavenModuleDeclaration[];
}

interface TechnologyAccumulator {
  readonly category: TechnologyCategory;
  readonly name: string;
  readonly versions: Set<string>;
  readonly evidence: EvidenceReference[];
}

interface RepositoryEntry {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly identity: string;
}

interface RepositoryDirectoryEntry {
  readonly name: string;
  readonly kind: RepositoryEntry['kind'];
}

interface ManifestReadResult {
  readonly status: 'missing' | 'read' | 'skipped_by_limit';
  readonly source?: string;
}

interface ParsedMavenManifest {
  readonly model?: MavenModel;
  readonly evidence: EvidenceReference;
}

interface PathState {
  readonly path: string;
  readonly state: BigIntStats;
}

interface PathChainInspection {
  readonly complete: boolean;
  readonly missingPath?: string;
  readonly states: readonly PathState[];
}

/** Stable reason codes for repository-boundary failures. */
export type RepositoryScanErrorCode =
  | 'directory_changed'
  | 'directory_entry_limit_exceeded'
  | 'directory_read_failed'
  | 'evidence_conflict'
  | 'filesystem_inspection_failed'
  | 'input_not_regular'
  | 'input_symlink'
  | 'manifest_changed'
  | 'manifest_invalid_utf8'
  | 'manifest_not_regular'
  | 'manifest_read_failed'
  | 'manifest_too_large'
  | 'path_component_not_directory'
  | 'path_escape'
  | 'path_symlink'
  | 'repository_not_directory'
  | 'repository_unavailable'
  | 'unsupported_platform';

/** Injectable filesystem contract used to prove bounded and no-follow behavior. */
export interface RepositoryFileSystem {
  canonicalize(path: string): Promise<string>;
  inspect(root: string, path: string): Promise<RepositoryEntry | undefined>;
  readBoundedText(
    root: string,
    path: string,
    maxBytes: number,
  ): Promise<string>;
  list(
    root: string,
    path: string,
    maxEntries: number,
  ): Promise<readonly RepositoryDirectoryEntry[]>;
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
  constructor(
    readonly code: RepositoryScanErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RepositoryScanError';
  }
}

class ManifestParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManifestParseError';
  }
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_SCALAR_LENGTH = 4_096;
const MAX_DECLARATIONS_PER_MANIFEST = 2_048;
const MAX_MAVEN_PROPERTY_RESOLUTION_STEPS = 4_096;
const FILESYSTEM_PROVIDER_CONTRACT_VERSION = '1.0.0';

export const DEFAULT_REPOSITORY_SCAN_LIMITS: ScanLimits = Object.freeze({
  max_declared_module_depth: 12,
  max_declared_module_declarations: 4_096,
  max_discovery_depth: 3,
  max_directories: 2_048,
  max_entries_per_directory: 2_048,
  max_manifests: 256,
  max_total_manifest_bytes: 16 * 1024 * 1024,
});

const FREE_DISCOVERY_EXCLUSIONS = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const UNSUPPORTED_MANIFEST_NAMES = new Map<string, string>([
  ['Cargo.toml', 'Rust Cargo manifests are not parsed.'],
  ['build.gradle', 'Gradle build manifests are not parsed.'],
  ['build.gradle.kts', 'Gradle Kotlin build manifests are not parsed.'],
  ['pyproject.toml', 'Python project manifests are not parsed.'],
  ['settings.gradle', 'Gradle settings manifests are not parsed.'],
  ['settings.gradle.kts', 'Gradle Kotlin settings manifests are not parsed.'],
]);

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

const buildToolPackages = new Map<string, string>([
  ['sass', 'Sass'],
  ['webpack', 'Webpack'],
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

const assertSupportedFileSystemPlatform = (candidate: string): void => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new RepositoryScanError(
      'unsupported_platform',
      `Hardened repository scanning currently requires Linux or macOS: ${candidate}`,
    );
  }
};

const sameFileState = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const assertLexicallyInside = (root: string, candidate: string): void => {
  const relative = path.relative(root, candidate);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RepositoryScanError(
      'path_escape',
      `Repository path escapes the root: ${candidate}`,
    );
  }
};

const inspectPathChain = async (
  root: string,
  candidate: string,
): Promise<PathChainInspection> => {
  assertSupportedFileSystemPlatform(candidate);
  assertLexicallyInside(root, candidate);
  const relative = path.relative(root, candidate);
  const segments =
    relative.length === 0 ? [] : relative.split(path.sep).filter(Boolean);
  const paths = [
    root,
    ...segments.map((_segment, index) =>
      path.join(root, ...segments.slice(0, index + 1)),
    ),
  ];
  const states: PathState[] = [];
  for (const [index, currentPath] of paths.entries()) {
    let state: BigIntStats;
    try {
      state = await lstat(currentPath, { bigint: true });
    } catch (error) {
      if (isMissingFileError(error)) {
        return { complete: false, missingPath: currentPath, states };
      }
      throw error;
    }
    if (state.isSymbolicLink() && index < paths.length - 1) {
      throw new RepositoryScanError(
        'path_symlink',
        `Refusing repository path with a symlinked component: ${currentPath}`,
      );
    }
    if (index < paths.length - 1 && !state.isDirectory()) {
      throw new RepositoryScanError(
        'path_component_not_directory',
        `Repository path component is not a directory: ${currentPath}`,
      );
    }
    states.push({ path: currentPath, state });
  }
  return { complete: true, states };
};

const assertMissingPathUnchanged = async (
  missingPath: string | undefined,
  code: 'directory_changed' | 'manifest_changed',
  candidate: string,
): Promise<void> => {
  if (missingPath === undefined) {
    return;
  }
  try {
    await lstat(missingPath, { bigint: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
  throw new RepositoryScanError(
    code,
    `Repository input changed during inspection: ${candidate}`,
  );
};

const assertPathChainUnchanged = async (
  before: readonly PathState[],
  code: 'directory_changed' | 'manifest_changed',
  candidate: string,
): Promise<void> => {
  for (const item of before) {
    let after: BigIntStats;
    try {
      after = await lstat(item.path, { bigint: true });
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new RepositoryScanError(
          code,
          `Repository input changed during inspection: ${candidate}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (
      item.state.isSymbolicLink() !== after.isSymbolicLink() ||
      !sameFileState(item.state, after)
    ) {
      throw new RepositoryScanError(
        code,
        `Repository input changed during inspection: ${candidate}`,
      );
    }
  }
};

const assertPathInspectionUnchanged = async (
  inspection: PathChainInspection,
  code: 'directory_changed' | 'manifest_changed',
  candidate: string,
): Promise<void> => {
  await assertMissingPathUnchanged(inspection.missingPath, code, candidate);
  await assertPathChainUnchanged(inspection.states, code, candidate);
};

const nodeRepositoryFileSystem: RepositoryFileSystem = {
  canonicalize: (candidate) => {
    assertSupportedFileSystemPlatform(candidate);
    return realpath(candidate);
  },
  inspect: async (root, candidate) => {
    const inspection = await inspectPathChain(root, candidate);
    await assertPathInspectionUnchanged(
      inspection,
      'directory_changed',
      candidate,
    );
    const state = inspection.states.at(-1)?.state;
    if (!inspection.complete || state === undefined) {
      return undefined;
    }
    return {
      kind: toEntryKind(state),
      size: Number(state.size),
      identity: [
        state.dev,
        state.ino,
        state.mode,
        state.size,
        state.mtimeNs,
        state.ctimeNs,
      ].join(':'),
    };
  },
  readBoundedText: async (root, candidate, maxBytes) => {
    const inspection = await inspectPathChain(root, candidate);
    const initialPathState = inspection.states.at(-1)?.state;
    if (!inspection.complete || initialPathState === undefined) {
      await assertPathInspectionUnchanged(
        inspection,
        'manifest_changed',
        candidate,
      );
      throw new RepositoryScanError(
        'manifest_read_failed',
        `Manifest disappeared before it could be read: ${candidate}`,
      );
    }
    if (!initialPathState.isFile()) {
      throw new RepositoryScanError(
        'manifest_not_regular',
        `Refusing to read a non-regular manifest: ${candidate}`,
      );
    }
    let handle;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new RepositoryScanError(
          'manifest_not_regular',
          `Refusing to read a non-regular manifest: ${candidate}`,
        );
      }
      if (!sameFileState(initialPathState, before)) {
        throw new RepositoryScanError(
          'manifest_changed',
          `Manifest changed before its bounded read began: ${candidate}`,
        );
      }
      if (before.size > BigInt(maxBytes)) {
        throw new RepositoryScanError(
          'manifest_too_large',
          `Manifest exceeds ${maxBytes} bytes: ${candidate}`,
        );
      }
      const content = Buffer.allocUnsafe(maxBytes + 1);
      let totalBytes = 0;
      while (totalBytes <= maxBytes) {
        const result = await handle.read(
          content,
          totalBytes,
          maxBytes + 1 - totalBytes,
          totalBytes,
        );
        if (result.bytesRead === 0) {
          break;
        }
        totalBytes += result.bytesRead;
      }
      if (totalBytes > maxBytes) {
        throw new RepositoryScanError(
          'manifest_too_large',
          `Manifest exceeds ${maxBytes} bytes: ${candidate}`,
        );
      }
      const after = await handle.stat({ bigint: true });
      if (!sameFileState(before, after) || after.size !== BigInt(totalBytes)) {
        throw new RepositoryScanError(
          'manifest_changed',
          `Manifest changed during its bounded read: ${candidate}`,
        );
      }
      await assertPathInspectionUnchanged(
        inspection,
        'manifest_changed',
        candidate,
      );
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(
          content.subarray(0, totalBytes),
        );
      } catch (error) {
        throw new RepositoryScanError(
          'manifest_invalid_utf8',
          `Manifest is not valid UTF-8 text: ${candidate}`,
          { cause: error },
        );
      }
    } finally {
      await handle?.close();
    }
  },
  list: async (root, candidate, maxEntries) => {
    const inspection = await inspectPathChain(root, candidate);
    const initialState = inspection.states.at(-1)?.state;
    if (!inspection.complete || initialState === undefined) {
      await assertPathInspectionUnchanged(
        inspection,
        'directory_changed',
        candidate,
      );
      return [];
    }
    if (initialState.isSymbolicLink()) {
      throw new RepositoryScanError(
        'path_symlink',
        `Refusing repository directory symlink: ${candidate}`,
      );
    }
    if (!initialState.isDirectory()) {
      throw new RepositoryScanError(
        'path_component_not_directory',
        `Expected a repository directory: ${candidate}`,
      );
    }
    const entries: RepositoryDirectoryEntry[] = [];
    let directory;
    try {
      directory = await opendir(candidate);
      for await (const entry of directory) {
        entries.push({
          name: entry.name,
          kind: toEntryKind(entry),
        });
        if (entries.length > maxEntries) {
          throw new RepositoryScanError(
            'directory_entry_limit_exceeded',
            `Directory exceeds ${maxEntries} entries: ${candidate}`,
          );
        }
      }
    } finally {
      await directory?.close().catch(() => undefined);
    }
    await assertPathInspectionUnchanged(
      inspection,
      'directory_changed',
      candidate,
    );
    return entries.sort((left, right) => compareText(left.name, right.name));
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

const digestToken = (...values: readonly string[]): string =>
  createHash('sha256')
    .update(values.join('\u0000'))
    .digest('hex')
    .slice(0, 20)
    .toUpperCase();

const scopedId = (prefix: string, location: string, qualifier = ''): string =>
  `${prefix}-${digestToken(location, qualifier)}`;

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

const normalizeInputPath = (relativePath: string): string => {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.length === 0 ? '.' : normalized;
};

const manifestDirectory = (relativePath: string): string => {
  const directory = path.posix.dirname(normalizeRelativePath(relativePath));
  return directory === '.' ? '' : directory;
};

const pathFromDirectory = (directory: string, name: string): string =>
  directory.length === 0 ? name : `${directory}/${name}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  (() => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
      return undefined;
    }
    if (normalized.length > MAX_MANIFEST_SCALAR_LENGTH) {
      throw new ManifestParseError(
        `Manifest scalar exceeds ${MAX_MANIFEST_SCALAR_LENGTH} characters.`,
      );
    }
    return normalized;
  })();

const stringRecord = (value: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entryValue]) => {
      const normalizedKey = stringValue(key);
      const normalizedValue = stringValue(entryValue);
      return normalizedKey === undefined || normalizedValue === undefined
        ? []
        : [[normalizedKey, normalizedValue] as const];
    }),
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

const assertDeclarationLimit = (
  values: readonly unknown[],
  label: string,
): void => {
  if (values.length > MAX_DECLARATIONS_PER_MANIFEST) {
    throw new ManifestParseError(
      `${label} exceeds ${MAX_DECLARATIONS_PER_MANIFEST} declarations.`,
    );
  }
};

const parsePackageManifest = (source: string): PackageManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ManifestParseError('package.json could not be decoded as JSON.', {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new ManifestParseError('package.json must contain an object.');
  }
  const dependencySections = [
    stringRecord(parsed.dependencies),
    stringRecord(parsed.devDependencies),
    stringRecord(parsed.peerDependencies),
  ];
  assertDeclarationLimit(
    dependencySections.flatMap((section) => Object.entries(section)),
    'package.json dependencies',
  );
  const dependencyVersions = new Map<string, Set<string>>();
  dependencySections.forEach((section) => {
    Object.entries(section).forEach(([name, version]) => {
      const versions = dependencyVersions.get(name) ?? new Set<string>();
      versions.add(version);
      dependencyVersions.set(name, versions);
    });
  });
  const dependencies = Object.fromEntries(
    [...dependencyVersions.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, versions]) => [name, [...versions].sort(compareText)]),
  );
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
      'project.profiles.profile',
      'project.profiles.profile.modules.module',
    ].includes(String(jPath)),
});

const resolveMavenProperty = (
  value: string | undefined,
  properties: Readonly<Record<string, unknown>>,
): string | undefined => {
  let current = value;
  const visited = new Set<string>();
  for (let step = 0; step < MAX_MAVEN_PROPERTY_RESOLUTION_STEPS; step += 1) {
    if (current === undefined) {
      return undefined;
    }
    const reference = /^\$\{([^}]+)\}$/.exec(current)?.[1];
    if (reference === undefined) {
      return current.includes('${') ? undefined : current;
    }
    if (visited.has(reference)) {
      return undefined;
    }
    visited.add(reference);
    current = stringValue(properties[reference]);
  }
  return undefined;
};

const parseMavenModel = (source: string, pomPath: string): MavenModel => {
  if (/<!DOCTYPE/i.test(source)) {
    throw new ManifestParseError('Maven POM must not contain a DOCTYPE.');
  }
  let validation;
  try {
    validation = SyntaxValidator.validate(source, {
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
  } catch (error) {
    throw new ManifestParseError('Maven XML is invalid.', { cause: error });
  }
  if (validation !== true) {
    throw new ManifestParseError(
      `Maven XML is invalid at line ${validation.err.line}, column ${validation.err.col}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = mavenParser.parse(source);
  } catch (error) {
    throw new ManifestParseError('Maven XML could not be decoded.', {
      cause: error,
    });
  }
  if (!isRecord(parsed) || !isRecord(parsed.project)) {
    throw new ManifestParseError(
      'Maven POM must contain one project root element.',
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
  assertDeclarationLimit(dependencies, 'Maven dependencies');
  assertDeclarationLimit(plugins, 'Maven plugins');
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
  const packaging = stringValue(project.packaging);
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

  const topLevelModules = isRecord(project.modules)
    ? stringArray(project.modules.module)
    : [];
  assertDeclarationLimit(topLevelModules, 'Maven modules');
  const moduleDeclarations: MavenModuleDeclaration[] = topLevelModules.map(
    (modulePath) => ({
      path: modulePath,
      selection: 'unconditional',
    }),
  );
  const profiles = isRecord(project.profiles)
    ? recordArray(project.profiles.profile)
    : [];
  assertDeclarationLimit(profiles, 'Maven profiles');
  profiles.forEach((profile, profileIndex) => {
    const profileModules = isRecord(profile.modules)
      ? stringArray(profile.modules.module)
      : [];
    assertDeclarationLimit(profileModules, 'Maven profile modules');
    if (
      moduleDeclarations.length + profileModules.length >
      MAX_DECLARATIONS_PER_MANIFEST
    ) {
      throw new ManifestParseError(
        `Maven modules exceeds ${MAX_DECLARATIONS_PER_MANIFEST} declarations.`,
      );
    }
    const profileId =
      stringValue(profile.id) ?? `unnamed-profile-${profileIndex + 1}`;
    const activation = isRecord(profile.activation) ? profile.activation : {};
    const activeByDefault =
      stringValue(activation.activeByDefault)?.toLowerCase() === 'true';
    const selection: ModuleSelection = activeByDefault
      ? 'default_candidate'
      : 'conditional';
    const context = activeByDefault
      ? `Maven profile "${profileId}" in ${pomPath} declares activeByDefault; effective activation was not evaluated.`
      : `Maven profile "${profileId}" in ${pomPath} requires explicit or condition-based activation; effective activation was not evaluated.`;
    profileModules.forEach((modulePath) => {
      moduleDeclarations.push({
        path: modulePath,
        selection,
        context,
      });
    });
  });

  return {
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(packaging === undefined ? {} : { packaging }),
    ...(javaVersion === undefined ? {} : { javaVersion }),
    ...(springBootVersion === undefined ? {} : { springBootVersion }),
    dependencyCoordinates,
    pluginCoordinates,
    modules: moduleDeclarations.sort((left, right) =>
      compareText(
        `${left.path}\u0000${left.selection}\u0000${left.context ?? ''}`,
        `${right.path}\u0000${right.selection}\u0000${right.context ?? ''}`,
      ),
    ),
  };
};

const evidenceFor = (
  purpose: string,
  description: string,
  location: string,
  type: EvidenceReference['type'] = 'build_configuration',
): EvidenceReference => {
  const normalizedLocation = normalizeInputPath(location);
  return {
    id: scopedId(`EV-${purpose}`, normalizedLocation),
    type,
    description,
    location: normalizedLocation,
    provider: 'filesystem',
  };
};

const compareEvidence = (
  left: EvidenceReference,
  right: EvidenceReference,
): number =>
  compareText(
    `${left.location}\u0000${left.id}`,
    `${right.location}\u0000${right.id}`,
  );

const mergeEvidence = (
  current: readonly EvidenceReference[],
  additional: EvidenceReference,
): EvidenceReference[] => {
  const existing = current.find((evidence) => evidence.id === additional.id);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(additional)) {
      throw new RepositoryScanError(
        'evidence_conflict',
        `Conflicting repository evidence definitions share ID ${additional.id}.`,
      );
    }
    return [...current];
  }
  return [...current, additional].sort(compareEvidence);
};

const mergeEvidenceLists = (
  current: readonly EvidenceReference[],
  additional: readonly EvidenceReference[],
): EvidenceReference[] =>
  additional.reduce(
    (merged, evidence) => mergeEvidence(merged, evidence),
    [...current],
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

const selectionRank = (selection: ModuleSelection): number =>
  (
    ({
      unconditional: 0,
      default_candidate: 1,
      conditional: 2,
      unknown: 3,
    }) as const
  )[selection];

const combineDiscovery = (
  parent: ProjectModuleDiscovery,
  declaration: ProjectModuleDiscovery,
): ProjectModuleDiscovery => {
  const selection =
    selectionRank(parent.selection) >= selectionRank(declaration.selection)
      ? parent.selection
      : declaration.selection;
  const contexts = [
    ...(parent.context === undefined ? [] : [parent.context]),
    ...(declaration.context === undefined ? [] : [declaration.context]),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort(compareText);
  return {
    basis: 'manifest_declaration',
    selection,
    ...(selection === 'default_candidate' || selection === 'conditional'
      ? {
          context:
            contexts.join(' ') ||
            'Inherited Maven module activation could not be resolved.',
        }
      : {}),
  };
};

const mergeDiscovery = (
  current: ProjectModuleDiscovery,
  incoming: ProjectModuleDiscovery,
): ProjectModuleDiscovery => {
  const basisRank = {
    manifest_declaration: 0,
    manifest_presence: 1,
    source_layout: 2,
  } as const;
  const selection =
    selectionRank(current.selection) <= selectionRank(incoming.selection)
      ? current.selection
      : incoming.selection;
  const contexts = [
    ...(current.context === undefined ? [] : [current.context]),
    ...(incoming.context === undefined ? [] : [incoming.context]),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort(compareText);
  const basis =
    basisRank[current.basis] <= basisRank[incoming.basis]
      ? current.basis
      : incoming.basis;
  return {
    basis,
    selection,
    ...(selection === 'default_candidate' || selection === 'conditional'
      ? {
          context:
            contexts.length <= 1
              ? (contexts[0] ??
                'Module activation context could not be resolved.')
              : 'Multiple Maven activation contexts were observed for this module; exact declarations remain available as evidence.',
        }
      : {}),
  };
};

const inputStatusRank = (status: CoverageInputStatus): number =>
  (
    ({
      observed: 0,
      skipped_by_limit: 1,
      unsupported: 2,
      parsed: 3,
      failed: 4,
    }) as const
  )[status];

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
      if (error instanceof RepositoryScanError) {
        throw error;
      }
      throw new RepositoryScanError(
        'repository_unavailable',
        `Could not access repository directory: ${repositoryPath}`,
        { cause: error },
      );
    }
    let rootEntry: RepositoryEntry | undefined;
    try {
      rootEntry = await this.fileSystem.inspect(
        canonicalRepositoryPath,
        canonicalRepositoryPath,
      );
    } catch (error) {
      if (error instanceof RepositoryScanError) {
        throw error;
      }
      throw new RepositoryScanError(
        'filesystem_inspection_failed',
        `Could not inspect repository directory: ${repositoryPath}`,
        { cause: error },
      );
    }
    if (rootEntry?.kind !== 'directory') {
      throw new RepositoryScanError(
        'repository_not_directory',
        `Repository path is not a directory: ${repositoryPath}`,
      );
    }

    const limits = DEFAULT_REPOSITORY_SCAN_LIMITS;
    const technologies = new Map<string, TechnologyAccumulator>();
    const observations = new Map<string, ProjectObservation>();
    const uncertainties = new Map<string, ProjectUncertainty>();
    const modules = new Map<string, ProjectModule>();
    const coverageInputs = new Map<string, CoverageInput>();
    const limitations = new Set<string>([
      '[SCOPED-STATIC-OBSERVATION] The filesystem provider performs bounded static observation and does not prove complete project or runtime architecture.',
      '[SUPPORTED-MANIFESTS] Only package.json and Maven pom.xml manifests are structurally parsed.',
      '[DISCOVERY-EXCLUSIONS] Free manifest discovery excludes hidden directories, coverage, dist, node_modules, and target directories.',
      '[MAVEN-EFFECTIVE-MODEL] Maven profile activation, remote parents, dependencyManagement, pluginManagement, and the complete effective model are not evaluated.',
    ]);
    const manifestReads = new Map<string, ManifestReadResult>();
    const packageManifests = new Set<string>();
    const mavenManifests = new Map<string, ParsedMavenManifest>();
    const expandedMavenContexts = new Map<string, string>();
    let manifestCount = 0;
    let totalManifestBytes = 0;
    let totalDeclaredModuleDeclarations = 0;
    let declaredModuleLimitReached = false;
    let detectedName = path.basename(canonicalRepositoryPath);
    let rootPackageName: string | undefined;

    const rootEvidence = evidenceFor(
      'REPOSITORY-ROOT',
      'The canonical repository root was inspected.',
      '.',
      'source_file',
    );

    const addCoverageInput = (
      relativePath: string,
      kind: CoverageInputKind,
      status: CoverageInputStatus,
      evidence: EvidenceReference | readonly EvidenceReference[],
    ): void => {
      const normalizedPath = normalizeInputPath(relativePath);
      const evidenceList = isEvidenceList(evidence) ? evidence : [evidence];
      const current = coverageInputs.get(normalizedPath);
      coverageInputs.set(normalizedPath, {
        path: normalizedPath,
        kind: current?.kind ?? kind,
        status:
          current === undefined ||
          inputStatusRank(status) > inputStatusRank(current.status)
            ? status
            : current.status,
        evidence:
          current === undefined
            ? [...evidenceList].sort(compareEvidence)
            : mergeEvidenceLists(current.evidence, evidenceList),
      });
    };

    addCoverageInput('.', 'directory', 'observed', rootEvidence);

    const addTechnology = (
      category: TechnologyCategory,
      name: string,
      evidence: EvidenceReference,
      version?: string,
    ): void => {
      const key = `${category}\u0000${name.toLowerCase()}`;
      const current = technologies.get(key);
      if (current === undefined) {
        technologies.set(key, {
          category,
          name,
          versions: new Set(version === undefined ? [] : [version]),
          evidence: [evidence],
        });
        return;
      }
      if (version !== undefined) {
        current.versions.add(version);
      }
      const mergedEvidence = mergeEvidence(current.evidence, evidence);
      current.evidence.splice(0, current.evidence.length, ...mergedEvidence);
    };

    const addObservation = (
      id: string,
      statement: string,
      evidence: EvidenceReference | readonly EvidenceReference[],
    ): void => {
      const evidenceList = isEvidenceList(evidence) ? evidence : [evidence];
      const current = observations.get(id);
      observations.set(id, {
        id,
        type: 'fact',
        statement,
        confidence: 1,
        evidence:
          current === undefined
            ? [...evidenceList].sort(compareEvidence)
            : mergeEvidenceLists(current.evidence, evidenceList),
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
      const current = uncertainties.get(id);
      uncertainties.set(id, {
        id,
        statement,
        impact,
        resolution_required:
          resolutionRequired || (current?.resolution_required ?? false),
        evidence:
          current === undefined
            ? [...evidenceList].sort(compareEvidence)
            : mergeEvidenceLists(current.evidence, evidenceList),
      });
    };

    const addModule = (
      relativePath: string,
      discovery: ProjectModuleDiscovery,
      evidence: EvidenceReference | readonly EvidenceReference[],
    ): boolean => {
      const resolved = resolveInside(canonicalRepositoryPath, relativePath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          'path_escape',
          `Module path escapes the repository: ${relativePath}`,
        );
      }
      const normalizedPath = normalizeRelativePath(
        path.relative(canonicalRepositoryPath, resolved),
      );
      if (normalizedPath.length === 0) {
        throw new RepositoryScanError(
          'path_escape',
          `Module path resolves to the repository root: ${relativePath}`,
        );
      }
      const evidenceList = isEvidenceList(evidence) ? evidence : [evidence];
      const current = modules.get(normalizedPath);
      if (current === undefined && modules.size >= limits.max_manifests) {
        limitations.add(
          '[MODULE-LIMIT] One or more candidate modules were omitted because the manifest/module output budget was reached.',
        );
        return false;
      }
      modules.set(normalizedPath, {
        name: normalizedPath,
        path: normalizedPath,
        status: 'candidate',
        discovery:
          current?.discovery === undefined
            ? discovery
            : mergeDiscovery(current.discovery, discovery),
        responsibilities: current?.responsibilities ?? [],
        evidence:
          current === undefined
            ? [...evidenceList].sort(compareEvidence)
            : mergeEvidenceLists(current.evidence, evidenceList),
      });
      return true;
    };

    const inspectRelative = async (
      relativePath: string,
    ): Promise<RepositoryEntry | undefined> => {
      const resolved = resolveInside(canonicalRepositoryPath, relativePath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          'path_escape',
          `Repository-relative path escapes the root: ${relativePath}`,
        );
      }
      try {
        return await this.fileSystem.inspect(canonicalRepositoryPath, resolved);
      } catch (error) {
        if (error instanceof RepositoryScanError) {
          throw error;
        }
        throw new RepositoryScanError(
          'filesystem_inspection_failed',
          `Could not inspect repository path: ${normalizeInputPath(relativePath)}`,
          { cause: error },
        );
      }
    };

    const listRelative = async (
      relativePath: string,
    ): Promise<readonly RepositoryDirectoryEntry[]> => {
      const resolved = resolveInside(canonicalRepositoryPath, relativePath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          'path_escape',
          `Repository-relative path escapes the root: ${relativePath}`,
        );
      }
      let entries: readonly RepositoryDirectoryEntry[];
      try {
        entries = await this.fileSystem.list(
          canonicalRepositoryPath,
          resolved,
          limits.max_entries_per_directory,
        );
      } catch (error) {
        if (error instanceof RepositoryScanError) {
          throw error;
        }
        throw new RepositoryScanError(
          'directory_read_failed',
          `Could not list repository directory: ${normalizeInputPath(relativePath)}`,
          { cause: error },
        );
      }
      if (entries.length > limits.max_entries_per_directory) {
        throw new RepositoryScanError(
          'directory_entry_limit_exceeded',
          `Directory exceeds ${limits.max_entries_per_directory} entries: ${normalizeInputPath(relativePath)}`,
        );
      }
      return [...entries].sort((left, right) =>
        compareText(left.name, right.name),
      );
    };

    const readManifest = async (
      relativePath: string,
    ): Promise<ManifestReadResult> => {
      const normalizedPath = normalizeRelativePath(relativePath);
      const cached = manifestReads.get(normalizedPath);
      if (cached !== undefined) {
        return cached;
      }
      if (manifestReads.size >= limits.max_manifests) {
        limitations.add(
          '[MANIFEST-LIMIT] One or more supported manifests were omitted because the global considered-manifest limit was reached.',
        );
        return { status: 'skipped_by_limit' };
      }
      const evidence = evidenceFor(
        'MANIFEST-INPUT',
        'A supported repository manifest was considered for bounded parsing.',
        normalizedPath,
      );
      const entry = await inspectRelative(normalizedPath);
      if (entry === undefined) {
        const result: ManifestReadResult = { status: 'missing' };
        manifestReads.set(normalizedPath, result);
        return result;
      }
      if (entry.kind === 'symlink') {
        throw new RepositoryScanError(
          'input_symlink',
          `Refusing to follow manifest symlink: ${normalizedPath}`,
        );
      }
      if (entry.kind !== 'file') {
        throw new RepositoryScanError(
          'manifest_not_regular',
          `Expected a regular manifest file: ${normalizedPath}`,
        );
      }
      if (entry.size > MAX_MANIFEST_BYTES) {
        throw new RepositoryScanError(
          'manifest_too_large',
          `Manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${normalizedPath}`,
        );
      }
      if (
        manifestCount >= limits.max_manifests ||
        totalManifestBytes + entry.size > limits.max_total_manifest_bytes
      ) {
        limitations.add(
          '[MANIFEST-LIMIT] One or more supported manifests were skipped because a global manifest-count or byte limit was reached.',
        );
        addCoverageInput(
          normalizedPath,
          'manifest',
          'skipped_by_limit',
          evidence,
        );
        const result: ManifestReadResult = { status: 'skipped_by_limit' };
        manifestReads.set(normalizedPath, result);
        return result;
      }
      const resolved = resolveInside(canonicalRepositoryPath, normalizedPath);
      if (resolved === undefined) {
        throw new RepositoryScanError(
          'path_escape',
          `Manifest path escapes the repository: ${normalizedPath}`,
        );
      }
      let source: string;
      try {
        source = await this.fileSystem.readBoundedText(
          canonicalRepositoryPath,
          resolved,
          MAX_MANIFEST_BYTES,
        );
      } catch (error) {
        if (error instanceof RepositoryScanError) {
          throw error;
        }
        throw new RepositoryScanError(
          'manifest_read_failed',
          `Could not read repository manifest: ${normalizedPath}`,
          { cause: error },
        );
      }
      manifestCount += 1;
      totalManifestBytes += Buffer.byteLength(source, 'utf8');
      const result: ManifestReadResult = { status: 'read', source };
      manifestReads.set(normalizedPath, result);
      return result;
    };

    const observeRegularInput = async (
      relativePath: string,
      kind: Exclude<CoverageInputKind, 'directory' | 'source_root'>,
      description: string,
    ): Promise<EvidenceReference | undefined> => {
      const normalizedPath = normalizeRelativePath(relativePath);
      const entry = await inspectRelative(normalizedPath);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.kind === 'symlink') {
        throw new RepositoryScanError(
          'input_symlink',
          `Refusing to follow repository input symlink: ${normalizedPath}`,
        );
      }
      if (entry.kind !== 'file') {
        throw new RepositoryScanError(
          'input_not_regular',
          `Expected a regular repository input file: ${normalizedPath}`,
        );
      }
      const evidence = evidenceFor(
        kind === 'lockfile' ? 'LOCKFILE' : 'CONFIGURATION',
        description,
        normalizedPath,
      );
      addCoverageInput(normalizedPath, kind, 'observed', evidence);
      return evidence;
    };

    const observeSourceRoot = async (
      relativePath: string,
      description: string,
    ): Promise<EvidenceReference | undefined> => {
      const normalizedPath = normalizeRelativePath(relativePath);
      const entry = await inspectRelative(normalizedPath);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.kind === 'symlink') {
        limitations.add(
          `[SOURCE-ROOT-SYMLINK] Candidate source root ${normalizedPath} was skipped because symlinks are not followed.`,
        );
        return undefined;
      }
      if (entry.kind !== 'directory') {
        return undefined;
      }
      const evidence = evidenceFor(
        'SOURCE-ROOT',
        description,
        normalizedPath,
        'source_file',
      );
      addCoverageInput(normalizedPath, 'source_root', 'observed', evidence);
      return evidence;
    };

    const processPackageManifest = async (
      packagePath: string,
    ): Promise<void> => {
      const normalizedPath = normalizeRelativePath(packagePath);
      if (packageManifests.has(normalizedPath)) {
        return;
      }
      packageManifests.add(normalizedPath);
      const read = await readManifest(normalizedPath);
      if (read.status !== 'read' || read.source === undefined) {
        return;
      }
      const packageEvidence = evidenceFor(
        'PACKAGE-MANIFEST',
        'Node.js package manifest was structurally parsed.',
        normalizedPath,
      );
      try {
        const manifest = parsePackageManifest(read.source);
        addCoverageInput(normalizedPath, 'manifest', 'parsed', packageEvidence);
        const baseDirectory = manifestDirectory(normalizedPath);
        if (baseDirectory.length === 0 && manifest.name !== undefined) {
          rootPackageName = manifest.name;
          detectedName = manifest.name;
        }
        if (baseDirectory.length > 0) {
          addModule(
            baseDirectory,
            {
              basis: 'manifest_presence',
              selection: 'unknown',
            },
            packageEvidence,
          );
        }
        const tsconfigPath = pathFromDirectory(baseDirectory, 'tsconfig.json');
        const tsconfigEvidence = await observeRegularInput(
          tsconfigPath,
          'configuration',
          'A TypeScript compiler configuration was observed.',
        );
        const typescriptVersions = (manifest.dependencies.typescript ?? []).map(
          (version) => version.replace(/^[~^]/, ''),
        );
        for (const typescriptVersion of typescriptVersions) {
          addTechnology(
            'language',
            'TypeScript',
            packageEvidence,
            typescriptVersion,
          );
        }
        if (tsconfigEvidence !== undefined) {
          if (typescriptVersions.length === 0) {
            addTechnology('language', 'TypeScript', tsconfigEvidence);
          } else {
            typescriptVersions.forEach((typescriptVersion) => {
              addTechnology(
                'language',
                'TypeScript',
                tsconfigEvidence,
                typescriptVersion,
              );
            });
          }
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
          },
          {
            key: 'pnpm',
            displayName: 'pnpm',
            lockfile: 'pnpm-lock.yaml',
          },
          {
            key: 'yarn',
            displayName: 'Yarn',
            lockfile: 'yarn.lock',
          },
        ] as const;
        const declaredPackageManager = manifest.packageManager
          ?.split('@')[0]
          ?.toLowerCase();
        const declaredManager = packageManagers.find(
          (manager) => manager.key === declaredPackageManager,
        );
        const presentLocks: {
          readonly manager: (typeof packageManagers)[number];
          readonly evidence: EvidenceReference;
        }[] = [];
        for (const manager of packageManagers) {
          const lockPath = pathFromDirectory(baseDirectory, manager.lockfile);
          const lockEvidence = await observeRegularInput(
            lockPath,
            'lockfile',
            `${manager.displayName} lockfile declares the package manager.`,
          );
          if (lockEvidence !== undefined) {
            presentLocks.push({ manager, evidence: lockEvidence });
          }
        }
        const managerConflict =
          presentLocks.length > 1 ||
          (declaredManager !== undefined &&
            presentLocks.some(
              ({ manager }) => manager.key !== declaredManager.key,
            ));
        const packageScope = scopedId('PACKAGE', normalizedPath);
        if (
          declaredPackageManager !== undefined &&
          declaredManager === undefined
        ) {
          addUncertainty(
            `${packageScope}-MANAGER-DECLARATION`,
            `Unsupported package-manager declaration in ${normalizedPath}: ${declaredPackageManager}.`,
            'Install and quality-gate commands cannot be selected reliably for this build root.',
            packageEvidence,
            true,
          );
        } else if (managerConflict) {
          const managerNames = [
            ...(declaredManager === undefined ? [] : [declaredManager.key]),
            ...presentLocks.map(({ manager }) => manager.key),
          ]
            .filter((value, index, values) => values.indexOf(value) === index)
            .sort(compareText);
          addUncertainty(
            `${packageScope}-MANAGER-CONFLICT`,
            `Conflicting package-manager evidence was found for ${normalizedPath}: ${managerNames.join(', ')}.`,
            'Install and quality-gate commands cannot be selected reliably for this build root.',
            [packageEvidence, ...presentLocks.map(({ evidence }) => evidence)],
            true,
          );
        } else if (declaredManager !== undefined) {
          addTechnology(
            'build_tool',
            declaredManager.displayName,
            packageEvidence,
          );
          const matchingLock = presentLocks.find(
            ({ manager }) => manager.key === declaredManager.key,
          );
          if (matchingLock !== undefined) {
            addTechnology(
              'build_tool',
              matchingLock.manager.displayName,
              matchingLock.evidence,
            );
          }
        } else if (presentLocks.length === 1) {
          const presentLock = presentLocks[0];
          if (presentLock !== undefined) {
            addTechnology(
              'build_tool',
              presentLock.manager.displayName,
              presentLock.evidence,
            );
          }
        } else {
          addUncertainty(
            `${packageScope}-MANAGER`,
            `No package-manager declaration or recognized lockfile was found for ${normalizedPath}.`,
            'Install and quality-gate commands cannot be selected reliably for this build root.',
            packageEvidence,
          );
        }
        frameworkPackages.forEach((displayName, packageName) => {
          (manifest.dependencies[packageName] ?? []).forEach((version) => {
            addTechnology(
              'framework',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          });
        });
        testFrameworkPackages.forEach((displayName, packageName) => {
          (manifest.dependencies[packageName] ?? []).forEach((version) => {
            addTechnology(
              'test_framework',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          });
        });
        qualityToolPackages.forEach((displayName, packageName) => {
          (manifest.dependencies[packageName] ?? []).forEach((version) => {
            addTechnology(
              'quality_tool',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          });
        });
        buildToolPackages.forEach((displayName, packageName) => {
          (manifest.dependencies[packageName] ?? []).forEach((version) => {
            addTechnology(
              'build_tool',
              displayName,
              packageEvidence,
              version.replace(/^[~^]/, ''),
            );
          });
        });
        if (baseDirectory.length === 0) {
          const sourceEvidence = await observeSourceRoot(
            'src',
            'A package-backed candidate source root was observed.',
          );
          if (sourceEvidence !== undefined) {
            addModule(
              'src',
              {
                basis: 'source_layout',
                selection: 'unconditional',
              },
              [packageEvidence, sourceEvidence],
            );
          }
        }
        addObservation(
          scopedId('OBS-PACKAGE-MANIFEST', normalizedPath),
          `${normalizedPath} declares a Node.js package and dependency model.`,
          packageEvidence,
        );
      } catch (error) {
        if (!(error instanceof ManifestParseError)) {
          throw error;
        }
        const parseEvidence = evidenceFor(
          'PACKAGE-MANIFEST-PARSE',
          error.message,
          normalizedPath,
        );
        addCoverageInput(normalizedPath, 'manifest', 'failed', parseEvidence);
        addUncertainty(
          scopedId('UNCERTAINTY-PACKAGE-MANIFEST', normalizedPath),
          `${normalizedPath} exists but is not a valid supported package manifest.`,
          'Node.js technologies and project identity may be incomplete.',
          parseEvidence,
          true,
        );
      }
    };

    const analyzeMavenManifest = async (
      pomPath: string,
    ): Promise<ParsedMavenManifest> => {
      const normalizedPath = normalizeRelativePath(pomPath);
      const cached = mavenManifests.get(normalizedPath);
      if (cached !== undefined) {
        return cached;
      }
      const read = await readManifest(normalizedPath);
      const mavenEvidence = evidenceFor(
        'MAVEN-MANIFEST',
        'Maven project model was structurally parsed.',
        normalizedPath,
      );
      if (read.status !== 'read' || read.source === undefined) {
        const result = { evidence: mavenEvidence };
        mavenManifests.set(normalizedPath, result);
        return result;
      }
      try {
        const model = parseMavenModel(read.source, normalizedPath);
        addCoverageInput(normalizedPath, 'manifest', 'parsed', mavenEvidence);
        if (
          normalizedPath === 'pom.xml' &&
          rootPackageName === undefined &&
          model.artifactId !== undefined
        ) {
          detectedName = model.artifactId;
        }
        addTechnology('build_tool', 'Maven', mavenEvidence);
        const baseDirectory = manifestDirectory(normalizedPath);
        const javaSourcePath = pathFromDirectory(
          baseDirectory,
          'src/main/java',
        );
        const javaSourceEvidence =
          model.packaging === 'pom'
            ? undefined
            : await observeSourceRoot(
                javaSourcePath,
                'A Java production source root was observed.',
              );
        if (model.javaVersion !== undefined) {
          addTechnology('language', 'Java', mavenEvidence, model.javaVersion);
        }
        if (javaSourceEvidence !== undefined) {
          addTechnology(
            'language',
            'Java',
            javaSourceEvidence,
            model.javaVersion,
          );
          if (baseDirectory.length === 0) {
            addModule(
              javaSourcePath,
              {
                basis: 'source_layout',
                selection: 'unconditional',
              },
              [mavenEvidence, javaSourceEvidence],
            );
          }
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
            'org.springframework',
            /^spring-(?!boot)/,
          )
        ) {
          addTechnology('framework', 'Spring Framework', mavenEvidence);
        }
        if (
          hasMavenCoordinate(
            model.dependencyCoordinates,
            'org.springframework.security',
            /^spring-security(?:-|$)/,
          )
        ) {
          addTechnology('framework', 'Spring Security', mavenEvidence);
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
        addObservation(
          scopedId('OBS-MAVEN-MANIFEST', normalizedPath),
          `${normalizedPath} declares a Maven project model.`,
          mavenEvidence,
        );
        const result = { model, evidence: mavenEvidence };
        mavenManifests.set(normalizedPath, result);
        return result;
      } catch (error) {
        if (!(error instanceof ManifestParseError)) {
          throw error;
        }
        const parseEvidence = evidenceFor(
          'MAVEN-MANIFEST-PARSE',
          error.message,
          normalizedPath,
        );
        addCoverageInput(normalizedPath, 'manifest', 'failed', parseEvidence);
        addUncertainty(
          scopedId('UNCERTAINTY-MAVEN-MANIFEST', normalizedPath),
          `${normalizedPath} exists but is not a valid supported Maven project model.`,
          'Maven, Java, framework, and module declarations may be incomplete.',
          parseEvidence,
          true,
        );
        const result = { evidence: parseEvidence };
        mavenManifests.set(normalizedPath, result);
        return result;
      }
    };

    const resolveDeclaredModule = (
      declaringPom: string,
      modulePath: string,
    ): string | undefined => {
      if (
        modulePath.length > MAX_MANIFEST_SCALAR_LENGTH ||
        modulePath.includes('\\') ||
        path.posix.isAbsolute(modulePath) ||
        /^[A-Za-z]:/u.test(modulePath)
      ) {
        return undefined;
      }
      const declaringDirectory = manifestDirectory(declaringPom);
      const resolved = resolveInside(
        canonicalRepositoryPath,
        pathFromDirectory(declaringDirectory, modulePath),
      );
      if (resolved === undefined) {
        return undefined;
      }
      const relative = normalizeRelativePath(
        path.relative(canonicalRepositoryPath, resolved),
      );
      return relative.length === 0 ||
        relative.length > MAX_MANIFEST_SCALAR_LENGTH
        ? undefined
        : relative;
    };

    const traverseMavenModules = async (
      pomPath: string,
      inheritedDiscovery: ProjectModuleDiscovery,
      depth: number,
      ancestors: ReadonlySet<string>,
    ): Promise<void> => {
      if (declaredModuleLimitReached) {
        return;
      }
      const normalizedPomPath = normalizeRelativePath(pomPath);
      const expansionKey = `${normalizedPomPath}\u0000${inheritedDiscovery.selection}`;
      const expansionContext = inheritedDiscovery.context ?? '';
      const previousExpansionContext = expandedMavenContexts.get(expansionKey);
      if (previousExpansionContext !== undefined) {
        if (previousExpansionContext !== expansionContext) {
          limitations.add(
            '[MAVEN-ACTIVATION-CONTEXTS] Repeated Maven manifests reached through multiple activation contexts were normalized by selection class to keep traversal bounded.',
          );
        }
        return;
      }
      expandedMavenContexts.set(expansionKey, expansionContext);
      const parsed = await analyzeMavenManifest(normalizedPomPath);
      if (parsed.model === undefined) {
        return;
      }
      for (const declaration of parsed.model.modules) {
        if (
          totalDeclaredModuleDeclarations >=
          limits.max_declared_module_declarations
        ) {
          declaredModuleLimitReached = true;
          limitations.add(
            '[DECLARED-MODULE-LIMIT] Maven module traversal stopped because the global declaration-processing limit was reached.',
          );
          return;
        }
        totalDeclaredModuleDeclarations += 1;
        const uncertaintyId = scopedId(
          'UNCERTAINTY-MAVEN-MODULE',
          normalizedPomPath,
          declaration.path,
        );
        const modulePath = resolveDeclaredModule(
          normalizedPomPath,
          declaration.path,
        );
        if (modulePath === undefined) {
          addUncertainty(
            uncertaintyId,
            `Maven manifest ${normalizedPomPath} declares an invalid module path: "${declaration.path}".`,
            'The module was excluded because it is absolute, non-portable, resolves to the repository root, or escapes the repository.',
            parsed.evidence,
            true,
          );
          continue;
        }
        const moduleEntry = await inspectRelative(modulePath);
        if (moduleEntry?.kind !== 'directory') {
          addUncertainty(
            uncertaintyId,
            `Maven manifest ${normalizedPomPath} declares module "${declaration.path}", but ${modulePath} is not a regular directory.`,
            'The declared module could not be inspected and was excluded from the candidate module map.',
            parsed.evidence,
            true,
          );
          continue;
        }
        const childPomPath = pathFromDirectory(modulePath, 'pom.xml');
        const childPomEntry = await inspectRelative(childPomPath);
        if (childPomEntry?.kind === 'symlink') {
          throw new RepositoryScanError(
            'input_symlink',
            `Refusing to follow manifest symlink: ${childPomPath}`,
          );
        }
        if (childPomEntry?.kind !== 'file') {
          addUncertainty(
            uncertaintyId,
            `Maven manifest ${normalizedPomPath} declares module "${declaration.path}", but ${childPomPath} is not a regular file.`,
            'The declared module could not be parsed and was excluded from the candidate module map.',
            parsed.evidence,
            true,
          );
          continue;
        }
        const declarationDiscovery: ProjectModuleDiscovery = {
          basis: 'manifest_declaration',
          selection: declaration.selection,
          ...(declaration.context === undefined
            ? {}
            : { context: declaration.context }),
        };
        const effectiveDiscovery = combineDiscovery(
          inheritedDiscovery,
          declarationDiscovery,
        );
        const declarationEvidence = evidenceFor(
          `MAVEN-MODULE-${digestToken(
            modulePath,
            declaration.selection,
            declaration.context ?? '',
          )}`,
          declaration.context === undefined
            ? `${normalizedPomPath} unconditionally declares module ${modulePath}.`
            : `${normalizedPomPath} declares module ${modulePath} with profile-bound selection.`,
          normalizedPomPath,
        );
        const moduleRecorded = addModule(modulePath, effectiveDiscovery, [
          parsed.evidence,
          declarationEvidence,
        ]);
        if (!moduleRecorded) {
          break;
        }
        if (ancestors.has(childPomPath)) {
          addUncertainty(
            scopedId(
              'UNCERTAINTY-MAVEN-MODULE-CYCLE',
              normalizedPomPath,
              childPomPath,
            ),
            `Maven module traversal encountered a cycle at ${childPomPath}.`,
            'Recursive module observation stopped at the repeated manifest.',
            [parsed.evidence, declarationEvidence],
            true,
          );
          continue;
        }
        if (depth >= limits.max_declared_module_depth) {
          const childEvidence = evidenceFor(
            'MANIFEST-INPUT',
            'A declared Maven module manifest was skipped at the recursion limit.',
            childPomPath,
          );
          limitations.add(
            '[DECLARED-MODULE-DEPTH] One or more declared Maven modules were not parsed because the declared-module depth limit was reached.',
          );
          addCoverageInput(
            childPomPath,
            'manifest',
            'skipped_by_limit',
            childEvidence,
          );
          continue;
        }
        await traverseMavenModules(
          childPomPath,
          effectiveDiscovery,
          depth + 1,
          new Set([...ancestors, childPomPath]),
        );
      }
    };

    const rootPomEntry = await inspectRelative('pom.xml');
    if (rootPomEntry?.kind === 'symlink') {
      throw new RepositoryScanError(
        'input_symlink',
        'Refusing to follow manifest symlink: pom.xml',
      );
    }
    if (rootPomEntry?.kind === 'file') {
      await traverseMavenModules(
        'pom.xml',
        {
          basis: 'manifest_presence',
          selection: 'unconditional',
        },
        0,
        new Set(['pom.xml']),
      );
    } else if (rootPomEntry !== undefined) {
      throw new RepositoryScanError(
        'manifest_not_regular',
        'Expected a regular manifest file: pom.xml',
      );
    }

    const rootPackageEntry = await inspectRelative('package.json');
    if (rootPackageEntry?.kind === 'symlink') {
      throw new RepositoryScanError(
        'input_symlink',
        'Refusing to follow manifest symlink: package.json',
      );
    }
    if (rootPackageEntry?.kind === 'file') {
      await processPackageManifest('package.json');
    } else if (rootPackageEntry !== undefined) {
      throw new RepositoryScanError(
        'manifest_not_regular',
        'Expected a regular manifest file: package.json',
      );
    }

    const discoveryQueue: { readonly path: string; readonly depth: number }[] =
      [{ path: '', depth: 0 }];
    const queuedDirectories = new Set(['']);
    let listedDirectoryCount = 0;
    while (discoveryQueue.length > 0) {
      discoveryQueue.sort(
        (left, right) =>
          left.depth - right.depth || compareText(left.path, right.path),
      );
      const current = discoveryQueue.shift();
      if (current === undefined) {
        break;
      }
      if (listedDirectoryCount >= limits.max_directories) {
        limitations.add(
          '[DIRECTORY-LIMIT] Free manifest discovery stopped because the global directory limit was reached.',
        );
        break;
      }
      listedDirectoryCount += 1;
      const entries = await listRelative(current.path);
      const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
      const pomEntry = entryByName.get('pom.xml');
      if (pomEntry?.kind === 'symlink') {
        throw new RepositoryScanError(
          'input_symlink',
          `Refusing to follow manifest symlink: ${pathFromDirectory(current.path, 'pom.xml')}`,
        );
      }
      if (pomEntry?.kind === 'file') {
        const pomPath = pathFromDirectory(current.path, 'pom.xml');
        if (current.path.length > 0) {
          const pomEvidence = evidenceFor(
            'MAVEN-MANIFEST-DISCOVERY',
            'A nested Maven build root was discovered by bounded traversal.',
            pomPath,
          );
          const moduleRecorded = addModule(
            current.path,
            {
              basis: 'manifest_presence',
              selection: 'unknown',
            },
            pomEvidence,
          );
          if (!moduleRecorded) {
            continue;
          }
        }
        await traverseMavenModules(
          pomPath,
          {
            basis: 'manifest_presence',
            selection: current.path.length === 0 ? 'unconditional' : 'unknown',
          },
          0,
          new Set([pomPath]),
        );
      } else if (pomEntry !== undefined) {
        throw new RepositoryScanError(
          'manifest_not_regular',
          `Expected a regular manifest file: ${pathFromDirectory(current.path, 'pom.xml')}`,
        );
      }
      const packageEntry = entryByName.get('package.json');
      if (packageEntry?.kind === 'symlink') {
        throw new RepositoryScanError(
          'input_symlink',
          `Refusing to follow manifest symlink: ${pathFromDirectory(current.path, 'package.json')}`,
        );
      }
      if (packageEntry?.kind === 'file') {
        await processPackageManifest(
          pathFromDirectory(current.path, 'package.json'),
        );
      } else if (packageEntry !== undefined) {
        throw new RepositoryScanError(
          'manifest_not_regular',
          `Expected a regular manifest file: ${pathFromDirectory(current.path, 'package.json')}`,
        );
      }
      for (const [name, description] of UNSUPPORTED_MANIFEST_NAMES) {
        const entry = entryByName.get(name);
        if (entry?.kind !== 'file') {
          continue;
        }
        const unsupportedPath = pathFromDirectory(current.path, name);
        const evidence = evidenceFor(
          'UNSUPPORTED-MANIFEST',
          description,
          unsupportedPath,
        );
        addCoverageInput(unsupportedPath, 'manifest', 'unsupported', evidence);
        limitations.add(`[UNSUPPORTED-MANIFEST] ${description}`);
      }
      const childDirectories = entries.filter(
        (entry) =>
          entry.kind === 'directory' &&
          !entry.name.startsWith('.') &&
          !FREE_DISCOVERY_EXCLUSIONS.has(entry.name),
      );
      if (
        current.depth >= limits.max_discovery_depth &&
        childDirectories.length > 0
      ) {
        limitations.add(
          '[DISCOVERY-DEPTH] Free manifest discovery did not inspect directories below the configured depth limit.',
        );
        continue;
      }
      for (const child of childDirectories) {
        const childPath = pathFromDirectory(current.path, child.name);
        if (!queuedDirectories.has(childPath)) {
          if (queuedDirectories.size >= limits.max_directories) {
            limitations.add(
              '[DIRECTORY-LIMIT] Free manifest discovery skipped one or more directories because the global directory limit was reached.',
            );
            break;
          }
          queuedDirectories.add(childPath);
          discoveryQueue.push({
            path: childPath,
            depth: current.depth + 1,
          });
        }
      }
    }

    let finalRootEntry: RepositoryEntry | undefined;
    try {
      finalRootEntry = await this.fileSystem.inspect(
        canonicalRepositoryPath,
        canonicalRepositoryPath,
      );
    } catch (error) {
      if (error instanceof RepositoryScanError) {
        throw error;
      }
      throw new RepositoryScanError(
        'directory_changed',
        'Repository root changed before observation completed.',
        { cause: error },
      );
    }
    if (
      finalRootEntry?.kind !== 'directory' ||
      finalRootEntry.identity !== rootEntry.identity
    ) {
      throw new RepositoryScanError(
        'directory_changed',
        'Repository root changed before observation completed.',
      );
    }

    if (observations.size === 0) {
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

    addUncertainty(
      'UNCERTAINTY-REPOSITORY-OBSERVATION-COVERAGE',
      'Repository observation is partial within the scanner’s declared scope.',
      'Absence from this profile means not observed within bounded supported capabilities, not proven absent from the repository.',
      rootEvidence,
    );

    const normalizedTechnologies: Technology[] = [
      ...technologies.entries(),
    ].map(([key, technology]) => {
      const versions = [...technology.versions].sort(compareText);
      if (versions.length > 1) {
        addUncertainty(
          scopedId('UNCERTAINTY-TECHNOLOGY-VERSION', key),
          `${technology.name} has conflicting observed versions: ${versions.join(', ')}.`,
          'The aggregate project profile omits a single version because multiple build roots disagree.',
          technology.evidence,
          true,
        );
      }
      return {
        category: technology.category,
        name: technology.name,
        ...(versions.length === 1 ? { version: versions[0] } : {}),
        evidence: [...technology.evidence].sort(compareEvidence),
      };
    });

    const observationCoverage: RepositoryObservationCoverage = {
      status: 'partial',
      provider: {
        id: 'filesystem',
        contract_version: FILESYSTEM_PROVIDER_CONTRACT_VERSION,
      },
      capabilities: [
        { id: 'CAP-BOUNDED-MANIFEST-DISCOVERY', status: 'partial' },
        { id: 'CAP-MAVEN-DECLARED-MODULES', status: 'supported' },
        { id: 'CAP-MAVEN-EFFECTIVE-MODEL', status: 'unsupported' },
        { id: 'CAP-MAVEN-PROFILE-MODULES', status: 'partial' },
        { id: 'CAP-NODE-PACKAGE-MANIFEST', status: 'supported' },
        { id: 'CAP-RUNTIME-ARCHITECTURE', status: 'unsupported' },
      ],
      inputs: [...coverageInputs.values()].sort((left, right) =>
        compareText(left.path, right.path),
      ),
      limits: { ...limits },
      limitations: [...limitations].sort(compareText),
    };

    const name = options.name ?? detectedName;
    const profile: ProjectProfile = {
      schema_version: 1,
      kind: 'project_profile',
      id: options.id ?? `PROJECT-${stableToken(name)}`,
      name,
      technologies: normalizedTechnologies.sort((left, right) =>
        compareText(
          `${left.category}\u0000${left.name}`,
          `${right.category}\u0000${right.name}`,
        ),
      ),
      modules: [...modules.values()].sort((left, right) =>
        compareText(left.path, right.path),
      ),
      observations: [...observations.values()].sort((left, right) =>
        compareText(left.id, right.id),
      ),
      constraints: [],
      uncertainties: [...uncertainties.values()].sort((left, right) =>
        compareText(left.id, right.id),
      ),
      observation_coverage: observationCoverage,
    };

    return ProjectProfileSchema.parse(profile);
  }
}
