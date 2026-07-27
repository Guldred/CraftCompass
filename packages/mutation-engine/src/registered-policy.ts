import {
  createArtifactRegistry,
  findRegistryArtifact,
  validateArtifact,
  type ArtifactRegistry,
  type LocatedArtifact,
} from '@craftcompass/domain';

import {
  readRequestEnvelope,
  validateArtifactIdInput,
} from './input-validation.js';
import {
  evaluateMutationPolicy as evaluateMutationPolicyCore,
  type MutationPolicyEvaluation,
  type MutationPolicyReasonCode,
} from './policy.js';

const MAX_EVALUATION_REGISTRY_ENTRIES = 1_000;
const MAX_EVALUATION_ORIGIN_LENGTH = 4_096;

/** Registry-backed inputs required for a provenance-complete policy decision. */
export interface EvaluateMutationPolicyRequest {
  readonly registry: ArtifactRegistry;
  readonly reportId: string;
  readonly baselineId?: string;
  readonly profileId: string;
  readonly now: Date;
}

const inconclusive = (
  reportId: string,
  baselineId: string | undefined,
  code: MutationPolicyReasonCode,
): MutationPolicyEvaluation => ({
  status: 'inconclusive',
  reportId,
  ...(baselineId === undefined ? {} : { baselineId }),
  reasons: [{ code, mutationIds: [] }],
  affectedMutationIds: [],
});

const readPlainArray = (
  input: unknown,
  maximumItems: number,
): readonly unknown[] | undefined => {
  try {
    if (
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > maximumItems
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' &&
            (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= input.length)),
      )
    ) {
      return undefined;
    }
    const values: unknown[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        return undefined;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
};

const cloneDate = (input: unknown): Date | undefined => {
  if (!(input instanceof Date)) {
    return undefined;
  }
  try {
    const timestamp = Date.prototype.getTime.call(input);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  } catch {
    return undefined;
  }
};

const parseId = (input: unknown): string | undefined => {
  const result = validateArtifactIdInput(input);
  return result.success ? result.data : undefined;
};

const rebuildRegistry = (
  input: unknown,
  now: Date,
): ArtifactRegistry | undefined => {
  const registryEnvelope = readRequestEnvelope(input, ['entries'], ['entries']);
  if (!registryEnvelope.success) {
    return undefined;
  }
  const rawEntries = readPlainArray(
    registryEnvelope.data['entries'],
    MAX_EVALUATION_REGISTRY_ENTRIES,
  );
  if (rawEntries === undefined || rawEntries.length === 0) {
    return undefined;
  }
  const entries: LocatedArtifact[] = [];
  for (const rawEntry of rawEntries) {
    const entryEnvelope = readRequestEnvelope(
      rawEntry,
      ['origin', 'artifact'],
      ['origin', 'artifact'],
    );
    if (!entryEnvelope.success) {
      return undefined;
    }
    const origin = entryEnvelope.data['origin'];
    if (
      typeof origin !== 'string' ||
      origin.length === 0 ||
      origin.length > MAX_EVALUATION_ORIGIN_LENGTH
    ) {
      return undefined;
    }
    const artifact = validateArtifact(entryEnvelope.data['artifact'], {
      now,
      preserveExpiredExceptions: true,
    });
    if (!artifact.success) {
      return undefined;
    }
    entries.push({ origin, artifact: artifact.artifact });
  }
  const registry = createArtifactRegistry(entries);
  return registry.success ? registry.registry : undefined;
};

/**
 * Evaluates mutation policy only after rebuilding a complete, typed registry.
 *
 * The lower-level comparator remains package-internal; callers cannot obtain a
 * passing root-package decision from disconnected report/baseline objects.
 */
export const evaluateMutationPolicy = (
  request: EvaluateMutationPolicyRequest,
): MutationPolicyEvaluation => {
  const envelope = readRequestEnvelope(
    request,
    ['registry', 'reportId', 'baselineId', 'profileId', 'now'],
    ['registry', 'reportId', 'profileId', 'now'],
  );
  if (!envelope.success) {
    return inconclusive(
      'INVALID-REPORT',
      undefined,
      'invalid_evaluation_request',
    );
  }
  const parsedReportId = parseId(envelope.data['reportId']);
  const reportId = parsedReportId ?? 'INVALID-REPORT';
  const rawBaselineId = envelope.data['baselineId'];
  const baselineId =
    rawBaselineId === undefined ? undefined : parseId(rawBaselineId);
  const profileId = parseId(envelope.data['profileId']);
  const now = cloneDate(envelope.data['now']);
  if (
    parsedReportId === undefined ||
    (rawBaselineId !== undefined && baselineId === undefined) ||
    profileId === undefined
  ) {
    return inconclusive(reportId, baselineId, 'invalid_evaluation_selection');
  }
  if (now === undefined) {
    return inconclusive(reportId, baselineId, 'invalid_evaluation_time');
  }
  const registry = rebuildRegistry(envelope.data['registry'], now);
  if (registry === undefined) {
    return inconclusive(reportId, baselineId, 'invalid_evaluation_registry');
  }
  const report = findRegistryArtifact(registry, reportId)?.artifact;
  const profile = findRegistryArtifact(registry, profileId)?.artifact;
  const baseline =
    baselineId === undefined
      ? undefined
      : findRegistryArtifact(registry, baselineId)?.artifact;
  if (
    report?.kind !== 'mutation_report' ||
    profile?.kind !== 'assurance_profile' ||
    (baselineId !== undefined && baseline?.kind !== 'mutation_baseline')
  ) {
    return inconclusive(reportId, baselineId, 'invalid_evaluation_selection');
  }
  return evaluateMutationPolicyCore({
    report,
    ...(baseline?.kind === 'mutation_baseline' ? { baseline } : {}),
    profile,
    now,
  });
};
