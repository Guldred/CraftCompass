#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const INSTALL_MANIFEST = 'install-manifest.json';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_FILES = 20_000;
const MAX_PACKAGE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_DEPTH = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const MODE_PATTERN = /^(?:0444|0555)$/u;
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
const UNSAFE_NODE_ENVIRONMENT = [
  'DYLD_INSERT_LIBRARIES',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
];
const STRIPPED_RUNTIME_ENVIRONMENT = [
  ...UNSAFE_NODE_ENVIRONMENT,
  'NODE_COMPILE_CACHE',
  'NODE_V8_COVERAGE',
];
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const usage = [
  'Usage:',
  '  craftcompass.mjs home',
  '  craftcompass.mjs doctor',
  '  craftcompass.mjs run <craft-command> <arguments...>',
].join('\n');

const fail = (message, exitCode = 1) => {
  process.stderr.write(`CraftCompass launcher: ${message}\n`);
  process.exit(exitCode);
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const resolveSkillRoot = () => {
  const scriptPath = realpathSync(fileURLToPath(import.meta.url));
  return realpathSync(path.resolve(path.dirname(scriptPath), '..'));
};

const isSupportedNode = (version) => {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return false;
  }
  const [major, minor, patch] = parts;
  return (
    (major === 22 && (minor > 23 || (minor === 23 && patch >= 1))) ||
    (major === 24 && (minor > 18 || (minor === 18 && patch >= 0)))
  );
};

const sameFileState = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const fileMode = (state) =>
  `0${Number(state.mode & 0o777n)
    .toString(8)
    .padStart(3, '0')}`;

const expectedOwner =
  typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;

const assertTrustedRegularFile = (state, filePath, expectedMode) => {
  if (!state.isFile() || state.isSymbolicLink()) {
    throw new Error(`expected a regular no-follow file: ${filePath}`);
  }
  if (state.nlink !== 1n) {
    throw new Error(`hard-linked package file is forbidden: ${filePath}`);
  }
  if (expectedOwner !== null && state.uid !== expectedOwner) {
    throw new Error(`package file has an unexpected owner: ${filePath}`);
  }
  if (fileMode(state) !== expectedMode) {
    throw new Error(
      `package file mode mismatch at ${filePath}: expected ${expectedMode}, found ${fileMode(
        state,
      )}`,
    );
  }
};

const readStableRegularFile = (filePath, maximumBytes, expectedMode) => {
  const linkState = lstatSync(filePath, { bigint: true });
  assertTrustedRegularFile(linkState, filePath, expectedMode);
  if (linkState.size > BigInt(maximumBytes)) {
    throw new Error(`file exceeds ${maximumBytes} bytes: ${filePath}`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    assertTrustedRegularFile(before, filePath, expectedMode);
    if (!sameFileState(linkState, before)) {
      throw new Error(`file identity changed before read: ${filePath}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      !sameFileState(before, after)
    ) {
      throw new Error(`file identity changed during read: ${filePath}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

const parseInstallManifest = (skillRoot) => {
  const manifestPath = path.join(skillRoot, INSTALL_MANIFEST);
  const bytes = readStableRegularFile(manifestPath, MAX_MANIFEST_BYTES, '0444');
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`invalid install manifest: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort(compareText).join(',') !==
      'files,schema_version,source_commit,source_dirty' ||
    value.schema_version !== 1 ||
    typeof value.source_commit !== 'string' ||
    !COMMIT_PATTERN.test(value.source_commit) ||
    typeof value.source_dirty !== 'boolean' ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_PACKAGE_FILES
  ) {
    throw new Error('install manifest has an invalid top-level contract');
  }

  const files = value.files.map((entry, index) => {
    if (
      entry === null ||
      Array.isArray(entry) ||
      typeof entry !== 'object' ||
      Object.keys(entry).sort(compareText).join(',') !==
        'bytes,mode,path,sha256' ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.includes('\\') ||
      path.posix.isAbsolute(entry.path) ||
      entry.path
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..') ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_PACKAGE_FILE_BYTES ||
      typeof entry.mode !== 'string' ||
      !MODE_PATTERN.test(entry.mode) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error(`install manifest file entry ${index} is invalid`);
    }
    return {
      path: entry.path,
      bytes: entry.bytes,
      mode: entry.mode,
      sha256: entry.sha256,
    };
  });
  const sorted = [...files].sort((left, right) =>
    compareText(left.path, right.path),
  );
  if (
    files.some((entry, index) => entry.path !== sorted[index]?.path) ||
    sorted.some((entry, index) => entry.path === sorted[index - 1]?.path)
  ) {
    throw new Error(
      'install manifest file paths must be unique and stably sorted',
    );
  }
  return {
    sourceCommit: value.source_commit,
    sourceDirty: value.source_dirty,
    manifestDigest: createHash('sha256').update(bytes).digest('hex'),
    files,
  };
};

const collectPackageFiles = (skillRoot) => {
  const collected = [];
  let totalBytes = 0;

  const visit = (directory, relativeDirectory, depth) => {
    if (depth > MAX_PACKAGE_DEPTH) {
      throw new Error(`package traversal exceeds depth ${MAX_PACKAGE_DEPTH}`);
    }
    const directoryState = lstatSync(directory, { bigint: true });
    if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
      throw new Error(`expected a regular package directory: ${directory}`);
    }
    if (fileMode(directoryState) !== '0555') {
      throw new Error(`package directory mode is not 0555: ${directory}`);
    }
    if (expectedOwner !== null && directoryState.uid !== expectedOwner) {
      throw new Error(
        `package directory has an unexpected owner: ${directory}`,
      );
    }
    if (realpathSync(directory) !== path.resolve(directory)) {
      throw new Error(`package directory path is aliased: ${directory}`);
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      if (relativePath === INSTALL_MANIFEST) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const state = lstatSync(absolutePath, { bigint: true });
      if (state.isSymbolicLink()) {
        throw new Error(
          `package contains a forbidden symlink: ${relativePath}`,
        );
      }
      if (state.isDirectory()) {
        visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!state.isFile()) {
        throw new Error(
          `package contains a non-regular entry: ${relativePath}`,
        );
      }
      if (collected.length >= MAX_PACKAGE_FILES) {
        throw new Error(`package exceeds ${MAX_PACKAGE_FILES} files`);
      }
      const mode = fileMode(state);
      if (!MODE_PATTERN.test(mode)) {
        throw new Error(`package file has a forbidden mode: ${relativePath}`);
      }
      const bytes = readStableRegularFile(
        absolutePath,
        MAX_PACKAGE_FILE_BYTES,
        mode,
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
      }
      collected.push({
        path: relativePath,
        bytes: bytes.byteLength,
        mode,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    const directoryAfter = lstatSync(directory, { bigint: true });
    if (!sameFileState(directoryState, directoryAfter)) {
      throw new Error(
        `package directory changed during inspection: ${directory}`,
      );
    }
  };

  visit(skillRoot, '', 0);
  return collected;
};

const verifyPackage = (skillRoot) => {
  const manifest = parseInstallManifest(skillRoot);
  const expectedDirectory = `${manifest.sourceCommit}-${manifest.manifestDigest}`;
  if (path.basename(skillRoot) !== expectedDirectory) {
    throw new Error(
      `package directory identity mismatch: expected ${expectedDirectory}`,
    );
  }
  const actualFiles = collectPackageFiles(skillRoot);
  if (actualFiles.length !== manifest.files.length) {
    throw new Error(
      `package file count mismatch: expected ${manifest.files.length}, found ${actualFiles.length}`,
    );
  }
  for (const [index, expected] of manifest.files.entries()) {
    const actual = actualFiles[index];
    if (
      actual?.path !== expected.path ||
      actual.bytes !== expected.bytes ||
      actual.mode !== expected.mode ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`package integrity mismatch at ${expected.path}`);
    }
  }
  const runtimeMain = path.join(skillRoot, 'runtime', 'craft.mjs');
  if (!manifest.files.some((entry) => entry.path === 'runtime/craft.mjs')) {
    throw new Error(
      'package manifest does not identify the runtime entrypoint',
    );
  }
  return {
    sourceCommit: manifest.sourceCommit,
    sourceDirty: manifest.sourceDirty,
    runtimeMain,
  };
};

const inspectEnvironment = () => {
  const platformSupported = SUPPORTED_PLATFORMS.has(process.platform);
  const nodeSupported = isSupportedNode(process.versions.node);
  const unsafeEnvironment = UNSAFE_NODE_ENVIRONMENT.filter(
    (name) => (process.env[name] ?? '').length > 0,
  );
  let skillRoot;
  try {
    skillRoot = resolveSkillRoot();
  } catch (error) {
    const checks = [
      {
        id: 'platform',
        status: platformSupported ? 'passed' : 'failed',
        code: platformSupported ? 'supported_platform' : 'unsupported_platform',
        actual: process.platform,
      },
      {
        id: 'node',
        status: nodeSupported ? 'passed' : 'failed',
        code: nodeSupported ? 'supported_node' : 'unsupported_node',
        expected: '^22.23.1 || ^24.18.0',
        actual: process.versions.node,
      },
      {
        id: 'node_environment',
        status: unsafeEnvironment.length === 0 ? 'passed' : 'failed',
        code:
          unsafeEnvironment.length === 0
            ? 'safe_node_environment'
            : 'unsafe_node_environment',
        actual: unsafeEnvironment.length === 0 ? [] : unsafeEnvironment.sort(),
      },
      {
        id: 'package_integrity',
        status: 'failed',
        code: 'package_root_unavailable',
        actual: errorMessage(error),
      },
      {
        id: 'source_provenance',
        status: 'skipped',
        code: 'blocked_by_package_integrity',
      },
      {
        id: 'publisher_authenticity',
        status: 'unverified',
        code: 'publisher_authenticity_unverified',
      },
    ];
    return {
      report: {
        schema_version: 1,
        kind: 'craftcompass_install_doctor',
        status: 'failed',
        skill_package_root: null,
        source_commit: null,
        source_dirty: null,
        platform: process.platform,
        platform_supported: SUPPORTED_PLATFORMS.has(process.platform),
        node: process.versions.node,
        node_supported: isSupportedNode(process.versions.node),
        package_integrity: false,
        package_integrity_verified: false,
        runtime_main_present: false,
        packaged_source_declared_clean: null,
        publisher_authenticity_unverified: true,
        ready: false,
        checks,
      },
    };
  }

  let verified;
  let integrityIssue;
  try {
    verified = verifyPackage(skillRoot);
  } catch (error) {
    integrityIssue = errorMessage(error);
  }
  const packageIntegrity = verified !== undefined;
  const sourceDirty = verified?.sourceDirty ?? null;
  const packagedSourceDeclaredClean =
    sourceDirty === null ? null : sourceDirty === false;
  const checks = [
    {
      id: 'platform',
      status: platformSupported ? 'passed' : 'failed',
      code: platformSupported ? 'supported_platform' : 'unsupported_platform',
      actual: process.platform,
    },
    {
      id: 'node',
      status: nodeSupported ? 'passed' : 'failed',
      code: nodeSupported ? 'supported_node' : 'unsupported_node',
      expected: '^22.23.1 || ^24.18.0',
      actual: process.versions.node,
    },
    {
      id: 'node_environment',
      status: unsafeEnvironment.length === 0 ? 'passed' : 'failed',
      code:
        unsafeEnvironment.length === 0
          ? 'safe_node_environment'
          : 'unsafe_node_environment',
      actual: unsafeEnvironment.length === 0 ? [] : unsafeEnvironment.sort(),
    },
    {
      id: 'package_integrity',
      status: packageIntegrity ? 'passed' : 'failed',
      code: packageIntegrity
        ? 'package_integrity_verified'
        : 'package_integrity_failed',
      ...(integrityIssue === undefined ? {} : { actual: integrityIssue }),
    },
    {
      id: 'source_provenance',
      status:
        sourceDirty === null ? 'skipped' : sourceDirty ? 'failed' : 'passed',
      code:
        sourceDirty === null
          ? 'blocked_by_package_integrity'
          : sourceDirty
            ? 'packaged_source_declared_dirty'
            : 'packaged_source_declared_clean',
    },
    {
      id: 'publisher_authenticity',
      status: 'unverified',
      code: 'publisher_authenticity_unverified',
    },
  ];
  const ready =
    platformSupported &&
    nodeSupported &&
    unsafeEnvironment.length === 0 &&
    packageIntegrity &&
    sourceDirty === false;
  const report = {
    schema_version: 1,
    kind: 'craftcompass_install_doctor',
    status: ready ? 'ready' : 'failed',
    skill_package_root: skillRoot,
    source_commit: verified?.sourceCommit ?? null,
    source_dirty: sourceDirty,
    platform: process.platform,
    platform_supported: platformSupported,
    node: process.versions.node,
    node_supported: nodeSupported,
    package_integrity: packageIntegrity,
    package_integrity_verified: packageIntegrity,
    runtime_main_present: packageIntegrity,
    packaged_source_declared_clean: packagedSourceDeclaredClean,
    publisher_authenticity_unverified: true,
    ready,
    checks,
  };
  return {
    report,
    ...(verified === undefined ? {} : { runtimeMain: verified.runtimeMain }),
  };
};

const runChecked = (command, args, options) => {
  const result = spawnSync(command, args, {
    ...options,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    fail(
      `could not execute ${JSON.stringify(command)}: ${result.error.message}`,
    );
  }
  if (result.signal !== null) {
    fail(`${JSON.stringify(command)} terminated from signal ${result.signal}`);
  }
  return result.status ?? 1;
};

const sanitizedRuntimeEnvironment = () => {
  const environment = { ...process.env };
  for (const name of STRIPPED_RUNTIME_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
};

const [action, ...actionArguments] = process.argv.slice(2);

if (action === 'home' && actionArguments.length === 0) {
  try {
    process.stdout.write(`${resolveSkillRoot()}\n`);
    process.exit(0);
  } catch (error) {
    fail(`could not resolve skill package: ${errorMessage(error)}`);
  }
}

if (action === 'doctor' && actionArguments.length === 0) {
  const { report } = inspectEnvironment();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ready ? 0 : 1);
}

if (action === 'run' && actionArguments.length > 0) {
  const environment = inspectEnvironment();
  if (!environment.report.ready || environment.runtimeMain === undefined) {
    process.stderr.write(`${JSON.stringify(environment.report, null, 2)}\n`);
    fail('installed package is not ready; run doctor and resolve every issue');
  }
  process.exit(
    runChecked(
      process.execPath,
      [environment.runtimeMain, ...actionArguments],
      {
        cwd: process.cwd(),
        env: sanitizedRuntimeEnvironment(),
      },
    ),
  );
}

process.stderr.write(`${usage}\n`);
process.exit(2);
