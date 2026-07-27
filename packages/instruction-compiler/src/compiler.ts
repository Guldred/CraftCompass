import { Buffer } from 'node:buffer';

import {
  ArtifactIdSchema,
  IsoDateSchema,
  createArtifactRegistry,
  validateArtifact,
  type CraftArtifact,
  type ArtifactRegistry,
  type LocatedArtifact,
  type ProjectRule,
  type RegistryIssue,
  type ValidationIssue,
} from '@craftcompass/domain';

import {
  AGENT_INSTRUCTION_COMPILER_ID,
  AGENT_INSTRUCTION_FORMAT_VERSION,
  MAX_INSTRUCTION_COLLECTION_ITEMS,
  MAX_INSTRUCTION_TEXT_BYTES,
  MAX_PROJECT_RULES,
  InstructionCompilationError,
  type AgentDecisionRequiredRule,
  type AgentDirectiveAuthority,
  type AgentInstructionException,
  type AgentInstructionModel,
  type AgentInstructionScope,
  type AgentRuleDirective,
  type CompileAgentInstructionsRequest,
} from './model.js';

const MAX_COMPILATION_REGISTRY_ENTRIES = 1_000;
const MAX_COMPILATION_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_COMPILATION_TOTAL_STRING_BYTES = 32 * 1024 * 1024;
// Domain mutation reports and baselines permit up to 100,000 records.
const MAX_COMPILATION_COLLECTION_ITEMS = 100_000;
const MAX_COMPILATION_OBJECT_PROPERTIES = 256;
const MAX_COMPILATION_NESTING_DEPTH = 32;
const MAX_COMPILATION_VALUE_NODES = 10_000_000;
const MAX_ORIGIN_BYTES = 4_096;
const MAX_REPORTED_ISSUES = 8;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareDirective = (
  left: AgentRuleDirective,
  right: AgentRuleDirective,
): number => compareText(left.ruleId, right.ruleId);

const compareException = (
  left: AgentInstructionException,
  right: AgentInstructionException,
): number =>
  compareText(left.sourceArtifactId, right.sourceArtifactId) ||
  compareText(left.exceptionId, right.exceptionId) ||
  compareText(left.owner, right.owner) ||
  compareText(left.expiresOn, right.expiresOn) ||
  compareText(left.scope, right.scope);

const compareDecisionRule = (
  left: AgentDecisionRequiredRule,
  right: AgentDecisionRequiredRule,
): number => compareText(left.ruleId, right.ruleId);

const sortedText = <Text extends string>(
  values: readonly Text[],
  label: string,
): readonly Text[] => {
  if (values.length > MAX_INSTRUCTION_COLLECTION_ITEMS) {
    throw new InstructionCompilationError(
      'input_limit_exceeded',
      `${label} has ${values.length} entries; the limit is ${MAX_INSTRUCTION_COLLECTION_ITEMS}`,
    );
  }
  for (const value of values) {
    if (
      value.length > MAX_INSTRUCTION_TEXT_BYTES ||
      Buffer.byteLength(value, 'utf8') > MAX_INSTRUCTION_TEXT_BYTES
    ) {
      throw new InstructionCompilationError(
        'output_too_large',
        `${label} contains text larger than ${MAX_INSTRUCTION_TEXT_BYTES} bytes`,
      );
    }
  }
  return [...values].sort(compareText);
};

type UnknownRecord = Record<string, unknown>;

const isUnknownRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireCompilationRecord = (
  value: unknown,
  label: string,
): UnknownRecord => {
  if (!isUnknownRecord(value)) {
    throw new InstructionCompilationError(
      'invalid_artifact',
      `${label} must be an object`,
    );
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidRuntimeInput(`${label} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_COMPILATION_OBJECT_PROPERTIES) {
    inputLimitExceeded(
      `${label} has more than ${MAX_COMPILATION_OBJECT_PROPERTIES} properties`,
    );
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      invalidRuntimeInput(`${label} must not contain symbol properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      invalidRuntimeInput(`${label} must not contain accessor properties`);
    }
  }
  return value;
};

const invalidRuntimeInput = (message: string): never => {
  throw new InstructionCompilationError('invalid_artifact', message);
};

const inputLimitExceeded = (message: string): never => {
  throw new InstructionCompilationError('input_limit_exceeded', message);
};

const requireCompilationField = (
  record: UnknownRecord,
  field: string,
  label: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (descriptor === undefined || !('value' in descriptor)) {
    invalidRuntimeInput(`${label}.${field} must be a data property`);
  }
  return (descriptor as PropertyDescriptor & { readonly value: unknown }).value;
};

const requireCompilationArrayItem = (
  values: readonly unknown[],
  index: number,
  label: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
  if (descriptor === undefined || !('value' in descriptor)) {
    invalidRuntimeInput(`${label}[${index}] must be a data property`);
  }
  return (descriptor as PropertyDescriptor & { readonly value: unknown }).value;
};

interface CompilationInputBudget {
  scheduledNodes: number;
  stringBytes: number;
}

interface PendingInputValue {
  readonly value: unknown;
  readonly depth: number;
  readonly exiting: boolean;
}

/**
 * Bounds arbitrary public-API input before it reaches Zod, registry maps, or
 * sorting code. Serialized CLI inputs already have equivalent file limits, but
 * the compiler also accepts in-memory values.
 */
const assertCompilationInputBounds = (
  input: unknown,
  budget: CompilationInputBudget,
): void => {
  const pending: PendingInputValue[] = [
    { value: input, depth: 0, exiting: false },
  ];
  budget.scheduledNodes += 1;
  if (budget.scheduledNodes > MAX_COMPILATION_VALUE_NODES) {
    inputLimitExceeded(
      `Compilation input exceeds the ${MAX_COMPILATION_VALUE_NODES}-value limit`,
    );
  }
  const active = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      invalidRuntimeInput('Compilation input traversal became inconsistent');
    }
    const { value, depth, exiting } = current as PendingInputValue;
    if (typeof value === 'string') {
      if (value.length > MAX_COMPILATION_ARTIFACT_BYTES) {
        inputLimitExceeded(
          `Compilation input contains a string larger than ${MAX_COMPILATION_ARTIFACT_BYTES} bytes`,
        );
      }
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_COMPILATION_ARTIFACT_BYTES) {
        inputLimitExceeded(
          `Compilation input contains a string larger than ${MAX_COMPILATION_ARTIFACT_BYTES} bytes`,
        );
      }
      budget.stringBytes += bytes;
      if (budget.stringBytes > MAX_COMPILATION_TOTAL_STRING_BYTES) {
        inputLimitExceeded(
          `Compilation input exceeds the ${MAX_COMPILATION_TOTAL_STRING_BYTES}-byte aggregate string limit`,
        );
      }
      continue;
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      continue;
    }
    if (typeof value !== 'object') {
      invalidRuntimeInput(
        'Compilation input must contain only serializable artifact values',
      );
    }
    if (exiting) {
      active.delete(value);
      continue;
    }
    if (active.has(value)) {
      invalidRuntimeInput('Compilation input must not contain cyclic values');
    }
    active.add(value);
    pending.push({ value, depth, exiting: true });
    if (depth >= MAX_COMPILATION_NESTING_DEPTH) {
      inputLimitExceeded(
        `Compilation input exceeds the nesting-depth limit of ${MAX_COMPILATION_NESTING_DEPTH}`,
      );
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_COMPILATION_COLLECTION_ITEMS) {
        inputLimitExceeded(
          `Compilation input collection has ${value.length} entries; the limit is ${MAX_COMPILATION_COLLECTION_ITEMS}`,
        );
      }
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalidRuntimeInput(
          'Compilation input must contain only plain data arrays',
        );
      }
      for (const key of Reflect.ownKeys(value)) {
        if (
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
        ) {
          invalidRuntimeInput(
            'Compilation input arrays must not contain custom properties',
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          invalidRuntimeInput(
            'Compilation input arrays must contain only data properties',
          );
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        budget.scheduledNodes += 1;
        if (budget.scheduledNodes > MAX_COMPILATION_VALUE_NODES) {
          inputLimitExceeded(
            `Compilation input exceeds the ${MAX_COMPILATION_VALUE_NODES}-value limit`,
          );
        }
        pending.push({
          value: requireCompilationArrayItem(
            value,
            index,
            'Compilation input collection',
          ),
          depth: depth + 1,
          exiting: false,
        });
      }
      continue;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidRuntimeInput(
        'Compilation input must contain only plain data objects',
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_COMPILATION_OBJECT_PROPERTIES) {
      inputLimitExceeded(
        `Compilation input object has more than ${MAX_COMPILATION_OBJECT_PROPERTIES} properties`,
      );
    }
    for (const key of keys) {
      if (typeof key !== 'string') {
        invalidRuntimeInput(
          'Compilation input must not contain symbol properties',
        );
      }
      const textKey = key as string;
      const keyBytes = Buffer.byteLength(textKey, 'utf8');
      if (keyBytes > MAX_COMPILATION_ARTIFACT_BYTES) {
        inputLimitExceeded(
          `Compilation input contains a property name larger than ${MAX_COMPILATION_ARTIFACT_BYTES} bytes`,
        );
      }
      budget.stringBytes += keyBytes;
      if (budget.stringBytes > MAX_COMPILATION_TOTAL_STRING_BYTES) {
        inputLimitExceeded(
          `Compilation input exceeds the ${MAX_COMPILATION_TOTAL_STRING_BYTES}-byte aggregate string limit`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, textKey);
      if (descriptor === undefined || !('value' in descriptor)) {
        invalidRuntimeInput(
          'Compilation input must not contain accessor properties',
        );
      }
      budget.scheduledNodes += 1;
      if (budget.scheduledNodes > MAX_COMPILATION_VALUE_NODES) {
        inputLimitExceeded(
          `Compilation input exceeds the ${MAX_COMPILATION_VALUE_NODES}-value limit`,
        );
      }
      pending.push({
        value: (descriptor as PropertyDescriptor & { value: unknown }).value,
        depth: depth + 1,
        exiting: false,
      });
    }
  }
};

const boundedString = (
  value: unknown,
  label: string,
  maximumBytes: number,
): string => {
  if (typeof value !== 'string') {
    invalidRuntimeInput(`${label} must be a string`);
  }
  const text = value as string;
  if (
    text.length > maximumBytes ||
    Buffer.byteLength(text, 'utf8') > maximumBytes
  ) {
    inputLimitExceeded(`${label} exceeds the ${maximumBytes}-byte limit`);
  }
  return text;
};

const boundedInstructionText = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    invalidRuntimeInput(`${label} must be a string`);
  }
  const text = value as string;
  if (
    text.length > MAX_INSTRUCTION_TEXT_BYTES ||
    Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_TEXT_BYTES
  ) {
    throw new InstructionCompilationError(
      'output_too_large',
      `${label} exceeds the ${MAX_INSTRUCTION_TEXT_BYTES}-byte instruction-text limit`,
    );
  }
  return text;
};

const formatValidationIssues = (issues: readonly ValidationIssue[]): string => {
  const details: string[] = [];
  const count = Math.min(issues.length, MAX_REPORTED_ISSUES);
  for (let index = 0; index < count; index += 1) {
    const issue = issues[index];
    if (issue !== undefined) {
      details.push(`${issue.path}: ${issue.message} [${issue.code}]`);
    }
  }
  if (issues.length > count) {
    details.push(`${issues.length - count} additional issue(s) omitted`);
  }
  return details.join('; ');
};

const formatRegistryIssues = (issues: readonly RegistryIssue[]): string => {
  const details: string[] = [];
  const count = Math.min(issues.length, MAX_REPORTED_ISSUES);
  for (let index = 0; index < count; index += 1) {
    const issue = issues[index];
    if (issue !== undefined) {
      details.push(
        `${issue.origin}${issue.path}: ${issue.message} [${issue.code}]`,
      );
    }
  }
  if (issues.length > count) {
    details.push(`${issues.length - count} additional issue(s) omitted`);
  }
  return details.join('; ');
};

const validatedEffectiveDate = (
  value: unknown,
): {
  readonly effectiveOn: string;
  readonly now: Date;
} => {
  if (typeof value !== 'string' || value.length !== 10) {
    throw new InstructionCompilationError(
      'invalid_effective_date',
      'effectiveOn must be a real UTC calendar date in YYYY-MM-DD form',
    );
  }
  const parsed = IsoDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new InstructionCompilationError(
      'invalid_effective_date',
      'effectiveOn must be a real UTC calendar date in YYYY-MM-DD form',
    );
  }
  return {
    effectiveOn: parsed.data,
    now: new Date(`${parsed.data}T00:00:00.000Z`),
  };
};

const validatedSelectionId = (value: unknown, label: string): string => {
  const bounded = boundedString(value, label, MAX_INSTRUCTION_TEXT_BYTES);
  const parsed = ArtifactIdSchema.safeParse(bounded);
  if (!parsed.success) {
    throw new InstructionCompilationError(
      'invalid_artifact',
      `${label} must be a valid artifact ID`,
    );
  }
  return parsed.data;
};

const validatedRegistry = (input: unknown, now: Date): ArtifactRegistry => {
  const registryRecord = requireCompilationRecord(input, 'registry');
  const rawEntries = requireCompilationField(
    registryRecord,
    'entries',
    'registry',
  );
  if (!Array.isArray(rawEntries)) {
    invalidRuntimeInput('registry.entries must be an array');
  }
  const registryEntries = rawEntries as unknown[];
  if (registryEntries.length > MAX_COMPILATION_REGISTRY_ENTRIES) {
    inputLimitExceeded(
      `Registry has ${registryEntries.length} entries; the limit is ${MAX_COMPILATION_REGISTRY_ENTRIES}`,
    );
  }

  const budget: CompilationInputBudget = {
    scheduledNodes: 0,
    stringBytes: 0,
  };
  assertCompilationInputBounds(rawEntries, budget);
  const entries: LocatedArtifact[] = [];
  for (let index = 0; index < registryEntries.length; index += 1) {
    const rawEntry = requireCompilationArrayItem(
      registryEntries,
      index,
      'registry.entries',
    );
    const entryRecord = requireCompilationRecord(
      rawEntry,
      `registry.entries[${index}]`,
    );
    const origin = boundedString(
      requireCompilationField(
        entryRecord,
        'origin',
        `registry.entries[${index}]`,
      ),
      `registry.entries[${index}].origin`,
      MAX_ORIGIN_BYTES,
    );
    const rawArtifact = requireCompilationField(
      entryRecord,
      'artifact',
      `registry.entries[${index}]`,
    );
    const result = validateArtifact(rawArtifact, { now });
    if (!result.success) {
      const expired = result.issues.some(
        (issue) => issue.code === 'expired_exception',
      );
      const unsupportedReviewLevel = result.issues.some(
        (issue) => issue.path === '$.review_policy.default_level',
      );
      throw new InstructionCompilationError(
        expired
          ? 'expired_exception'
          : unsupportedReviewLevel
            ? 'unsupported_review_level'
            : 'invalid_artifact',
        `Artifact at registry entry ${index} is invalid: ${formatValidationIssues(result.issues)}`,
      );
    }
    entries.push({ origin, artifact: result.artifact });
  }

  const result = createArtifactRegistry(entries);
  if (!result.success) {
    const ambiguous = result.issues.some(
      (issue) =>
        issue.code === 'duplicate_artifact_id' ||
        issue.code === 'ambiguous_artifact_reference',
    );
    throw new InstructionCompilationError(
      ambiguous ? 'ambiguous_artifact' : 'invalid_registry',
      `Artifact registry is invalid: ${formatRegistryIssues(result.issues)}`,
    );
  }
  return result.registry;
};

const uniqueArtifactById = (
  entries: readonly LocatedArtifact[],
  id: string,
): LocatedArtifact => {
  const matches = entries.filter((entry) => entry.artifact.id === id);
  if (matches.length === 0) {
    throw new InstructionCompilationError(
      'missing_artifact',
      `Artifact ${id} was not found in the registry`,
    );
  }
  if (matches.length > 1) {
    throw new InstructionCompilationError(
      'ambiguous_artifact',
      `Artifact ${id} is ambiguous in the registry`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new InstructionCompilationError(
      'missing_artifact',
      `Artifact ${id} was not found in the registry`,
    );
  }
  return match;
};

const expectArtifactKind = <Kind extends CraftArtifact['kind']>(
  entry: LocatedArtifact,
  kind: Kind,
): Extract<CraftArtifact, { readonly kind: Kind }> => {
  if (entry.artifact.kind !== kind) {
    throw new InstructionCompilationError(
      'artifact_kind_mismatch',
      `Artifact ${entry.artifact.id} has kind ${entry.artifact.kind}; expected ${kind}`,
    );
  }
  return entry.artifact as Extract<CraftArtifact, { readonly kind: Kind }>;
};

const directiveAuthority = (
  rule: ProjectRule,
): AgentDirectiveAuthority | undefined => {
  if (rule.status !== 'active') {
    return undefined;
  }
  switch (rule.level) {
    case 'mandatory':
      return 'must';
    case 'recommended':
      return 'should';
    case 'contextual':
      return 'conditional';
    case 'aspirational':
      return 'aspirational';
    case 'not_applicable':
    case 'requires_decision':
      return undefined;
  }
};

const copyScope = (rule: ProjectRule): AgentInstructionScope => ({
  changeTypes: sortedText(
    rule.scope.change_types,
    `Rule ${rule.id} scope change types`,
  ),
  include: sortedText(rule.scope.include, `Rule ${rule.id} scope includes`),
  exclude: sortedText(rule.scope.exclude, `Rule ${rule.id} scope excludes`),
  existingViolations: rule.scope.existing_violations,
});

const toDirective = (
  rule: ProjectRule,
  authority: AgentDirectiveAuthority,
): AgentRuleDirective => ({
  ruleId: rule.id,
  authority,
  statement: boundedInstructionText(
    rule.statement,
    `Rule ${rule.id} statement`,
  ),
  scope: copyScope(rule),
});

const collectActiveExceptions = (
  rules: readonly ProjectRule[],
  profile: Extract<CraftArtifact, { readonly kind: 'assurance_profile' }>,
  effectiveOn: string,
): readonly AgentInstructionException[] => {
  const exceptions: AgentInstructionException[] = [];
  const append = (
    sourceArtifactId: string,
    exception: {
      readonly id: string;
      readonly owner: string;
      readonly scope: string;
      readonly applies_to?:
        | {
            readonly artifact_refs: readonly string[];
            readonly mutation_ids: readonly string[];
          }
        | undefined;
      readonly expires_on: string;
    },
  ): void => {
    if (exception.expires_on < effectiveOn) {
      throw new InstructionCompilationError(
        'expired_exception',
        `Exception ${exception.id} from ${sourceArtifactId} expired on ${exception.expires_on}`,
      );
    }
    if (exceptions.length >= MAX_INSTRUCTION_COLLECTION_ITEMS) {
      throw new InstructionCompilationError(
        'input_limit_exceeded',
        `Active exceptions exceed the ${MAX_INSTRUCTION_COLLECTION_ITEMS}-entry limit`,
      );
    }
    boundedInstructionText(exception.owner, `Exception ${exception.id} owner`);
    boundedInstructionText(exception.scope, `Exception ${exception.id} scope`);
    exceptions.push({
      exceptionId: exception.id,
      sourceArtifactId,
      owner: exception.owner,
      scope: exception.scope,
      ...(exception.applies_to === undefined
        ? {}
        : {
            appliesTo: {
              artifactRefs: sortedText(
                exception.applies_to.artifact_refs,
                `Exception ${exception.id} artifact selectors`,
              ),
              mutationIds: sortedText(
                exception.applies_to.mutation_ids,
                `Exception ${exception.id} mutation selectors`,
              ),
            },
          }),
      expiresOn: exception.expires_on,
    });
  };

  for (const rule of rules) {
    if (directiveAuthority(rule) === undefined) {
      continue;
    }
    for (const exception of rule.exceptions.active_exceptions) {
      append(rule.id, exception);
    }
  }
  for (const exception of profile.exception_policy.active_exceptions) {
    append(profile.id, exception);
  }
  return exceptions.sort(compareException);
};

function assertSupportedReviewLevel(level: number): asserts level is 0 | 1 | 2 {
  if (level !== 0 && level !== 1 && level !== 2) {
    throw new InstructionCompilationError(
      'unsupported_review_level',
      `Unsupported human review level ${level}; supported levels are 0, 1, and 2`,
    );
  }
}

/**
 * Revalidates registry artifacts for one explicit date, then compiles a
 * deterministic instruction model.
 *
 * The function performs no I/O, does not mutate the registry, and never copies
 * untrusted observation, evidence, provider, enforcement, origin, or timestamp
 * fields into the model.
 */
export const compileAgentInstructions = (
  request: CompileAgentInstructionsRequest,
): AgentInstructionModel => {
  const runtimeRequest = requireCompilationRecord(
    request,
    'Compilation request',
  );
  const { effectiveOn, now } = validatedEffectiveDate(
    Object.hasOwn(runtimeRequest, 'effectiveOn')
      ? requireCompilationField(
          runtimeRequest,
          'effectiveOn',
          'Compilation request',
        )
      : undefined,
  );
  const projectId = validatedSelectionId(
    requireCompilationField(runtimeRequest, 'projectId', 'Compilation request'),
    'projectId',
  );
  const assuranceProfileId = validatedSelectionId(
    requireCompilationField(
      runtimeRequest,
      'assuranceProfileId',
      'Compilation request',
    ),
    'assuranceProfileId',
  );
  const registry = validatedRegistry(
    requireCompilationField(runtimeRequest, 'registry', 'Compilation request'),
    now,
  );

  const project = expectArtifactKind(
    uniqueArtifactById(registry.entries, projectId),
    'project_profile',
  );
  const assurance = expectArtifactKind(
    uniqueArtifactById(registry.entries, assuranceProfileId),
    'assurance_profile',
  );
  if (assurance.project_ref !== project.id) {
    throw new InstructionCompilationError(
      'assurance_profile_project_mismatch',
      `Assurance profile ${assurance.id} belongs to ${assurance.project_ref}, not ${project.id}`,
    );
  }
  assertSupportedReviewLevel(assurance.review_policy.default_level);

  const projectRules: ProjectRule[] = [];
  for (const entry of registry.entries) {
    if (
      entry.artifact.kind !== 'project_rule' ||
      entry.artifact.project_ref !== project.id
    ) {
      continue;
    }
    if (projectRules.length >= MAX_PROJECT_RULES) {
      throw new InstructionCompilationError(
        'rule_limit_exceeded',
        `Project ${project.id} has more than ${MAX_PROJECT_RULES} rules`,
      );
    }
    projectRules.push(entry.artifact);
  }
  projectRules.sort((left, right) => compareText(left.id, right.id));
  const duplicateRuleId = projectRules.find(
    (rule, index) =>
      projectRules.findIndex((candidate) => candidate.id === rule.id) !== index,
  );
  if (duplicateRuleId !== undefined) {
    throw new InstructionCompilationError(
      'ambiguous_artifact',
      `Project rule ${duplicateRuleId.id} is ambiguous in the registry`,
    );
  }

  const directives = projectRules.flatMap((rule) => {
    const authority = directiveAuthority(rule);
    return authority === undefined ? [] : [toDirective(rule, authority)];
  });
  const sourceRuleIds = projectRules.map((rule) => rule.id);
  const sourceArtifactIds = sortedText(
    [project.id, assurance.id, ...sourceRuleIds],
    'Source artifact IDs',
  );

  const decisionRules: AgentDecisionRequiredRule[] = [];
  for (const rule of projectRules) {
    if (rule.status !== 'retired' && rule.level === 'requires_decision') {
      decisionRules.push({
        ruleId: rule.id,
        scope: copyScope(rule),
      });
    }
  }

  return {
    compilerId: AGENT_INSTRUCTION_COMPILER_ID,
    formatVersion: AGENT_INSTRUCTION_FORMAT_VERSION,
    effectiveOn,
    projectId: project.id,
    sourceArtifactIds,
    sourceRuleIds,
    assurance: {
      profileId: assurance.id,
      maximumHumanReviewLevel: assurance.review_policy.default_level,
      supportedHumanReviewLevels: [0, 1, 2],
      review: {
        alwaysReview: sortedText(
          assurance.review_policy.always_review,
          'Always-review guidance',
        ),
        selectiveReview: sortedText(
          assurance.review_policy.selective_review,
          'Selective-review guidance',
        ),
        alwaysReviewConcerns: sortedText(
          assurance.review_policy.always_review_concerns ?? [],
          'Always-review concerns',
        ),
        selectiveReviewConcerns: sortedText(
          assurance.review_policy.selective_review_concerns ?? [],
          'Selective-review concerns',
        ),
      },
      testing: {
        unitTestsRequired: assurance.testing_policy.unit_tests_required,
        acceptanceExpectations: sortedText(
          assurance.testing_policy.acceptance_tests_required_for,
          'Acceptance-test expectations',
        ),
        integrationExpectations: sortedText(
          assurance.testing_policy.integration_tests_required_for,
          'Integration-test expectations',
        ),
        acceptanceConcerns: sortedText(
          assurance.testing_policy.acceptance_concerns ?? [],
          'Acceptance-test concerns',
        ),
        integrationConcerns: sortedText(
          assurance.testing_policy.integration_concerns ?? [],
          'Integration-test concerns',
        ),
      },
      architecture: {
        checksRequired: assurance.architecture_policy.checks_required,
        baselineExistingViolations:
          assurance.architecture_policy.baseline_existing_violations,
        failOnNewViolations:
          assurance.architecture_policy.fail_on_new_violations,
      },
      security: {
        dependencyScanningRequired:
          assurance.security_policy.dependency_scanning_required,
        humanReviewExpectations: sortedText(
          assurance.security_policy.human_review_required_for,
          'Security human-review expectations',
        ),
        humanReviewConcerns: sortedText(
          assurance.security_policy.human_review_concerns ?? [],
          'Security human-review concerns',
        ),
      },
      mutation: {
        forbidNewUnexplainedSurvivors: true,
        existingSurvivors:
          assurance.mutation_policy.baseline.existing_survivors,
        forbidBaselineRegression: true,
        reportScore: assurance.mutation_policy.score?.report ?? false,
        scoreDecisionRole: 'context_only',
      },
    },
    directives: {
      must: directives
        .filter((directive) => directive.authority === 'must')
        .sort(compareDirective),
      should: directives
        .filter((directive) => directive.authority === 'should')
        .sort(compareDirective),
      conditional: directives
        .filter((directive) => directive.authority === 'conditional')
        .sort(compareDirective),
      aspirational: directives
        .filter((directive) => directive.authority === 'aspirational')
        .sort(compareDirective),
    },
    activeExceptions: collectActiveExceptions(
      projectRules,
      assurance,
      effectiveOn,
    ),
    pending: {
      candidateRuleIds: sortedText(
        projectRules
          .filter(
            (rule) =>
              rule.status === 'candidate' && rule.level !== 'requires_decision',
          )
          .map((rule) => rule.id),
        'Candidate rule IDs',
      ),
      decisionRules: decisionRules.sort(compareDecisionRule),
    },
  };
};
