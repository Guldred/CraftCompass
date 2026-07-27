#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const EXPECTED_PACKAGE_MANAGER = 'pnpm@10.33.0';
const EXPECTED_ESBUILD = '0.28.1';
const INSTALL_MANIFEST = 'install-manifest.json';
const MAX_PACKAGE_FILES = 20_000;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_DEPTH = 64;
const MAX_SOURCE_FILE_BYTES = 128 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith('node:') ? [name] : [name, `node:${name}`],
  ),
);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const usage = [
  'Usage:',
  '  install-global.mjs package <absolute-output-parent>',
  '  install-global.mjs install <absolute-codex-home>',
].join('\n');

const fail = (message) => {
  throw new Error(message);
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const skillSourceRoot = realpathSync(
  path.resolve(path.dirname(scriptPath), '..'),
);
const repositoryRoot = realpathSync(path.resolve(skillSourceRoot, '..', '..'));
const childEnvironment = {
  ...process.env,
  PATH: [path.dirname(process.execPath), process.env.PATH]
    .filter((entry) => entry !== undefined && entry.length > 0)
    .join(path.delimiter),
};
delete childEnvironment.NODE_COMPILE_CACHE;
delete childEnvironment.NODE_V8_COVERAGE;
const runtimeEnvironment = { ...childEnvironment };

const isContained = (parent, candidate) =>
  candidate === parent || candidate.startsWith(`${parent}${path.sep}`);

const assertAbsoluteDirectory = (candidate, label) => {
  if (!path.isAbsolute(candidate)) {
    fail(`${label} must be an absolute path`);
  }
  const lexical = path.resolve(candidate);
  const state = lstatSync(lexical, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink()) {
    fail(`${label} must be a regular directory`);
  }
  if (
    typeof process.getuid === 'function' &&
    state.uid !== BigInt(process.getuid())
  ) {
    fail(`${label} must be owned by the current user`);
  }
  if ((state.mode & 0o022n) !== 0n) {
    fail(`${label} must not be group- or world-writable`);
  }
  const canonical = realpathSync(lexical);
  if (canonical !== lexical) {
    fail(`${label} must not contain symlinked path components`);
  }
  return canonical;
};

const ensurePrivateChildDirectory = (parent, name, label) => {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    fail(`invalid ${label} directory name`);
  }
  const canonicalParent = assertAbsoluteDirectory(parent, `${label} parent`);
  const candidate = path.join(canonicalParent, name);
  try {
    mkdirSync(candidate, { mode: 0o700 });
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST'
    )) {
      throw error;
    }
  }
  return assertAbsoluteDirectory(candidate, label);
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

const readStableSourceFile = (filePath) => {
  const linkState = lstatSync(filePath, { bigint: true });
  if (!linkState.isFile() || linkState.isSymbolicLink()) {
    fail(`source snapshot input is not a regular file: ${filePath}`);
  }
  if (linkState.size > BigInt(MAX_SOURCE_FILE_BYTES)) {
    fail(`source snapshot input exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameFileState(linkState, before)) {
      fail(`source snapshot input changed before read: ${filePath}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      !sameFileState(before, after)
    ) {
      fail(`source snapshot input changed during read: ${filePath}`);
    }
    return {
      bytes,
      executable: (before.mode & 0o111n) !== 0n,
    };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

const runCaptured = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: childEnvironment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    fail(`could not execute ${command}: ${result.error.message}`);
  }
  if (result.signal !== null) {
    fail(`${command} terminated from signal ${result.signal}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} exited ${result.status}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout.trim();
};

const runCapturedBytes = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnvironment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    fail(`could not execute ${command}: ${result.error.message}`);
  }
  if (result.signal !== null) {
    fail(`${command} terminated from signal ${result.signal}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} exited ${result.status}: ${result.stderr.toString('utf8').trim()}`,
    );
  }
  return result.stdout;
};

const runInherited = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnvironment,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    fail(`could not execute ${command}: ${result.error.message}`);
  }
  if (result.signal !== null) {
    fail(`${command} terminated from signal ${result.signal}`);
  }
  if (result.status !== 0) {
    fail(`${command} exited ${result.status}`);
  }
};

const sourceState = () => {
  const commit = runCaptured(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    repositoryRoot,
  );
  if (!COMMIT_PATTERN.test(commit)) {
    fail(`Git returned an invalid source commit: ${commit}`);
  }
  const status = runCaptured(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    repositoryRoot,
  );
  return {
    commit,
    dirty: status.length > 0,
    status,
  };
};

const assertToolchain = () => {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    fail('global installation currently requires Linux or macOS');
  }
  if (!isSupportedNode(process.versions.node)) {
    fail(
      `Node ${process.versions.node} is unsupported; use 22.23.1+ or 24.18.0+ on its supported LTS line`,
    );
  }
  const injectedNodeEnvironment = [
    'DYLD_INSERT_LIBRARIES',
    'ESBUILD_BINARY_PATH',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'NODE_PATH',
  ].filter((name) => (process.env[name] ?? '').length > 0);
  if (injectedNodeEnvironment.length > 0) {
    fail(
      `refusing an injected Node environment: ${injectedNodeEnvironment.join(', ')}`,
    );
  }
  const packageManager = runCaptured('pnpm', ['--version'], repositoryRoot);
  if (`pnpm@${packageManager}` !== EXPECTED_PACKAGE_MANAGER) {
    fail(
      `pnpm ${packageManager} is unsupported; expected ${EXPECTED_PACKAGE_MANAGER}`,
    );
  }
  const rootPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  if (
    rootPackage?.name !== 'craftcompass' ||
    rootPackage.packageManager !== EXPECTED_PACKAGE_MANAGER ||
    rootPackage.scripts?.build !== 'tsc -b' ||
    rootPackage.devDependencies?.esbuild !== EXPECTED_ESBUILD
  ) {
    fail('CraftCompass source checkout identity or build contract mismatch');
  }
};

const visitTree = (root, visitor, depth = 0, relativeDirectory = '') => {
  if (depth > MAX_PACKAGE_DEPTH) {
    fail(`tree exceeds depth ${MAX_PACKAGE_DEPTH}`);
  }
  const before = lstatSync(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    fail(`expected a regular directory during traversal: ${root}`);
  }
  if (realpathSync(root) !== path.resolve(root)) {
    fail(`directory traversal encountered an aliased path: ${root}`);
  }
  const entries = readdirSync(root, { withFileTypes: true }).sort(
    (left, right) => compareText(left.name, right.name),
  );
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    const relativePath =
      relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
    const state = lstatSync(absolutePath, { bigint: true });
    visitor(absolutePath, relativePath, state);
    if (state.isDirectory()) {
      visitTree(absolutePath, visitor, depth + 1, relativePath);
    }
  }
  const after = lstatSync(root, { bigint: true });
  if (!sameFileState(before, after)) {
    fail(`directory identity changed during traversal: ${root}`);
  }
};

const validateRelativeSourcePath = (relativePath) => {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    relativePath
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`Git returned an unsafe source path: ${JSON.stringify(relativePath)}`);
  }
};

const copyWorkingTreeSnapshot = (snapshotRoot, expectedState) => {
  const listed = runCapturedBytes(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    repositoryRoot,
  );
  if (listed.byteLength > 8 * 1024 * 1024) {
    fail('Git source path list exceeds 8388608 bytes');
  }
  const paths = [];
  let offset = 0;
  for (let index = 0; index < listed.byteLength; index += 1) {
    if (listed[index] !== 0) {
      continue;
    }
    const pathBytes = listed.subarray(offset, index);
    let relativePath;
    try {
      relativePath = utf8Decoder.decode(pathBytes);
    } catch (error) {
      throw new Error('Git source path is not valid UTF-8', { cause: error });
    }
    validateRelativeSourcePath(relativePath);
    paths.push(relativePath);
    offset = index + 1;
  }
  if (offset !== listed.byteLength || paths.length > MAX_PACKAGE_FILES) {
    fail('Git source path list is incomplete or exceeds the file limit');
  }
  paths.sort(compareText);

  let totalBytes = 0;
  for (const relativePath of paths) {
    const source = path.join(repositoryRoot, relativePath);
    const target = path.join(snapshotRoot, relativePath);
    const { bytes, executable } = readStableSourceFile(source);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PACKAGE_BYTES) {
      fail(`source snapshot exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, {
      flag: 'wx',
      mode: executable ? 0o755 : 0o644,
    });
  }

  const afterCopy = sourceState();
  if (
    afterCopy.commit !== expectedState.commit ||
    afterCopy.status !== expectedState.status ||
    afterCopy.dirty !== expectedState.dirty
  ) {
    fail('source worktree changed while creating the development snapshot');
  }
};

const extractCommitSnapshot = (snapshotRoot, buildWork, commit) => {
  const archivePath = path.join(buildWork, 'source.tar');
  runInherited(
    'git',
    ['archive', '--format=tar', `--output=${archivePath}`, commit],
    repositoryRoot,
  );
  const archiveState = lstatSync(archivePath, { bigint: true });
  if (
    !archiveState.isFile() ||
    archiveState.isSymbolicLink() ||
    archiveState.size > BigInt(MAX_PACKAGE_BYTES)
  ) {
    fail('Git produced an invalid or oversized source archive');
  }
  runInherited(
    '/usr/bin/tar',
    ['-xf', archivePath, '-C', snapshotRoot],
    buildWork,
  );
};

const assertSnapshotTree = (snapshotRoot) => {
  let files = 0;
  let totalBytes = 0;
  visitTree(snapshotRoot, (_absolutePath, relativePath, state) => {
    if (state.isSymbolicLink()) {
      fail(`source snapshot contains a forbidden symlink: ${relativePath}`);
    }
    if (state.isDirectory()) {
      return;
    }
    if (!state.isFile()) {
      fail(`source snapshot contains a special entry: ${relativePath}`);
    }
    files += 1;
    totalBytes += Number(state.size);
    if (files > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
      fail('source snapshot exceeds its file or byte limit');
    }
  });
};

const assertSnapshotIdentity = (snapshotRoot) => {
  const rootPackage = JSON.parse(
    readFileSync(path.join(snapshotRoot, 'package.json'), 'utf8'),
  );
  if (
    rootPackage?.name !== 'craftcompass' ||
    rootPackage.packageManager !== EXPECTED_PACKAGE_MANAGER ||
    rootPackage.scripts?.build !== 'tsc -b' ||
    rootPackage.scripts?.check !==
      'pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build' ||
    rootPackage.devDependencies?.esbuild !== EXPECTED_ESBUILD
  ) {
    fail('CraftCompass source snapshot identity or gate contract mismatch');
  }
};

const resolvePnpmStoreRoot = (snapshotRoot) => {
  const modulesMetadataPath = path.join(
    repositoryRoot,
    'node_modules',
    '.modules.yaml',
  );
  let modulesMetadata;
  try {
    modulesMetadata = JSON.parse(
      utf8Decoder.decode(readStableSourceFile(modulesMetadataPath).bytes),
    );
  } catch (error) {
    throw new Error(
      `could not parse installed pnpm metadata: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const versionedStore = modulesMetadata?.storeDir;
  const virtualStoreSetting = modulesMetadata?.virtualStoreDir;
  if (
    typeof versionedStore !== 'string' ||
    !path.isAbsolute(versionedStore) ||
    path.basename(versionedStore) !== 'v10'
  ) {
    fail('installed pnpm metadata has an unexpected store path');
  }
  if (
    typeof virtualStoreSetting !== 'string' ||
    virtualStoreSetting.length === 0
  ) {
    fail('installed pnpm metadata has an unexpected virtual store path');
  }
  const virtualStore = assertAbsoluteDirectory(
    path.isAbsolute(virtualStoreSetting)
      ? virtualStoreSetting
      : path.resolve(path.dirname(modulesMetadataPath), virtualStoreSetting),
    'pnpm virtual store',
  );
  const installedLock = readStableSourceFile(
    path.join(virtualStore, 'lock.yaml'),
  ).bytes;
  const snapshotLock = readStableSourceFile(
    path.join(snapshotRoot, 'pnpm-lock.yaml'),
  ).bytes;
  if (!installedLock.equals(snapshotLock)) {
    fail(
      'installed pnpm dependency metadata does not match the source snapshot lockfile',
    );
  }
  assertAbsoluteDirectory(versionedStore, 'pnpm versioned content store');
  return assertAbsoluteDirectory(
    path.dirname(versionedStore),
    'pnpm content store',
  );
};

const prepareBuildSnapshot = (buildWork, state) => {
  const snapshotRoot = path.join(buildWork, 'source');
  mkdirSync(snapshotRoot, { mode: 0o700 });
  if (state.dirty) {
    copyWorkingTreeSnapshot(snapshotRoot, state);
  } else {
    extractCommitSnapshot(snapshotRoot, buildWork, state.commit);
  }
  assertSnapshotTree(snapshotRoot);
  assertSnapshotIdentity(snapshotRoot);

  const storeRoot = resolvePnpmStoreRoot(snapshotRoot);
  runInherited(
    'pnpm',
    [
      'install',
      '--frozen-lockfile',
      '--offline',
      '--ignore-scripts',
      '--package-import-method=copy',
      '--store-dir',
      storeRoot,
    ],
    snapshotRoot,
  );
  runInherited('pnpm', ['check'], snapshotRoot);
  return snapshotRoot;
};

const copyOperationalSkill = (packageStage, sourceSkillRoot) => {
  const copies = [
    ['SKILL.md', 'SKILL.md'],
    ['agents', 'agents'],
    ['references', 'references'],
    ['scripts/craftcompass.mjs', 'scripts/craftcompass.mjs'],
  ];
  for (const [sourceRelative, targetRelative] of copies) {
    const source = path.join(sourceSkillRoot, sourceRelative);
    const state = lstatSync(source);
    if (state.isSymbolicLink()) {
      fail(`skill source contains a forbidden symlink: ${sourceRelative}`);
    }
    const target = path.join(packageStage, targetRelative);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, {
      recursive: state.isDirectory(),
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
  }
};

const collectPackageFiles = (packageRoot) => {
  const files = [];
  let totalBytes = 0;
  const expectedOwner =
    typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
  visitTree(packageRoot, (absolutePath, relativePath, state) => {
    if (state.isSymbolicLink()) {
      fail(`packaged skill contains a forbidden symlink: ${relativePath}`);
    }
    if (state.isDirectory()) {
      return;
    }
    if (!state.isFile()) {
      fail(`packaged skill contains a special entry: ${relativePath}`);
    }
    if (state.nlink !== 1n) {
      fail(`packaged skill contains a hard-linked file: ${relativePath}`);
    }
    if (expectedOwner !== null && state.uid !== expectedOwner) {
      fail(
        `packaged skill contains a file owned by another user: ${relativePath}`,
      );
    }
    const mode = state.mode & 0o777n;
    if (mode !== 0o444n && mode !== 0o555n) {
      fail(`packaged skill has an unsafe file mode: ${relativePath}`);
    }
    const bytes = readFileSync(absolutePath);
    totalBytes += bytes.byteLength;
    if (files.length >= MAX_PACKAGE_FILES) {
      fail(`packaged skill exceeds ${MAX_PACKAGE_FILES} files`);
    }
    if (totalBytes > MAX_PACKAGE_BYTES) {
      fail(`packaged skill exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    files.push({
      path: relativePath,
      bytes: bytes.byteLength,
      mode: mode === 0o555n ? '0555' : '0444',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  return files.sort((left, right) => compareText(left.path, right.path));
};

const verifyBundleMetadata = (metadataPath, bundlePath, buildRoot) => {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `could not parse esbuild metadata: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  if (
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata !== 'object' ||
    metadata.outputs === null ||
    Array.isArray(metadata.outputs) ||
    typeof metadata.outputs !== 'object'
  ) {
    fail('esbuild metadata has an invalid contract');
  }
  const outputs = Object.entries(metadata.outputs);
  if (outputs.length !== 1) {
    fail(`esbuild produced ${outputs.length} outputs instead of one`);
  }
  const [outputPath, output] = outputs[0];
  if (
    path.resolve(buildRoot, outputPath) !== path.resolve(bundlePath) ||
    output === null ||
    Array.isArray(output) ||
    typeof output !== 'object' ||
    !Array.isArray(output.imports)
  ) {
    fail('esbuild metadata does not identify the expected runtime bundle');
  }
  for (const imported of output.imports) {
    if (
      imported === null ||
      Array.isArray(imported) ||
      typeof imported !== 'object' ||
      imported.external !== true ||
      typeof imported.path !== 'string' ||
      !NODE_BUILTINS.has(imported.path)
    ) {
      fail('runtime bundle retains a non-builtin external dependency');
    }
  }
  const bundleState = lstatSync(bundlePath, { bigint: true });
  if (
    !bundleState.isFile() ||
    bundleState.isSymbolicLink() ||
    bundleState.size > BigInt(MAX_PACKAGE_BYTES)
  ) {
    fail('runtime bundle is not a bounded regular file');
  }
  const bundleText = readFileSync(bundlePath, 'utf8');
  const staticRequires = bundleText.matchAll(
    /__require\((["'])([^"'\\]+)\1\)/gu,
  );
  for (const match of staticRequires) {
    if (!NODE_BUILTINS.has(match[2])) {
      fail(`runtime bundle retains an external require for ${match[2]}`);
    }
  }
  if (/__require\((?!["'])/u.test(bundleText)) {
    fail('runtime bundle retains a dynamic external require');
  }
};

const normalizePackageFileModes = (packageRoot) => {
  visitTree(packageRoot, (absolutePath, relativePath, state) => {
    if (state.isSymbolicLink()) {
      fail(`packaged skill contains a forbidden symlink: ${relativePath}`);
    }
    if (state.isDirectory()) {
      return;
    }
    if (!state.isFile()) {
      fail(`packaged skill contains a special entry: ${relativePath}`);
    }
    const mode = relativePath === 'scripts/craftcompass.mjs' ? 0o555 : 0o444;
    chmodSync(absolutePath, mode);
  });
};

const sealPackageDirectories = (packageRoot) => {
  const directories = [packageRoot];
  visitTree(packageRoot, (absolutePath, _relativePath, state) => {
    if (state.isDirectory()) {
      directories.push(absolutePath);
    }
  });
  for (const directory of directories.reverse()) {
    chmodSync(directory, 0o555);
  }
};

const makeSealedPackageRemovable = (packageRoot) => {
  const directories = [packageRoot];
  visitTree(packageRoot, (absolutePath, _relativePath, state) => {
    if (state.isDirectory()) {
      directories.push(absolutePath);
    }
  });
  for (const directory of directories) {
    chmodSync(directory, 0o700);
  }
};

const removeTemporary = (candidate, parent, prefix, sealed = false) => {
  const resolvedParent = realpathSync(parent);
  const resolvedCandidate = path.resolve(candidate);
  if (
    path.dirname(resolvedCandidate) !== resolvedParent ||
    !path.basename(resolvedCandidate).startsWith(prefix)
  ) {
    fail(`refusing to remove unexpected temporary path: ${candidate}`);
  }
  if (sealed) {
    makeSealedPackageRemovable(resolvedCandidate);
  }
  rmSync(resolvedCandidate, { recursive: true, force: true, maxRetries: 2 });
};

const packageSkill = (outputParent, state) => {
  const canonicalOutputParent = assertAbsoluteDirectory(
    outputParent,
    'output parent',
  );
  const buildWork = mkdtempSync(
    path.join(canonicalOutputParent, '.craftcompass-build-'),
  );
  const metadataPath = path.join(buildWork, 'esbuild-meta.json');
  const packageStage = mkdtempSync(
    path.join(canonicalOutputParent, '.craftcompass-stage-'),
  );
  const bundlePath = path.join(packageStage, 'runtime', 'craft.mjs');
  let packageStageExists = true;
  let packageStageSealed = false;

  try {
    const buildSource = prepareBuildSnapshot(buildWork, state);
    const snapshotEsbuild = runCaptured(
      'pnpm',
      ['exec', 'esbuild', '--version'],
      buildSource,
    );
    if (snapshotEsbuild !== EXPECTED_ESBUILD) {
      fail(
        `snapshot esbuild ${snapshotEsbuild} is unsupported; expected ${EXPECTED_ESBUILD}`,
      );
    }
    runInherited('pnpm', ['exec', 'tsc', '-b', '--force'], buildSource);
    mkdirSync(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
    runInherited(
      'pnpm',
      [
        'exec',
        'esbuild',
        path.join(buildSource, 'apps', 'cli', 'dist', 'main.js'),
        '--bundle',
        '--platform=node',
        '--packages=bundle',
        '--format=esm',
        '--target=node22.23',
        "--banner:js=import { createRequire as __craftCreateRequire } from 'node:module'; const require = __craftCreateRequire(import.meta.url);",
        `--outfile=${bundlePath}`,
        `--metafile=${metadataPath}`,
        '--log-level=warning',
      ],
      buildSource,
    );
    verifyBundleMetadata(metadataPath, bundlePath, buildSource);
    copyOperationalSkill(
      packageStage,
      path.join(buildSource, 'skills', 'craftcompass'),
    );

    normalizePackageFileModes(packageStage);
    const files = collectPackageFiles(packageStage);
    const manifest = {
      schema_version: 1,
      source_commit: state.commit,
      source_dirty: state.dirty,
      files,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(path.join(packageStage, INSTALL_MANIFEST), manifestText, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o444,
    });
    const manifestDigest = createHash('sha256')
      .update(manifestText)
      .digest('hex');
    const packageName = `${state.commit}-${manifestDigest}`;
    const packageTarget = path.join(canonicalOutputParent, packageName);
    try {
      const existing = lstatSync(packageTarget);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        fail(`existing package target is not a regular directory`);
      }
      removeTemporary(
        packageStage,
        canonicalOutputParent,
        '.craftcompass-stage-',
      );
      packageStageExists = false;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        sealPackageDirectories(packageStage);
        packageStageSealed = true;
        renameSync(packageStage, packageTarget);
        packageStageExists = false;
      } else {
        throw error;
      }
    }
    return packageTarget;
  } finally {
    removeTemporary(buildWork, canonicalOutputParent, '.craftcompass-build-');
    if (packageStageExists) {
      removeTemporary(
        packageStage,
        canonicalOutputParent,
        '.craftcompass-stage-',
        packageStageSealed,
      );
    }
  }
};

const inspectPackagedSkill = (packageRoot, expectedDirty) => {
  const launcher = path.join(packageRoot, 'scripts', 'craftcompass.mjs');
  const doctor = spawnSync(process.execPath, [launcher, 'doctor'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: runtimeEnvironment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (doctor.error !== undefined || doctor.signal !== null) {
    fail(`packaged skill doctor could not execute`);
  }
  let report;
  try {
    report = JSON.parse(doctor.stdout);
  } catch (error) {
    fail(`packaged skill doctor returned invalid JSON: ${errorMessage(error)}`);
  }
  if (
    report?.package_integrity !== true ||
    report.source_dirty !== expectedDirty ||
    report.ready !== !expectedDirty ||
    doctor.status !== (expectedDirty ? 1 : 0)
  ) {
    fail(`packaged skill doctor did not enforce its integrity contract`);
  }

  const fixture = path.join(
    repositoryRoot,
    'fixtures',
    'repositories',
    'unknown-project',
  );
  const bundleSmoke = spawnSync(
    process.execPath,
    [
      path.join(packageRoot, 'runtime', 'craft.mjs'),
      'project',
      'scan',
      fixture,
    ],
    {
      cwd: fixture,
      encoding: 'utf8',
      env: runtimeEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (
    bundleSmoke.error !== undefined ||
    bundleSmoke.signal !== null ||
    bundleSmoke.status !== 0 ||
    !bundleSmoke.stdout.includes('UNCERTAINTY-PROJECT-TECHNOLOGY')
  ) {
    fail(`packaged skill runtime smoke failed`);
  }
  if (expectedDirty) {
    return report;
  }

  const smoke = spawnSync(
    process.execPath,
    [launcher, 'run', 'project', 'scan', fixture],
    {
      cwd: fixture,
      encoding: 'utf8',
      env: runtimeEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (
    smoke.error !== undefined ||
    smoke.signal !== null ||
    smoke.status !== 0 ||
    !smoke.stdout.includes('UNCERTAINTY-PROJECT-TECHNOLOGY')
  ) {
    fail(`packaged skill CLI smoke failed`);
  }
  return report;
};

const installGlobal = (codexHome, state) => {
  if (state.dirty) {
    fail(
      `global installation requires a clean reviewed commit; source changes are:\n${state.status}`,
    );
  }
  const canonicalCodexHome = assertAbsoluteDirectory(codexHome, 'Codex home');
  const versionRoot = ensurePrivateChildDirectory(
    canonicalCodexHome,
    'skill-versions',
    'Codex skill version directory',
  );
  const versionParent = ensurePrivateChildDirectory(
    versionRoot,
    'craftcompass',
    'CraftCompass version directory',
  );
  const packageRoot = packageSkill(versionParent, state);
  const report = inspectPackagedSkill(packageRoot, false);

  const beforeActivation = sourceState();
  if (
    beforeActivation.commit !== state.commit ||
    beforeActivation.status !== state.status ||
    beforeActivation.dirty !== state.dirty
  ) {
    fail('source worktree changed before global skill activation');
  }

  const skillsRoot = ensurePrivateChildDirectory(
    canonicalCodexHome,
    'skills',
    'Codex skills directory',
  );
  const activeSkill = path.join(skillsRoot, 'craftcompass');
  let activeState;
  try {
    activeState = lstatSync(activeSkill);
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      throw error;
    }
  }
  if (activeState !== undefined) {
    if (!activeState.isSymbolicLink()) {
      fail('existing global craftcompass entry is not a managed symlink');
    }
    const canonicalVersionParent = realpathSync(versionParent);
    const rawTarget = readlinkSync(activeSkill);
    const lexicalTarget = path.resolve(skillsRoot, rawTarget);
    if (!isContained(canonicalVersionParent, lexicalTarget)) {
      fail('existing global craftcompass symlink is not installer-managed');
    }
    try {
      const existingTarget = realpathSync(activeSkill);
      if (!isContained(canonicalVersionParent, existingTarget)) {
        fail('existing global craftcompass symlink escapes its version store');
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        throw error;
      }
    }
  }

  const linkNonce = randomBytes(8).toString('hex');
  const temporaryLink = path.join(
    skillsRoot,
    `.craftcompass-link-${process.pid}-${linkNonce}`,
  );
  const relativeTarget = path.relative(skillsRoot, packageRoot);
  symlinkSync(relativeTarget, temporaryLink, 'dir');
  let temporaryLinkExists = true;
  try {
    if (realpathSync(temporaryLink) !== realpathSync(packageRoot)) {
      fail('temporary global skill link resolved to an unexpected target');
    }
    renameSync(temporaryLink, activeSkill);
    temporaryLinkExists = false;
  } finally {
    if (temporaryLinkExists) {
      rmSync(temporaryLink, { force: true });
    }
  }
  if (realpathSync(activeSkill) !== realpathSync(packageRoot)) {
    fail('global skill activation did not retain the verified package');
  }
  return {
    status: 'installed',
    source_commit: state.commit,
    skill_path: activeSkill,
    package_path: packageRoot,
    package_integrity: report.package_integrity,
  };
};

const main = () => {
  const [action, target, ...extra] = process.argv.slice(2);
  if (
    extra.length > 0 ||
    target === undefined ||
    (action !== 'package' && action !== 'install')
  ) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  assertToolchain();
  const before = sourceState();
  if (action === 'install' && before.dirty) {
    fail(
      `global installation requires a clean reviewed commit; source changes are:\n${before.status}`,
    );
  }
  const result =
    action === 'package'
      ? (() => {
          const packageRoot = packageSkill(target, before);
          const report = inspectPackagedSkill(packageRoot, before.dirty);
          return {
            status: 'packaged',
            source_commit: before.commit,
            source_dirty: before.dirty,
            package_path: packageRoot,
            package_integrity: report.package_integrity,
          };
        })()
      : installGlobal(target, before);
  const after = sourceState();
  if (
    after.commit !== before.commit ||
    after.status !== before.status ||
    after.dirty !== before.dirty
  ) {
    fail('installation changed the tracked or untracked source worktree');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

try {
  main();
} catch (error) {
  process.stderr.write(`CraftCompass installer: ${errorMessage(error)}\n`);
  process.exit(1);
}
