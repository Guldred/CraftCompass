import {
  createArtifactRegistry,
  DEPENDENCY_DIRECTION_PRINCIPLE_ID,
  deriveDependencyDirectionRule,
  findRegistryArtifact,
  RepositoryRelativePathSchema,
  validateArtifact,
  type CraftArtifact,
  type LocatedArtifact,
  type ProjectProfile,
  type ValidationOptions,
} from '@craftcompass/domain';
import { deriveAssurancePlan } from '@craftcompass/assurance-engine';
import {
  compileAgentInstructions,
  renderAgentInstructions,
} from '@craftcompass/instruction-compiler';
import {
  createMutationBaseline,
  evaluateMutationPolicy,
  type MutationPolicyEvaluation,
} from '@craftcompass/mutation-engine';
import {
  normalizePitMutationRun,
  parsePitXml,
  PIT_XML_LIMITS,
} from '@craftcompass/providers-pitest';

import type {
  AgentInstructionsCheck,
  AgentInstructionsInstallResult,
} from './agent-instructions-file.js';
import { inspectArtifact } from './inspect.js';

/** Injectable edge dependencies used by the CLI application service. */
export interface CliDependencies {
  readonly readArtifact: (path: string) => Promise<unknown>;
  readonly loadArtifacts: (
    paths: readonly string[],
    now: Date,
    options?: Pick<ValidationOptions, 'preserveExpiredExceptions'>,
  ) => Promise<readonly LocatedArtifact[]>;
  readonly scanRepository: (path: string) => Promise<ProjectProfile>;
  readonly serializeArtifact: (artifact: CraftArtifact) => string;
  readonly readBytes: (
    path: string,
    maximumBytes: number,
  ) => Promise<Uint8Array>;
  readonly checkAgentInstructions: (
    repositoryRoot: string,
    expectedContent: string,
  ) => Promise<AgentInstructionsCheck>;
  readonly installAgentInstructions: (
    repositoryRoot: string,
    expectedContent: string,
  ) => Promise<AgentInstructionsInstallResult>;
  readonly writeOut: (message: string) => void;
  readonly writeError: (message: string) => void;
  readonly now: () => Date;
}

const USAGE = [
  'Usage:',
  '  craft help',
  '  craft --help',
  '  craft help scan',
  '  craft help project scan',
  '  craft scan --help',
  '  craft project scan --help',
  '  craft <validate|inspect> <artifact-path>',
  '  craft scan <repository-path>',
  '  craft project scan <repository-path>',
  '  craft registry validate <artifact-path>...',
  '  craft derive dependency-direction <project-id> <artifact-path>...',
  '  craft assurance plan <plan-id> <project-id> <profile-id> <change-id> <impact-id> <artifact-path>...',
  '  craft instructions render <project-id> <profile-id> <artifact-path>...',
  '  craft instructions install <repository-root> <project-id> <profile-id> <artifact-path>...',
  '  craft instructions check <repository-root> <project-id> <profile-id> <artifact-path>...',
  '  craft mutation import-pit <report-id> <plan-id> <tool-version> <sha256:configuration> <execution-evidence-path> <mutations.xml> <artifact-path>...',
  '  craft mutation baseline create <baseline-id> <mutation-report-path>',
  '  craft mutation evaluate <report-id> <baseline-id|-> <profile-id> <artifact-path>...',
].join('\n');

const SCAN_HELP = [
  'Usage:',
  '  craft scan <repository-path>',
  '  craft project scan <repository-path>',
  '',
  'Read supported repository manifests without executing target project code.',
  'On success, write one candidate project_profile YAML artifact to stdout.',
  'On failure, write one craftcompass_command_error JSON object to stderr.',
  'Both scan command forms are equivalent.',
].join('\n');

const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u;

/**
 * Keep line-oriented terminal diagnostics inert while leaving ordinary,
 * printable path text byte-for-byte readable.
 */
const escapeTerminalDynamicText = (value: string): string => {
  let escaped = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        FORMAT_CHARACTER_PATTERN.test(character))
    ) {
      escaped += `\\u{${codePoint.toString(16).toUpperCase()}}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
};

const errorMessage = (error: unknown): string =>
  escapeTerminalDynamicText(
    error instanceof Error ? error.message : String(error),
  );

const commandErrorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) {
    return 'repository_scan_failed';
  }
  try {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' && code.length > 0
      ? escapeTerminalDynamicText(code)
      : 'repository_scan_failed';
  } catch {
    return 'repository_scan_failed';
  }
};

const formatRepositoryScanError = (error: unknown): string =>
  JSON.stringify({
    schema_version: 1,
    kind: 'craftcompass_command_error',
    command: 'project_scan',
    code: commandErrorCode(error),
    message: errorMessage(error),
  });

const formatTerminalIssue = (issue: {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}): string =>
  `${escapeTerminalDynamicText(issue.path)}: ${escapeTerminalDynamicText(
    issue.message,
  )} [${escapeTerminalDynamicText(issue.code)}]`;

const parseRepositoryRelativePath = (value: string, label: string): string => {
  const result = RepositoryRelativePathSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return result.data;
};

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
        (artifact.observation_coverage?.inputs.reduce(
          (count, input) => count + countSourceReferences(input.evidence),
          0,
        ) ?? 0) +
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
        3 +
        artifact.mutations.reduce(
          (count, mutation) => count + countSourceReferences(mutation.evidence),
          0,
        ) +
        artifact.evidence.reduce(
          (count, evidence) =>
            count + countSourceReferences(evidence.references),
          0,
        )
      );
    case 'mutation_baseline':
      return (
        3 +
        (artifact.superseded_by === undefined ? 0 : 1) +
        artifact.entries.reduce(
          (count, mutation) => count + countSourceReferences(mutation.evidence),
          0,
        ) +
        countSourceReferences(artifact.activation?.evidence ?? [])
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
      `  ${escapeTerminalDynamicText(issue.origin)}${formatTerminalIssue(
        issue,
      )}`,
    );
  });
};

const readValidatedArtifact = async (
  artifactPath: string,
  dependencies: CliDependencies,
  now: Date,
): Promise<CraftArtifact> => {
  const input = await dependencies.readArtifact(artifactPath);
  const result = validateArtifact(input, { now });
  if (!result.success) {
    const details = result.issues
      .map((issue) => `${issue.path}: ${issue.message} [${issue.code}]`)
      .join('; ');
    throw new Error(
      `Invalid CraftCompass artifact ${artifactPath}: ${details}`,
    );
  }
  return result.artifact;
};

const formatMutationEvaluation = (
  evaluation: MutationPolicyEvaluation,
): string => {
  const lines = [
    `Mutation policy: ${escapeTerminalDynamicText(
      evaluation.status.toUpperCase(),
    )}`,
    `Report: ${escapeTerminalDynamicText(evaluation.reportId)}`,
    `Baseline: ${escapeTerminalDynamicText(evaluation.baselineId ?? 'none')}`,
    `Affected mutations: ${
      evaluation.affectedMutationIds.length === 0
        ? 'none'
        : evaluation.affectedMutationIds
            .map(escapeTerminalDynamicText)
            .join(', ')
    }`,
    'Reasons:',
    ...evaluation.reasons.map(
      (reason) =>
        `- ${escapeTerminalDynamicText(reason.code)}${
          reason.mutationIds.length === 0
            ? ''
            : `: ${reason.mutationIds
                .map(escapeTerminalDynamicText)
                .join(', ')}`
        }`,
    ),
  ];
  return lines.join('\n');
};

/** Executes one CLI invocation and returns its intended process exit code. */
export const runCli = async (
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> => {
  if (args.length === 1 && (args[0] === '--help' || args[0] === 'help')) {
    dependencies.writeOut(USAGE);
    return 0;
  }

  if (
    (args.length === 2 &&
      ((args[0] === 'help' && args[1] === 'scan') ||
        (args[0] === 'scan' && args[1] === '--help'))) ||
    (args.length === 3 &&
      ((args[0] === 'help' && args[1] === 'project' && args[2] === 'scan') ||
        (args[0] === 'project' && args[1] === 'scan' && args[2] === '--help')))
  ) {
    dependencies.writeOut(SCAN_HELP);
    return 0;
  }

  if (args[0] === 'mutation') {
    if (args[1] === 'import-pit') {
      if (
        args[2] === undefined ||
        args[3] === undefined ||
        args[4] === undefined ||
        args[5] === undefined ||
        args[6] === undefined ||
        args[7] === undefined ||
        args.length < 9
      ) {
        dependencies.writeError(USAGE);
        return 2;
      }
      try {
        const xmlPath = parseRepositoryRelativePath(args[7], 'PIT XML path');
        const evidencePath = parseRepositoryRelativePath(
          args[6],
          'Execution-evidence path',
        );
        const now = dependencies.now();
        const entries = await dependencies.loadArtifacts(args.slice(8), now);
        const registryResult = createArtifactRegistry(entries);
        if (!registryResult.success) {
          writeRegistryIssues(registryResult.issues, dependencies.writeError);
          return 1;
        }
        const planEntry = findRegistryArtifact(
          registryResult.registry,
          args[3],
        );
        if (planEntry?.artifact.kind !== 'assurance_plan') {
          dependencies.writeError(
            `Assurance plan ${escapeTerminalDynamicText(
              args[3],
            )} was not found in the artifact registry`,
          );
          return 1;
        }
        if (planEntry.artifact.mutation_scope === undefined) {
          dependencies.writeError(
            `Assurance plan ${escapeTerminalDynamicText(
              args[3],
            )} has no mutation scope`,
          );
          return 1;
        }
        const run = parsePitXml(
          await dependencies.readBytes(xmlPath, PIT_XML_LIMITS.input_bytes),
          xmlPath,
        );
        const report = normalizePitMutationRun({
          reportId: args[2],
          run,
          plan: planEntry.artifact,
          capturedAt: now,
          toolVersion: args[4],
          executionAttestation: {
            assurancePlanRef: planEntry.artifact.id,
            scope: planEntry.artifact.mutation_scope,
            configurationFingerprint: args[5],
            evidence: {
              id: `EV-PIT-EXECUTION:${args[2]}`,
              type: 'build_configuration',
              description:
                'Caller-attested PIT execution configuration for the selected assurance-plan scope.',
              location: evidencePath,
              captured_at: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
              provider: 'pitest',
            },
          },
        });
        dependencies.writeOut(dependencies.serializeArtifact(report));
        return 0;
      } catch (error) {
        dependencies.writeError(errorMessage(error));
        return 1;
      }
    }

    if (args[1] === 'baseline' && args[2] === 'create') {
      if (args.length !== 5 || args[3] === undefined || args[4] === undefined) {
        dependencies.writeError(USAGE);
        return 2;
      }
      try {
        const now = dependencies.now();
        const report = await readValidatedArtifact(args[4], dependencies, now);
        if (report.kind !== 'mutation_report') {
          dependencies.writeError(
            `Artifact ${escapeTerminalDynamicText(args[4])} is ${report.kind}, not mutation_report`,
          );
          return 1;
        }
        const baseline = createMutationBaseline({
          id: args[3],
          report,
          createdAt: now,
        });
        dependencies.writeOut(dependencies.serializeArtifact(baseline));
        return 0;
      } catch (error) {
        dependencies.writeError(errorMessage(error));
        return 1;
      }
    }

    if (args[1] === 'evaluate') {
      if (
        args.length < 6 ||
        args[2] === undefined ||
        args[3] === undefined ||
        args[4] === undefined
      ) {
        dependencies.writeError(USAGE);
        return 2;
      }
      try {
        const now = dependencies.now();
        const entries = await dependencies.loadArtifacts(args.slice(5), now, {
          preserveExpiredExceptions: true,
        });
        const registryResult = createArtifactRegistry(entries);
        if (!registryResult.success) {
          writeRegistryIssues(registryResult.issues, dependencies.writeError);
          return 1;
        }
        const reportEntry = findRegistryArtifact(
          registryResult.registry,
          args[2],
        );
        const profileEntry = findRegistryArtifact(
          registryResult.registry,
          args[4],
        );
        const baselineEntry =
          args[3] === '-'
            ? undefined
            : findRegistryArtifact(registryResult.registry, args[3]);
        if (reportEntry?.artifact.kind !== 'mutation_report') {
          dependencies.writeError(
            `Mutation report ${escapeTerminalDynamicText(
              args[2],
            )} was not found in the artifact registry`,
          );
          return 1;
        }
        if (profileEntry?.artifact.kind !== 'assurance_profile') {
          dependencies.writeError(
            `Assurance profile ${escapeTerminalDynamicText(
              args[4],
            )} was not found in the artifact registry`,
          );
          return 1;
        }
        if (
          args[3] !== '-' &&
          baselineEntry?.artifact.kind !== 'mutation_baseline'
        ) {
          dependencies.writeError(
            `Mutation baseline ${escapeTerminalDynamicText(
              args[3],
            )} was not found in the artifact registry`,
          );
          return 1;
        }
        const evaluation = evaluateMutationPolicy({
          registry: registryResult.registry,
          reportId: reportEntry.artifact.id,
          ...(baselineEntry?.artifact.kind === 'mutation_baseline'
            ? { baselineId: baselineEntry.artifact.id }
            : {}),
          profileId: profileEntry.artifact.id,
          now,
        });
        dependencies.writeOut(formatMutationEvaluation(evaluation));
        return evaluation.status === 'passed' ? 0 : 1;
      } catch (error) {
        dependencies.writeError(errorMessage(error));
        return 1;
      }
    }

    dependencies.writeError(USAGE);
    return 2;
  }

  if (args[0] === 'assurance') {
    if (
      args[1] !== 'plan' ||
      args[2] === undefined ||
      args[3] === undefined ||
      args[4] === undefined ||
      args[5] === undefined ||
      args[6] === undefined ||
      args.length < 8
    ) {
      dependencies.writeError(USAGE);
      return 2;
    }
    try {
      const entries = await dependencies.loadArtifacts(
        args.slice(7),
        dependencies.now(),
      );
      const registryResult = createArtifactRegistry(entries);
      if (!registryResult.success) {
        writeRegistryIssues(registryResult.issues, dependencies.writeError);
        return 1;
      }
      const project = findRegistryArtifact(registryResult.registry, args[3]);
      const profile = findRegistryArtifact(registryResult.registry, args[4]);
      const change = findRegistryArtifact(registryResult.registry, args[5]);
      const impact = findRegistryArtifact(registryResult.registry, args[6]);
      const required = [
        [args[3], 'project_profile', project],
        [args[4], 'assurance_profile', profile],
        [args[5], 'change_context', change],
        [args[6], 'change_impact', impact],
      ] as const;
      const missing = required.find(
        ([, kind, entry]) => entry?.artifact.kind !== kind,
      );
      if (missing !== undefined) {
        dependencies.writeError(
          `Artifact ${escapeTerminalDynamicText(
            missing[0],
          )} was not found as ${escapeTerminalDynamicText(
            missing[1],
          )} in the artifact registry`,
        );
        return 1;
      }
      if (
        project?.artifact.kind !== 'project_profile' ||
        profile?.artifact.kind !== 'assurance_profile' ||
        change?.artifact.kind !== 'change_context' ||
        impact?.artifact.kind !== 'change_impact'
      ) {
        dependencies.writeError(
          'Could not select the typed assurance-planning inputs',
        );
        return 1;
      }
      const derivation = deriveAssurancePlan({
        id: args[2],
        project: project.artifact,
        profile: profile.artifact,
        change: change.artifact,
        impact: impact.artifact,
      });
      if (!derivation.success) {
        dependencies.writeError('Could not derive an assurance plan:');
        derivation.issues.forEach((issue) => {
          dependencies.writeError(`  ${formatTerminalIssue(issue)}`);
        });
        return 1;
      }
      dependencies.writeOut(dependencies.serializeArtifact(derivation.plan));
      return 0;
    } catch (error) {
      dependencies.writeError(errorMessage(error));
      return 1;
    }
  }

  if (args[0] === 'instructions') {
    const action = args[1];
    const renderOnly = action === 'render';
    const managedFileAction = action === 'install' || action === 'check';
    const repositoryRoot = managedFileAction ? args[2] : undefined;
    const projectId = renderOnly ? args[2] : args[3];
    const profileId = renderOnly ? args[3] : args[4];
    const artifactOffset = renderOnly ? 4 : 5;
    if (
      (!renderOnly && !managedFileAction) ||
      (managedFileAction && repositoryRoot === undefined) ||
      projectId === undefined ||
      profileId === undefined ||
      args.length <= artifactOffset
    ) {
      dependencies.writeError(USAGE);
      return 2;
    }
    try {
      const now = dependencies.now();
      if (Number.isNaN(now.getTime())) {
        throw new Error('CLI clock returned an invalid date');
      }
      const entries = await dependencies.loadArtifacts(
        args.slice(artifactOffset),
        now,
      );
      const registryResult = createArtifactRegistry(entries);
      if (!registryResult.success) {
        writeRegistryIssues(registryResult.issues, dependencies.writeError);
        return 1;
      }
      const model = compileAgentInstructions({
        registry: registryResult.registry,
        effectiveOn: now.toISOString().slice(0, 10),
        projectId,
        assuranceProfileId: profileId,
      });
      const content = renderAgentInstructions(model);
      if (renderOnly) {
        dependencies.writeOut(content);
        return 0;
      }
      if (repositoryRoot === undefined) {
        dependencies.writeError(USAGE);
        return 2;
      }
      if (action === 'install') {
        const result = await dependencies.installAgentInstructions(
          repositoryRoot,
          content,
        );
        dependencies.writeOut(
          `Agent instructions ${escapeTerminalDynamicText(
            result.status,
          )}: ${escapeTerminalDynamicText(
            result.filePath,
          )} (${escapeTerminalDynamicText(result.sha256)})`,
        );
        return 0;
      }
      const result = await dependencies.checkAgentInstructions(
        repositoryRoot,
        content,
      );
      const message = `Agent instructions ${escapeTerminalDynamicText(
        result.status,
      )}: ${escapeTerminalDynamicText(result.filePath)}`;
      if (result.status === 'current') {
        dependencies.writeOut(message);
        return 0;
      }
      dependencies.writeError(message);
      return 1;
    } catch (error) {
      dependencies.writeError(errorMessage(error));
      return 1;
    }
  }

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
          `Project profile ${escapeTerminalDynamicText(
            args[2],
          )} was not found in the artifact registry`,
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
          dependencies.writeError(`  ${formatTerminalIssue(issue)}`);
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
      dependencies.writeError(formatRepositoryScanError(error));
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
    dependencies.writeError(
      `Invalid CraftCompass artifact: ${escapeTerminalDynamicText(path)}`,
    );
    result.issues.forEach((issue) => {
      dependencies.writeError(`  ${formatTerminalIssue(issue)}`);
    });
    return 1;
  }

  if (command === 'validate') {
    dependencies.writeOut(
      `Valid ${escapeTerminalDynamicText(
        result.artifact.kind,
      )} ${escapeTerminalDynamicText(
        result.artifact.id,
      )} (schema version ${escapeTerminalDynamicText(
        String(result.artifact.schema_version),
      )})`,
    );
  } else {
    dependencies.writeOut(inspectArtifact(result.artifact));
  }
  return 0;
};
