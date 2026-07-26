import { validateArtifact } from '@craftcompass/domain';

import { inspectArtifact } from './inspect.js';

/** Injectable edge dependencies used by the CLI application service. */
export interface CliDependencies {
  readonly readArtifact: (path: string) => Promise<unknown>;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
  readonly now: () => Date;
}

const USAGE = 'Usage: craft <validate|inspect> <path>';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Executes one CLI invocation and returns its intended process exit code. */
export const runCli = async (
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> => {
  const command = args[0];
  const path = args[1];
  if (
    args.length !== 2 ||
    (command !== 'validate' && command !== 'inspect') ||
    path === undefined
  ) {
    dependencies.writeError(USAGE);
    return 2;
  }

  let input: unknown;
  try {
    input = await dependencies.readArtifact(path);
  } catch (error) {
    dependencies.writeError(errorMessage(error));
    return 1;
  }

  const result = validateArtifact(input, { now: dependencies.now() });
  if (!result.success) {
    dependencies.writeError(`Invalid CraftCompass artifact: ${path}`);
    result.issues.forEach((issue) => {
      dependencies.writeError(
        `  ${issue.path}: ${issue.message} [${issue.code}]`,
      );
    });
    return 1;
  }

  if (command === 'validate') {
    dependencies.writeOut(
      `Valid ${result.artifact.kind} ${result.artifact.id} (schema version ${result.artifact.schema_version})`,
    );
  } else {
    dependencies.writeOut(inspectArtifact(result.artifact));
  }
  return 0;
};
