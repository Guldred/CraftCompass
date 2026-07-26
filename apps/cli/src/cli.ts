import {
  createArtifactRegistry,
  DEPENDENCY_DIRECTION_PRINCIPLE_ID,
  deriveDependencyDirectionRule,
  findRegistryArtifact,
  validateArtifact,
  type CraftArtifact,
  type LocatedArtifact,
  type ProjectProfile,
} from '@craftcompass/domain';

import { inspectArtifact } from './inspect.js';

/** Injectable edge dependencies used by the CLI application service. */
export interface CliDependencies {
  readonly readArtifact: (path: string) => Promise<unknown>;
  readonly loadArtifacts: (
    paths: readonly string[],
    now: Date,
  ) => Promise<readonly LocatedArtifact[]>;
  readonly scanRepository: (path: string) => Promise<ProjectProfile>;
  readonly serializeArtifact: (artifact: CraftArtifact) => string;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
  readonly now: () => Date;
}

const USAGE = [
  'Usage:',
  '  craft <validate|inspect> <artifact-path>',
  '  craft scan <repository-path>',
  '  craft project scan <repository-path>',
  '  craft registry validate <artifact-path>...',
  '  craft derive dependency-direction <project-id> <artifact-path>...',
].join('\n');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const countSourceReferences = (
  references: readonly { readonly source_ref?: string | undefined }[],
): number =>
  references.filter((reference) => reference.source_ref !== undefined).length;

const countSupportedReferences = (artifact: CraftArtifact): number => {
  switch (artifact.kind) {
    case 'craftsmanship_principle':
    case 'practice_statement':
      return 0;
    case 'project_profile':
      return (
        (artifact.adaptation_context?.observation_refs.length ?? 0) +
        (artifact.adaptation_context === undefined
          ? 0
          : countSourceReferences(artifact.adaptation_context.evidence)) +
        artifact.technologies.reduce(
          (count, technology) =>
            count + countSourceReferences(technology.evidence),
          0,
        ) +
        artifact.modules.reduce(
          (count, module) =>
            count +
            countSourceReferences(module.evidence) +
            (module.architecture_role?.observation_refs.length ?? 0) +
            (module.architecture_role === undefined
              ? 0
              : countSourceReferences(module.architecture_role.evidence)),
          0,
        ) +
        artifact.observations.reduce(
          (count, observation) =>
            count + countSourceReferences(observation.evidence),
          0,
        ) +
        artifact.constraints.reduce(
          (count, constraint) =>
            count + countSourceReferences(constraint.evidence),
          0,
        ) +
        artifact.uncertainties.reduce(
          (count, uncertainty) =>
            count + countSourceReferences(uncertainty.evidence),
          0,
        )
      );
    case 'change_context':
      return (
        1 +
        countSourceReferences(artifact.evidence) +
        artifact.changed_files.reduce(
          (count, file) => count + countSourceReferences(file.evidence),
          0,
        ) +
        artifact.changed_symbols.reduce(
          (count, symbol) => count + countSourceReferences(symbol.evidence),
          0,
        )
      );
    case 'change_impact':
      return (
        2 +
        countSourceReferences(artifact.evidence) +
        artifact.changed_symbols.reduce(
          (count, symbol) => count + countSourceReferences(symbol.evidence),
          0,
        ) +
        artifact.direct_impacts.reduce(
          (count, impact) =>
            count + countSourceReferences(impact.symbol.evidence),
          0,
        ) +
        artifact.indirect_impacts.reduce(
          (count, impact) =>
            count + countSourceReferences(impact.symbol.evidence),
          0,
        ) +
        artifact.impacted_flows.reduce(
          (count, flow) => count + countSourceReferences(flow.evidence),
          0,
        ) +
        artifact.functional_clusters.reduce(
          (count, cluster) => count + countSourceReferences(cluster.evidence),
          0,
        ) +
        artifact.candidate_tests.reduce(
          (count, test) => count + countSourceReferences(test.evidence),
          0,
        )
      );
    case 'project_rule':
      return (
        1 +
        artifact.principle_refs.length +
        artifact.observation_refs.length +
        artifact.module_refs.length +
        countSourceReferences(artifact.evidence) +
        artifact.exceptions.active_exceptions.reduce(
          (count, exception) =>
            count + countSourceReferences(exception.evidence),
          0,
        )
      );
    case 'assurance_profile':
      return (
        1 +
        countSourceReferences(artifact.readiness?.evidence ?? []) +
        artifact.exception_policy.active_exceptions.reduce(
          (count, exception) =>
            count + countSourceReferences(exception.evidence),
          0,
        )
      );
    case 'assurance_plan':
      return (
        2 +
        (artifact.change_context_ref === undefined ? 0 : 1) +
        (artifact.impact_ref === undefined ? 0 : 1) +
        countSourceReferences(artifact.risk.evidence) +
        countSourceReferences(artifact.derivation_evidence ?? [])
      );
    case 'mutation_report':
      return (
        artifact.survivors.reduce(
          (count, survivor) => count + countSourceReferences(survivor.evidence),
          0,
        ) +
        artifact.evidence.reduce(
          (count, evidence) =>
            count + countSourceReferences(evidence.references),
          0,
        )
      );
  }
};

const writeRegistryIssues = (
  issues: readonly {
    readonly origin: string;
    readonly path: string;
    readonly message: string;
    readonly code: string;
  }[],
  writeError: (message: string) => void,
): void => {
  writeError('Invalid CraftCompass artifact registry:');
  issues.forEach((issue) => {
    writeError(
      `  ${issue.origin}${issue.path}: ${issue.message} [${issue.code}]`,
    );
  });
};

/** Executes one CLI invocation and returns its intended process exit code. */
export const runCli = async (
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> => {
  if (args[0] === 'registry') {
    if (args[1] !== 'validate' || args.length < 3) {
      dependencies.writeError(USAGE);
      return 2;
    }
    try {
      const entries = await dependencies.loadArtifacts(
        args.slice(2),
        dependencies.now(),
      );
      const result = createArtifactRegistry(entries);
      if (!result.success) {
        writeRegistryIssues(result.issues, dependencies.writeError);
        return 1;
      }
      const referenceCount = result.registry.entries.reduce(
        (count, entry) => count + countSupportedReferences(entry.artifact),
        0,
      );
      dependencies.writeOut(
        `Valid artifact registry: ${result.registry.entries.length} artifacts; ${referenceCount} supported references resolved`,
      );
      return 0;
    } catch (error) {
      dependencies.writeError(errorMessage(error));
      return 1;
    }
  }

  if (args[0] === 'derive') {
    if (
      args[1] !== 'dependency-direction' ||
      args[2] === undefined ||
      args.length < 4
    ) {
      dependencies.writeError(USAGE);
      return 2;
    }
    try {
      const entries = await dependencies.loadArtifacts(
        args.slice(3),
        dependencies.now(),
      );
      const registryResult = createArtifactRegistry(entries);
      if (!registryResult.success) {
        writeRegistryIssues(registryResult.issues, dependencies.writeError);
        return 1;
      }
      const projectEntry = findRegistryArtifact(
        registryResult.registry,
        args[2],
      );
      if (projectEntry?.artifact.kind !== 'project_profile') {
        dependencies.writeError(
          `Project profile ${args[2]} was not found in the artifact registry`,
        );
        return 1;
      }
      const principleEntry = findRegistryArtifact(
        registryResult.registry,
        DEPENDENCY_DIRECTION_PRINCIPLE_ID,
      );
      if (principleEntry?.artifact.kind !== 'craftsmanship_principle') {
        dependencies.writeError(
          `Craftsmanship principle ${DEPENDENCY_DIRECTION_PRINCIPLE_ID} was not found in the artifact registry`,
        );
        return 1;
      }
      const derivation = deriveDependencyDirectionRule({
        principle: principleEntry.artifact,
        project: projectEntry.artifact,
      });
      if (!derivation.success) {
        dependencies.writeError(
          'Could not derive a dependency-direction rule:',
        );
        derivation.issues.forEach((issue) => {
          dependencies.writeError(
            `  ${issue.path}: ${issue.message} [${issue.code}]`,
          );
        });
        return 1;
      }
      dependencies.writeOut(dependencies.serializeArtifact(derivation.rule));
      return 0;
    } catch (error) {
      dependencies.writeError(errorMessage(error));
      return 1;
    }
  }

  const normalizedArgs =
    args.length === 3 && args[0] === 'project' && args[1] === 'scan'
      ? (['scan', args[2]] as const)
      : args;
  const command = normalizedArgs[0];
  const path = normalizedArgs[1];
  if (
    normalizedArgs.length !== 2 ||
    (command !== 'validate' && command !== 'inspect' && command !== 'scan') ||
    path === undefined
  ) {
    dependencies.writeError(USAGE);
    return 2;
  }

  if (command === 'scan') {
    try {
      const profile = await dependencies.scanRepository(path);
      dependencies.writeOut(dependencies.serializeArtifact(profile));
      return 0;
    } catch (error) {
      dependencies.writeError(errorMessage(error));
      return 1;
    }
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
