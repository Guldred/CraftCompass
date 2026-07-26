import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import type { CraftArtifact } from '@craftcompass/domain';
import { parseAllDocuments, stringify } from 'yaml';

/** Error raised while reading or decoding a human-editable artifact file. */
export class ArtifactFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactFileError';
  }
}

/** Hard limit applied before any artifact text is decoded. */
export const MAX_ARTIFACT_FILE_BYTES = 2 * 1024 * 1024;

/** Reads YAML syntax only; domain detection and validation happen separately. */
export const readYamlArtifact = async (path: string): Promise<unknown> => {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    throw new ArtifactFileError(`Could not read ${path}`, { cause: error });
  }
  if (entry.isSymbolicLink()) {
    throw new ArtifactFileError(`Refusing to follow symlink: ${path}`);
  }
  if (!entry.isFile()) {
    throw new ArtifactFileError(
      `Artifact input is not a regular file: ${path}`,
    );
  }
  if (entry.size > MAX_ARTIFACT_FILE_BYTES) {
    throw new ArtifactFileError(
      `Artifact exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte limit: ${path}`,
    );
  }

  let source: string;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedEntry = await handle.stat();
    if (!openedEntry.isFile()) {
      throw new ArtifactFileError(
        `Artifact input is not a regular file: ${path}`,
      );
    }
    if (openedEntry.size > MAX_ARTIFACT_FILE_BYTES) {
      throw new ArtifactFileError(
        `Artifact exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte limit: ${path}`,
      );
    }
    source = await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof ArtifactFileError) {
      throw error;
    }
    throw new ArtifactFileError(`Could not read ${path}`, { cause: error });
  } finally {
    await handle?.close();
  }

  const documents = parseAllDocuments(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new ArtifactFileError(
      `Expected exactly one YAML document in ${path}; found ${documents.length}`,
    );
  }
  const document = documents[0];
  if (document === undefined) {
    throw new ArtifactFileError(`Could not decode YAML in ${path}`);
  }
  if (document.errors.length > 0) {
    const details = document.errors.map((error) => error.message).join('; ');
    throw new ArtifactFileError(`Invalid YAML in ${path}: ${details}`);
  }
  if (document.warnings.length > 0) {
    const details = document.warnings
      .map((warning) => warning.message)
      .join('; ');
    throw new ArtifactFileError(
      `Unsupported or ambiguous YAML in ${path}: ${details}`,
    );
  }

  try {
    return document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new ArtifactFileError(`Could not decode YAML in ${path}`, {
      cause: error,
    });
  }
};

/** Produces deterministic YAML for semantic artifact round trips. */
export const serializeYamlArtifact = (artifact: CraftArtifact): string =>
  stringify(artifact, {
    lineWidth: 100,
    sortMapEntries: true,
  });
