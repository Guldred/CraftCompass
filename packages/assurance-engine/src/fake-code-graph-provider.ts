import {
  CodeGraphImpactDataSchema,
  EvidenceReferenceListSchema,
  NonEmptyStringSchema,
  type CodeGraphChangeResult,
  type CodeGraphImpactData,
  type CodeGraphProvider,
  type CodeGraphSummary,
  type EvidenceReference,
} from '@craftcompass/domain';

/**
 * Strict deterministic fixture format. It is intentionally synthetic and can
 * never be configured as observed or decision-eligible evidence.
 */
export type FakeCodeGraphScenario =
  | {
      readonly mode: 'result';
      readonly status: 'available' | 'degraded';
      readonly impact: CodeGraphImpactData;
    }
  | {
      readonly mode: 'unavailable';
      readonly reason: string;
      readonly evidence: readonly EvidenceReference[];
    }
  | {
      readonly mode: 'error';
      readonly message: string;
    };

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const requireExactKeys = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void => {
  const expected = new Set(keys);
  const unexpected = Object.keys(record).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected fake code-graph scenario fields: ${unexpected.sort().join(', ')}`,
    );
  }
};

/** Parses an unknown fixture before it reaches the fake provider. */
export const parseFakeCodeGraphScenario = (
  input: unknown,
): FakeCodeGraphScenario => {
  if (!isRecord(input)) {
    throw new Error('Expected a fake code-graph scenario object');
  }
  switch (input.mode) {
    case 'result': {
      requireExactKeys(input, ['mode', 'status', 'impact']);
      if (input.status !== 'available' && input.status !== 'degraded') {
        throw new Error('Fake result status must be available or degraded');
      }
      return {
        mode: 'result',
        status: input.status,
        impact: CodeGraphImpactDataSchema.parse(input.impact),
      };
    }
    case 'unavailable':
      requireExactKeys(input, ['mode', 'reason', 'evidence']);
      return {
        mode: 'unavailable',
        reason: NonEmptyStringSchema.parse(input.reason),
        evidence: EvidenceReferenceListSchema.min(1).parse(input.evidence),
      };
    case 'error':
      requireExactKeys(input, ['mode', 'message']);
      return {
        mode: 'error',
        message: NonEmptyStringSchema.parse(input.message),
      };
    default:
      throw new Error(
        'Fake code-graph scenario mode must be result, unavailable, or error',
      );
  }
};

/**
 * Deterministic synthetic provider for use in tests and examples.
 *
 * `evidenceKind` is a literal and cannot be overridden by callers.
 */
export class FakeCodeGraphProvider implements CodeGraphProvider {
  readonly id: string;
  readonly evidenceKind = 'synthetic' as const;

  readonly #scenario: FakeCodeGraphScenario;

  constructor(id: string, scenario: FakeCodeGraphScenario) {
    this.id = NonEmptyStringSchema.parse(id);
    this.#scenario = structuredClone(scenario);
  }

  analyzeProject(): Promise<CodeGraphSummary> {
    const evidence =
      this.#scenario.mode === 'result'
        ? this.#scenario.impact.evidence
        : this.#scenario.mode === 'unavailable'
          ? this.#scenario.evidence
          : [];
    return Promise.resolve({
      observations: [],
      confidence:
        this.#scenario.mode === 'result' ? this.#scenario.impact.confidence : 0,
      limitations: [
        'Synthetic code-graph provider output is not decision evidence.',
      ],
      evidence: structuredClone(evidence),
    });
  }

  analyzeChange(): Promise<CodeGraphChangeResult> {
    switch (this.#scenario.mode) {
      case 'result':
        return Promise.resolve({
          status: this.#scenario.status,
          impact: structuredClone(this.#scenario.impact),
        });
      case 'unavailable':
        return Promise.resolve({
          status: 'unavailable',
          reason: this.#scenario.reason,
          evidence: structuredClone(this.#scenario.evidence),
        });
      case 'error':
        return Promise.reject(new Error(this.#scenario.message));
    }
  }
}
