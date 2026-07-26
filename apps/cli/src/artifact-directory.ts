import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { validateArtifact, type LocatedArtifact } from '@craftcompass/domain';

import {
  ArtifactFileError,
  MAX_ARTIFACT_FILE_BYTES,
  readYamlArtifact,
} from './artifact-file.js';

export const MAX_ARTIFACT_INPUT_FILES = 1_000;
export const MAX_ARTIFACT_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_DIRECTORY_DEPTH = 32;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isYamlPath = (candidate: string): boolean => {
  const extension = path.extname(candidate).toLowerCase();
  return extension === '.yaml' || extension === '.yml';
};

const normalizeOrigin = (candidate: string): string =>
  candidate.split(path.sep).join('/');

interface CollectionState {
  readonly collected: Set<string>;
  totalBytes: number;
}

const collectYamlPaths = async (
  candidate: string,
  explicitFile: boolean,
  state: CollectionState,
  depth: number,
): Promise<void> => {
  if (depth > MAX_ARTIFACT_DIRECTORY_DEPTH) {
    throw new ArtifactFileError(
      `Artifact directory depth exceeds ${MAX_ARTIFACT_DIRECTORY_DEPTH}: ${candidate}`,
    );
  }
  let entry;
  try {
    entry = await lstat(candidate);
  } catch (error) {
    throw new ArtifactFileError(`Could not inspect ${candidate}`, {
      cause: error,
    });
  }
  if (entry.isSymbolicLink()) {
    throw new ArtifactFileError(`Refusing to follow symlink: ${candidate}`);
  }
  if (entry.isFile()) {
    if (!isYamlPath(candidate)) {
      if (explicitFile) {
        throw new ArtifactFileError(
          `Artifact input must be a .yaml or .yml file: ${candidate}`,
        );
      }
      return;
    }
    const resolved = path.resolve(candidate);
    if (state.collected.has(resolved)) {
      return;
    }
    if (entry.size > MAX_ARTIFACT_FILE_BYTES) {
      throw new ArtifactFileError(
        `Artifact exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte limit: ${candidate}`,
      );
    }
    if (state.collected.size >= MAX_ARTIFACT_INPUT_FILES) {
      throw new ArtifactFileError(
        `Artifact input exceeds the ${MAX_ARTIFACT_INPUT_FILES}-file limit`,
      );
    }
    if (state.totalBytes + entry.size > MAX_ARTIFACT_INPUT_BYTES) {
      throw new ArtifactFileError(
        `Artifact input exceeds the ${MAX_ARTIFACT_INPUT_BYTES}-byte aggregate limit`,
      );
    }
    state.collected.add(resolved);
    state.totalBytes += entry.size;
    return;
  }
  if (!entry.isDirectory()) {
    throw new ArtifactFileError(
      `Artifact input is not a regular file or directory: ${candidate}`,
    );
  }

  let children;
  try {
    children = await readdir(candidate, { withFileTypes: true });
  } catch (error) {
    throw new ArtifactFileError(`Could not list ${candidate}`, {
      cause: error,
    });
  }
  for (const child of children.sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    const childPath = path.join(candidate, child.name);
    if (child.isSymbolicLink()) {
      throw new ArtifactFileError(`Refusing to follow symlink: ${childPath}`);
    }
    if (child.isDirectory() || (child.isFile() && isYamlPath(childPath))) {
      await collectYamlPaths(childPath, false, state, depth + 1);
    }
  }
};

const canonicalizeInput = async (candidate: string): Promise<string> => {
  const resolved = path.resolve(candidate);
  let entry;
  try {
    entry = await lstat(resolved);
  } catch (error) {
    throw new ArtifactFileError(`Could not inspect ${resolved}`, {
      cause: error,
    });
  }
  if (entry.isSymbolicLink()) {
    throw new ArtifactFileError(`Refusing to follow symlink: ${resolved}`);
  }
  try {
    const canonicalParent = await realpath(path.dirname(resolved));
    return path.join(canonicalParent, path.basename(resolved));
  } catch (error) {
    throw new ArtifactFileError(`Could not resolve ${resolved}`, {
      cause: error,
    });
  }
};

/**
 * Recursively loads, validates, sorts, and deduplicates YAML artifact inputs.
 * Explicit parent paths are canonicalized; artifact/descendant symlinks and
 * multi-document YAML are rejected to keep registry inputs exact.
 */
export const loadArtifactInputs = async (
  inputPaths: readonly string[],
  now: Date,
): Promise<readonly LocatedArtifact[]> => {
  const state: CollectionState = {
    collected: new Set<string>(),
    totalBytes: 0,
  };
  for (const inputPath of inputPaths) {
    await collectYamlPaths(await canonicalizeInput(inputPath), true, state, 0);
  }

  const origins = [...state.collected].sort(compareText);
  if (origins.length === 0) {
    throw new ArtifactFileError(
      'No .yaml or .yml artifacts were found in the supplied inputs',
    );
  }
  const entries: LocatedArtifact[] = [];
  for (const origin of origins) {
    const result = validateArtifact(await readYamlArtifact(origin), {
      now,
    });
    if (!result.success) {
      const details = result.issues
        .map((issue) => `${issue.path}: ${issue.message} [${issue.code}]`)
        .join('; ');
      throw new ArtifactFileError(
        `Invalid CraftCompass artifact in ${origin}: ${details}`,
      );
    }
    entries.push({
      origin: normalizeOrigin(origin),
      artifact: result.artifact,
    });
  }
  return entries;
};
