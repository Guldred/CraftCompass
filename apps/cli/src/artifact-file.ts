import type { CraftArtifact } from '@craftcompass/domain';
import { parseAllDocuments, stringify } from 'yaml';

import { readBoundedLocalFile, SafeLocalFileError } from './safe-local-file.js';

/** Error raised while reading or decoding a human-editable artifact file. */
export class ArtifactFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactFileError';
  }
}

/** Hard limit applied before any artifact text is decoded. */
// A normalized 10,000-record mutation report can be materially larger than
// its compact provider XML. Keep it reloadable while retaining a hard bound.
export const MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;

/** Reads YAML syntax only; domain detection and validation happen separately. */
export const readYamlArtifact = async (path: string): Promise<unknown> => {
  let source: string;
  try {
    source = (
      await readBoundedLocalFile(path, {
        maxBytes: MAX_ARTIFACT_FILE_BYTES,
        encoding: 'utf8',
      })
    ).content;
  } catch (error) {
    if (error instanceof SafeLocalFileError) {
      if (error.code === 'symlink_refused') {
        throw new ArtifactFileError(`Refusing to follow symlink: ${path}`, {
          cause: error,
        });
      }
      if (error.code === 'not_a_regular_file') {
        throw new ArtifactFileError(
          `Artifact input is not a regular file: ${path}`,
          { cause: error },
        );
      }
      if (error.code === 'file_too_large') {
        throw new ArtifactFileError(
          `Artifact exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte limit: ${path}`,
          { cause: error },
        );
      }
      if (error.code === 'invalid_utf8') {
        throw new ArtifactFileError(
          `Artifact is not valid UTF-8 text: ${path}`,
          { cause: error },
        );
      }
      if (error.code === 'file_changed') {
        throw new ArtifactFileError(
          `Artifact changed while it was being read: ${path}`,
          { cause: error },
        );
      }
    }
    throw new ArtifactFileError(`Could not read ${path}`, { cause: error });
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
