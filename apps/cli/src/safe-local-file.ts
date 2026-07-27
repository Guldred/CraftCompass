import { createHash, randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  link,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';

export type SafeLocalFileErrorCode =
  | 'invalid_options'
  | 'unsupported_platform'
  | 'path_not_found'
  | 'path_outside_repository'
  | 'symlink_refused'
  | 'not_a_directory'
  | 'not_a_regular_file'
  | 'file_too_large'
  | 'file_changed'
  | 'invalid_utf8'
  | 'read_failed'
  | 'target_exists'
  | 'overwrite_precondition_failed'
  | 'ownership_rejected'
  | 'write_failed'
  | 'cleanup_failed';

/** Expected, fail-closed local-file operation error. */
export class SafeLocalFileError extends Error {
  readonly code: SafeLocalFileErrorCode;
  readonly filePath: string;

  constructor(
    code: SafeLocalFileErrorCode,
    message: string,
    filePath: string,
    options?: ErrorOptions,
  ) {
    super(`${filePath}: ${message}`, options);
    this.name = 'SafeLocalFileError';
    this.code = code;
    this.filePath = filePath;
  }
}

/** Stable metadata used to detect path swaps and in-place writes. */
export interface SafeLocalFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mode: number;
  readonly links: string;
  readonly user: string;
  readonly group: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
}

/** Stable directory identity retained across repository-target authorization. */
interface SafeLocalDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly user: string;
  readonly group: string;
}

interface ExpectedTargetParent {
  readonly canonicalPath: string;
  readonly identity: SafeLocalDirectoryIdentity;
}

interface ResolvedRepositoryTarget {
  readonly filePath: string;
  readonly parent: ExpectedTargetParent;
}

/** One bounded, integrity-checked local-file snapshot. */
export interface SafeLocalFileSnapshot<T extends string | Uint8Array> {
  readonly filePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly identity: SafeLocalFileIdentity;
  readonly content: T;
}

export interface BoundedByteReadOptions {
  /** Maximum number of bytes accepted, with no silent truncation. */
  readonly maxBytes: number;
  readonly encoding?: 'bytes';
}

export interface BoundedTextReadOptions {
  /** Maximum number of bytes accepted, with no silent truncation. */
  readonly maxBytes: number;
  /** UTF-8 decoding is fatal; malformed byte sequences are rejected. */
  readonly encoding: 'utf8';
}

export interface RepositoryTargetResolutionOptions {
  /** Permit only the final path component to be absent. */
  readonly allowMissing?: boolean;
}

/** Authorization required before replacing an existing generated file. */
export interface ExpectedGeneratedFile {
  /** Exact lowercase SHA-256 of the file the caller expects to replace. */
  readonly sha256: string;
  /**
   * Confirms application-level ownership, for example by checking a generated
   * marker. A matching hash alone never authorizes replacement.
   */
  readonly isOwned: (
    snapshot: SafeLocalFileSnapshot<string>,
  ) => boolean | Promise<boolean>;
}

export interface AtomicTextWriteOptions {
  /** Applies both to the new text and to any existing file being verified. */
  readonly maxBytes: number;
  /** Required when the target already exists. */
  readonly expectedExisting?: ExpectedGeneratedFile;
  /** Creation permissions for a new file; existing permissions are preserved. */
  readonly mode?: number;
}

export interface AtomicTextWriteResult {
  readonly filePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly replacedExisting: boolean;
}

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TEMP_ATTEMPTS = 8;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === code;

const fail = (
  code: SafeLocalFileErrorCode,
  message: string,
  filePath: string,
  options?: ErrorOptions,
): never => {
  throw new SafeLocalFileError(code, message, filePath, options);
};

const validateMaximum = (maxBytes: number, filePath: string): void => {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes >= Number.MAX_SAFE_INTEGER
  ) {
    fail(
      'invalid_options',
      'maxBytes must be a non-negative safe integer below Number.MAX_SAFE_INTEGER.',
      filePath,
    );
  }
};

const assertSupportedPlatform = (filePath: string): void => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    fail(
      'unsupported_platform',
      'Hardened local-file operations currently require Linux or macOS.',
      filePath,
    );
  }
};

const validateMode = (mode: number | undefined, filePath: string): void => {
  if (
    mode !== undefined &&
    (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
  ) {
    fail(
      'invalid_options',
      'mode must be an integer between 0 and 0o777.',
      filePath,
    );
  }
};

const hasControlCharacter = (value: string): boolean => {
  for (let offset = 0; offset < value.length; offset += 1) {
    const codeUnit = value.charCodeAt(offset);
    if (codeUnit < 0x20 || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let offset = 0; offset < value.length; offset += 1) {
    const codeUnit = value.charCodeAt(offset);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(offset + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      offset += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const toIdentity = (entry: BigIntStats): SafeLocalFileIdentity => ({
  device: entry.dev.toString(),
  inode: entry.ino.toString(),
  size: Number(entry.size),
  mode: Number(entry.mode & 0o777n),
  links: entry.nlink.toString(),
  user: entry.uid.toString(),
  group: entry.gid.toString(),
  modifiedNanoseconds: entry.mtimeNs.toString(),
  changedNanoseconds: entry.ctimeNs.toString(),
});

const toDirectoryIdentity = (
  entry: BigIntStats,
): SafeLocalDirectoryIdentity => ({
  device: entry.dev.toString(),
  inode: entry.ino.toString(),
  mode: Number(entry.mode & 0o777n),
  user: entry.uid.toString(),
  group: entry.gid.toString(),
});

const sameDirectoryIdentity = (
  left: SafeLocalDirectoryIdentity,
  right: SafeLocalDirectoryIdentity,
): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.user === right.user &&
  left.group === right.group;

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

const sha256 = (content: Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const inspectPath = async (
  filePath: string,
): Promise<BigIntStats | undefined> => {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
};

const closeHandle = async (
  handle: FileHandle | undefined,
  filePath: string,
): Promise<void> => {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch (error) {
    fail('read_failed', 'Could not close the local file.', filePath, {
      cause: error,
    });
  }
};

const readOpenRegularFile = async (
  handle: FileHandle,
  initialPathState: BigIntStats,
  filePath: string,
  maxBytes: number,
): Promise<{
  readonly bytes: Uint8Array;
  readonly identity: SafeLocalFileIdentity;
}> => {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) {
    fail(
      'not_a_regular_file',
      'Refusing to read a directory, device, socket, or pipe.',
      filePath,
    );
  }
  if (!sameFileState(initialPathState, before)) {
    fail(
      'file_changed',
      'The file identity changed between inspection and open.',
      filePath,
    );
  }
  if (before.size > BigInt(maxBytes)) {
    fail(
      'file_too_large',
      `File exceeds the configured ${maxBytes}-byte limit.`,
      filePath,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let bytesRead = 1;
  while (bytesRead > 0) {
    const remainingWithSentinel = maxBytes - totalBytes + 1;
    const requestedBytes = Math.min(READ_CHUNK_BYTES, remainingWithSentinel);
    const chunk = Buffer.allocUnsafe(requestedBytes);
    const readResult = await handle.read(chunk, 0, requestedBytes, totalBytes);
    bytesRead = readResult.bytesRead;
    if (bytesRead === 0) {
      continue;
    }
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      fail(
        'file_too_large',
        `File grew beyond the configured ${maxBytes}-byte limit while being read.`,
        filePath,
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }

  const after = await handle.stat({ bigint: true });
  let finalPathState: BigIntStats | undefined;
  try {
    finalPathState = await inspectPath(filePath);
  } catch (error) {
    fail('read_failed', 'Could not re-inspect the local file.', filePath, {
      cause: error,
    });
  }
  if (
    finalPathState === undefined ||
    !after.isFile() ||
    !sameFileState(before, after) ||
    !sameFileState(after, finalPathState) ||
    after.size !== BigInt(totalBytes)
  ) {
    fail(
      'file_changed',
      'The file changed or was replaced while being read.',
      filePath,
    );
  }

  return {
    bytes: Buffer.concat(chunks, totalBytes),
    identity: toIdentity(after),
  };
};

export function readBoundedLocalFile(
  filePath: string,
  options: BoundedTextReadOptions,
): Promise<SafeLocalFileSnapshot<string>>;
export function readBoundedLocalFile(
  filePath: string,
  options: BoundedByteReadOptions,
): Promise<SafeLocalFileSnapshot<Uint8Array>>;
export async function readBoundedLocalFile(
  filePath: string,
  options: BoundedByteReadOptions | BoundedTextReadOptions,
): Promise<SafeLocalFileSnapshot<string | Uint8Array>> {
  const resolvedPath = path.resolve(filePath);
  assertSupportedPlatform(resolvedPath);
  validateMaximum(options.maxBytes, resolvedPath);

  let initialPathState: BigIntStats | undefined;
  try {
    initialPathState = await inspectPath(resolvedPath);
  } catch (error) {
    return fail(
      'read_failed',
      'Could not inspect the local file.',
      resolvedPath,
      {
        cause: error,
      },
    );
  }
  if (initialPathState === undefined) {
    return fail('path_not_found', 'File does not exist.', resolvedPath);
  }
  if (initialPathState.isSymbolicLink()) {
    return fail(
      'symlink_refused',
      'Refusing to follow a symbolic link.',
      resolvedPath,
    );
  }
  if (!initialPathState.isFile()) {
    return fail(
      'not_a_regular_file',
      'Refusing to read a directory, device, socket, or pipe.',
      resolvedPath,
    );
  }
  if (initialPathState.size > BigInt(options.maxBytes)) {
    return fail(
      'file_too_large',
      `File exceeds the configured ${options.maxBytes}-byte limit.`,
      resolvedPath,
    );
  }

  let handle: FileHandle | undefined;
  let readResult:
    | {
        readonly bytes: Uint8Array;
        readonly identity: SafeLocalFileIdentity;
      }
    | undefined;
  let primaryError: unknown;
  try {
    handle = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    readResult = await readOpenRegularFile(
      handle,
      initialPathState,
      resolvedPath,
      options.maxBytes,
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await closeHandle(handle, resolvedPath);
  } catch (error) {
    primaryError =
      primaryError === undefined
        ? error
        : new AggregateError(
            [primaryError, error],
            'Read and close both failed.',
          );
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof SafeLocalFileError) {
      throw primaryError;
    }
    if (isErrno(primaryError, 'ELOOP')) {
      return fail(
        'symlink_refused',
        'Refusing to follow a symbolic link.',
        resolvedPath,
        { cause: primaryError },
      );
    }
    return fail('read_failed', 'Could not read the local file.', resolvedPath, {
      cause: primaryError,
    });
  }
  if (readResult === undefined) {
    return fail(
      'read_failed',
      'Local-file read completed without a result.',
      resolvedPath,
    );
  }

  const digest = sha256(readResult.bytes);
  if (options.encoding === 'utf8') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: false,
      }).decode(readResult.bytes);
    } catch (error) {
      return fail(
        'invalid_utf8',
        'File is not valid UTF-8 text.',
        resolvedPath,
        { cause: error },
      );
    }
    return {
      filePath: resolvedPath,
      byteLength: readResult.bytes.byteLength,
      sha256: digest,
      identity: readResult.identity,
      content: text,
    };
  }
  return {
    filePath: resolvedPath,
    byteLength: readResult.bytes.byteLength,
    sha256: digest,
    identity: readResult.identity,
    content: new Uint8Array(readResult.bytes),
  };
}

const normalizeRepositoryTarget = (
  target: string,
  repositoryRoot: string,
): readonly string[] => {
  if (
    target.length === 0 ||
    path.isAbsolute(target) ||
    /^[A-Za-z]:/u.test(target) ||
    target.includes('\\') ||
    hasControlCharacter(target)
  ) {
    return fail(
      'path_outside_repository',
      'Target must be a non-empty, slash-separated relative path.',
      repositoryRoot,
    );
  }
  const segments = target.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return fail(
      'path_outside_repository',
      'Target must not contain empty, current-directory, or parent-directory segments.',
      repositoryRoot,
    );
  }
  return segments;
};

/**
 * Resolve a regular-file target beneath an existing repository root.
 *
 * The root itself is canonicalized. Existing target components are inspected
 * without following symlinks; only an explicitly allowed final leaf may be
 * absent.
 */
const resolveSafeRepositoryTargetState = async (
  repositoryRoot: string,
  target: string,
  options: RepositoryTargetResolutionOptions = {},
): Promise<ResolvedRepositoryTarget> => {
  const requestedRoot = path.resolve(repositoryRoot);
  assertSupportedPlatform(requestedRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch (error) {
    return fail(
      'path_not_found',
      'Repository root does not exist or cannot be canonicalized.',
      requestedRoot,
      { cause: error },
    );
  }
  let rootEntry: BigIntStats | undefined;
  try {
    rootEntry = await inspectPath(canonicalRoot);
  } catch (error) {
    return fail(
      'read_failed',
      'Could not inspect the canonical repository root.',
      canonicalRoot,
      { cause: error },
    );
  }
  if (rootEntry === undefined) {
    return fail(
      'path_not_found',
      'Canonical repository root no longer exists.',
      canonicalRoot,
    );
  }
  if (!rootEntry.isDirectory()) {
    return fail(
      'not_a_directory',
      'Repository root is not a directory.',
      canonicalRoot,
    );
  }

  const segments = normalizeRepositoryTarget(target, canonicalRoot);
  let candidate = canonicalRoot;
  let parentPath = canonicalRoot;
  let parentIdentity = toDirectoryIdentity(rootEntry);
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    let entry: BigIntStats | undefined;
    try {
      entry = await inspectPath(candidate);
    } catch (error) {
      return fail(
        'read_failed',
        'Could not inspect a repository target component.',
        candidate,
        { cause: error },
      );
    }
    const finalComponent = index === segments.length - 1;
    if (entry === undefined) {
      if (finalComponent && options.allowMissing === true) {
        break;
      }
      return fail(
        'path_not_found',
        finalComponent
          ? 'Repository target does not exist.'
          : 'Repository target parent does not exist.',
        candidate,
      );
    }
    if (entry.isSymbolicLink()) {
      return fail(
        'symlink_refused',
        'Refusing a symbolic-link repository target component.',
        candidate,
      );
    }
    if (!finalComponent && !entry.isDirectory()) {
      return fail(
        'not_a_directory',
        'Repository target parent is not a directory.',
        candidate,
      );
    }
    if (finalComponent && !entry.isFile()) {
      return fail(
        'not_a_regular_file',
        'Repository target is not a regular file.',
        candidate,
      );
    }
    if (!finalComponent) {
      parentPath = candidate;
      parentIdentity = toDirectoryIdentity(entry);
    }
  }

  const relative = path.relative(canonicalRoot, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return fail(
      'path_outside_repository',
      'Resolved target is not a file beneath the repository root.',
      candidate,
    );
  }
  return {
    filePath: candidate,
    parent: {
      canonicalPath: parentPath,
      identity: parentIdentity,
    },
  };
};

export const resolveSafeRepositoryTarget = async (
  repositoryRoot: string,
  target: string,
  options: RepositoryTargetResolutionOptions = {},
): Promise<string> => {
  const resolved = await resolveSafeRepositoryTargetState(
    repositoryRoot,
    target,
    options,
  );
  return resolved.filePath;
};

const validateExpectedFile = (
  expected: ExpectedGeneratedFile | undefined,
  filePath: string,
): void => {
  if (expected !== undefined && !SHA256_PATTERN.test(expected.sha256)) {
    fail(
      'invalid_options',
      'Expected existing SHA-256 must be exactly 64 lowercase hexadecimal characters.',
      filePath,
    );
  }
};

const inspectExistingGeneratedFile = async (
  filePath: string,
  options: AtomicTextWriteOptions,
): Promise<SafeLocalFileSnapshot<string> | undefined> => {
  let entry: BigIntStats | undefined;
  try {
    entry = await inspectPath(filePath);
  } catch (error) {
    return fail(
      'write_failed',
      'Could not inspect the generated-file target.',
      filePath,
      { cause: error },
    );
  }
  if (entry === undefined) {
    if (options.expectedExisting !== undefined) {
      return fail(
        'overwrite_precondition_failed',
        'Caller expected an existing generated file, but the target is absent.',
        filePath,
      );
    }
    return undefined;
  }
  if (entry.isSymbolicLink()) {
    return fail(
      'symlink_refused',
      'Refusing to replace a symbolic link.',
      filePath,
    );
  }
  if (!entry.isFile()) {
    return fail(
      'not_a_regular_file',
      'Refusing to replace a directory, device, socket, or pipe.',
      filePath,
    );
  }
  if (options.expectedExisting === undefined) {
    return fail(
      'target_exists',
      'Target exists; replacement requires an exact hash and ownership predicate.',
      filePath,
    );
  }

  const snapshot = await readBoundedLocalFile(filePath, {
    maxBytes: options.maxBytes,
    encoding: 'utf8',
  });
  if (snapshot.sha256 !== options.expectedExisting.sha256) {
    return fail(
      'overwrite_precondition_failed',
      'Existing file hash does not match the caller expectation.',
      filePath,
    );
  }
  let owned: boolean;
  try {
    owned = await options.expectedExisting.isOwned(snapshot);
  } catch (error) {
    return fail('ownership_rejected', 'Ownership predicate failed.', filePath, {
      cause: error,
    });
  }
  if (!owned) {
    return fail(
      'ownership_rejected',
      'Ownership predicate did not authorize replacement.',
      filePath,
    );
  }
  return snapshot;
};

const sameIdentity = (
  left: SafeLocalFileIdentity,
  right: SafeLocalFileIdentity,
): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.mode === right.mode &&
  left.links === right.links &&
  left.user === right.user &&
  left.group === right.group &&
  left.modifiedNanoseconds === right.modifiedNanoseconds &&
  left.changedNanoseconds === right.changedNanoseconds;

const createExclusiveTemporaryFile = async (
  directory: string,
  targetName: string,
  mode: number,
): Promise<{ readonly filePath: string; readonly handle: FileHandle }> => {
  const safePrefix = targetName.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 48);
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
    const temporaryPath = path.join(
      directory,
      `.${safePrefix}.craftcompass-${randomBytes(16).toString('hex')}.tmp`,
    );
    try {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        mode,
      );
      return { filePath: temporaryPath, handle };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error;
      }
      lastError = error;
    }
  }
  return fail(
    'write_failed',
    `Could not allocate an exclusive temporary file after ${MAX_TEMP_ATTEMPTS} attempts.`,
    path.join(directory, targetName),
    { cause: lastError },
  );
};

const syncDirectory = async (directory: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.sync();
  } finally {
    await handle?.close();
  }
};

const revalidateWritePrecondition = async (
  filePath: string,
  maxBytes: number,
  previous: SafeLocalFileSnapshot<string> | undefined,
): Promise<void> => {
  if (previous === undefined) {
    const entry = await inspectPath(filePath);
    if (entry !== undefined) {
      fail(
        'overwrite_precondition_failed',
        'Target appeared while preparing the atomic write.',
        filePath,
      );
    }
    return;
  }
  const current = await readBoundedLocalFile(filePath, {
    maxBytes,
    encoding: 'utf8',
  });
  if (
    current.sha256 !== previous.sha256 ||
    !sameIdentity(current.identity, previous.identity)
  ) {
    fail(
      'overwrite_precondition_failed',
      'Existing file changed while preparing the atomic write.',
      filePath,
    );
  }
};

const targetParentMatches = async (
  expected: ExpectedTargetParent,
): Promise<boolean> => {
  try {
    const entry = await inspectPath(expected.canonicalPath);
    return (
      entry !== undefined &&
      entry.isDirectory() &&
      sameDirectoryIdentity(expected.identity, toDirectoryIdentity(entry))
    );
  } catch {
    return false;
  }
};

const revalidateTargetParent = async (
  expected: ExpectedTargetParent | undefined,
  filePath: string,
): Promise<void> => {
  if (expected !== undefined && !(await targetParentMatches(expected))) {
    fail(
      'overwrite_precondition_failed',
      'Authorized target parent changed while preparing the atomic write.',
      filePath,
    );
  }
};

/**
 * Atomically install one generated UTF-8 text file from a same-directory,
 * exclusive temporary file.
 *
 * New targets use an atomic no-replace hard link, so a concurrent creator is
 * never overwritten. Existing files are replaced only after exact hash and
 * ownership checks, then revalidated immediately before rename. Node does not
 * expose a portable compare-and-swap replacement, so replacement callers must
 * also prevent unrelated writers when cross-process serialization is required.
 */
const writeTextFileAtomicallyForTarget = async (
  filePath: string,
  text: string,
  options: AtomicTextWriteOptions,
  expectedParent?: ExpectedTargetParent,
): Promise<AtomicTextWriteResult> => {
  const requestedPath = path.resolve(filePath);
  assertSupportedPlatform(requestedPath);
  validateMaximum(options.maxBytes, requestedPath);
  validateMode(options.mode, requestedPath);
  validateExpectedFile(options.expectedExisting, requestedPath);
  if (hasUnpairedSurrogate(text)) {
    return fail(
      'invalid_utf8',
      'Generated text contains an unpaired UTF-16 surrogate.',
      requestedPath,
    );
  }
  const content = Buffer.from(text, 'utf8');
  if (content.byteLength > options.maxBytes) {
    return fail(
      'file_too_large',
      `Generated text exceeds the configured ${options.maxBytes}-byte limit.`,
      requestedPath,
    );
  }

  const requestedParent = path.dirname(requestedPath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(requestedParent);
  } catch (error) {
    return fail(
      'path_not_found',
      'Target directory does not exist or cannot be canonicalized.',
      requestedParent,
      { cause: error },
    );
  }
  if (
    expectedParent !== undefined &&
    canonicalParent !== expectedParent.canonicalPath
  ) {
    return fail(
      'overwrite_precondition_failed',
      'Authorized target parent resolved to a different directory.',
      requestedPath,
    );
  }
  let parentEntry: BigIntStats | undefined;
  try {
    parentEntry = await inspectPath(canonicalParent);
  } catch (error) {
    return fail(
      'write_failed',
      'Could not inspect the canonical target directory.',
      canonicalParent,
      { cause: error },
    );
  }
  if (parentEntry === undefined || !parentEntry.isDirectory()) {
    return fail(
      'not_a_directory',
      'Target parent is not a directory.',
      canonicalParent,
    );
  }
  if (
    expectedParent !== undefined &&
    !sameDirectoryIdentity(
      expectedParent.identity,
      toDirectoryIdentity(parentEntry),
    )
  ) {
    return fail(
      'overwrite_precondition_failed',
      'Authorized target parent identity changed before the atomic write.',
      requestedPath,
    );
  }
  const targetPath = path.join(canonicalParent, path.basename(requestedPath));
  const existing = await inspectExistingGeneratedFile(targetPath, options);
  const creationMode =
    existing === undefined ? (options.mode ?? 0o600) : existing.identity.mode;
  const digest = sha256(content);

  let temporaryPath: string | undefined;
  let temporaryHandle: FileHandle | undefined;
  let installed = false;
  try {
    await revalidateTargetParent(expectedParent, targetPath);
    const temporary = await createExclusiveTemporaryFile(
      canonicalParent,
      path.basename(targetPath),
      creationMode,
    );
    temporaryPath = temporary.filePath;
    temporaryHandle = temporary.handle;
    await temporaryHandle.writeFile(content);
    const temporaryState = await temporaryHandle.stat({ bigint: true });
    if (
      !temporaryState.isFile() ||
      temporaryState.size !== BigInt(content.byteLength)
    ) {
      return fail(
        'write_failed',
        'Temporary file size or type did not match the generated content.',
        temporaryPath,
      );
    }
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await revalidateTargetParent(expectedParent, targetPath);
    await revalidateWritePrecondition(targetPath, options.maxBytes, existing);
    await revalidateTargetParent(expectedParent, targetPath);
    if (existing === undefined) {
      try {
        await link(temporaryPath, targetPath);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          return fail(
            'overwrite_precondition_failed',
            'Target appeared while completing the atomic create.',
            targetPath,
            { cause: error },
          );
        }
        throw error;
      }
      installed = true;
      await unlink(temporaryPath);
      temporaryPath = undefined;
    } else {
      await rename(temporaryPath, targetPath);
      installed = true;
      temporaryPath = undefined;
    }
    await revalidateTargetParent(expectedParent, targetPath);
    await syncDirectory(canonicalParent);
  } catch (error) {
    const failures: unknown[] = [error];
    if (temporaryHandle !== undefined) {
      try {
        await temporaryHandle.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (temporaryPath !== undefined) {
      const mayCleanByPath =
        expectedParent === undefined ||
        (await targetParentMatches(expectedParent));
      if (mayCleanByPath) {
        try {
          await unlink(temporaryPath);
        } catch (cleanupError) {
          if (!isErrno(cleanupError, 'ENOENT')) {
            failures.push(cleanupError);
          }
        }
      }
    }
    if (failures.length > 1) {
      return fail(
        'cleanup_failed',
        'Atomic write failed and temporary-file cleanup was incomplete.',
        targetPath,
        { cause: new AggregateError(failures) },
      );
    }
    if (error instanceof SafeLocalFileError) {
      throw error;
    }
    return fail(
      'write_failed',
      installed
        ? 'File was installed, but final cleanup or directory synchronization failed.'
        : 'Could not atomically write the generated text file.',
      targetPath,
      { cause: error },
    );
  }

  return {
    filePath: targetPath,
    byteLength: content.byteLength,
    sha256: digest,
    replacedExisting: existing !== undefined,
  };
};

export const writeTextFileAtomically = async (
  filePath: string,
  text: string,
  options: AtomicTextWriteOptions,
): Promise<AtomicTextWriteResult> =>
  writeTextFileAtomicallyForTarget(filePath, text, options);

/** Resolve and atomically write one repository-relative generated text file. */
export const writeRepositoryTextFileAtomically = async (
  repositoryRoot: string,
  target: string,
  text: string,
  options: AtomicTextWriteOptions,
): Promise<AtomicTextWriteResult> => {
  const resolvedTarget = await resolveSafeRepositoryTargetState(
    repositoryRoot,
    target,
    { allowMissing: true },
  );
  return writeTextFileAtomicallyForTarget(
    resolvedTarget.filePath,
    text,
    options,
    resolvedTarget.parent,
  );
};

export function readBoundedRepositoryFile(
  repositoryRoot: string,
  target: string,
  options: BoundedTextReadOptions,
): Promise<SafeLocalFileSnapshot<string>>;
export function readBoundedRepositoryFile(
  repositoryRoot: string,
  target: string,
  options: BoundedByteReadOptions,
): Promise<SafeLocalFileSnapshot<Uint8Array>>;
/**
 * Reads one repository-relative file only after rejecting symlinked ancestor
 * components, then revalidates the authorized parent identity around the read.
 */
export async function readBoundedRepositoryFile(
  repositoryRoot: string,
  target: string,
  options: BoundedByteReadOptions | BoundedTextReadOptions,
): Promise<SafeLocalFileSnapshot<string | Uint8Array>> {
  const resolved = await resolveSafeRepositoryTargetState(
    repositoryRoot,
    target,
  );
  await revalidateTargetParent(resolved.parent, resolved.filePath);
  const snapshot =
    options.encoding === 'utf8'
      ? await readBoundedLocalFile(resolved.filePath, options)
      : await readBoundedLocalFile(resolved.filePath, options);
  await revalidateTargetParent(resolved.parent, resolved.filePath);
  return snapshot;
}
