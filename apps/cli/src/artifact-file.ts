import { readFile } from 'node:fs/promises';

import type { CraftArtifact } from '@craftcompass/domain';
import { parseDocument, stringify } from 'yaml';

/** Error raised while reading or decoding a human-editable artifact file. */
export class ArtifactFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArtifactFileError';
  }
}

/** Reads YAML syntax only; domain detection and validation happen separately. */
export const readYamlArtifact = async (path: string): Promise<unknown> => {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ArtifactFileError(`Could not read ${path}`, { cause: error });
  }

  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    const details = document.errors.map((error) => error.message).join('; ');
    throw new ArtifactFileError(`Invalid YAML in ${path}: ${details}`);
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
