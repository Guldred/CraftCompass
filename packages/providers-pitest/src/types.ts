/** Provider-neutral status retained from a completed PIT mutation result. */
export type PitMutationOutcome =
  | 'killed'
  | 'survived'
  | 'no_coverage'
  | 'timed_out'
  | 'non_viable'
  | 'memory_error'
  | 'run_error'
  | 'equivalent_candidate';

/** Follow-up category required for a result PIT did not kill with a test. */
export type PitMutationActionCategory =
  | 'investigate_survivor'
  | 'add_test_coverage'
  | 'investigate_timeout'
  | 'investigate_non_viable_mutation'
  | 'investigate_memory_error'
  | 'investigate_run_error'
  | 'review_equivalent_candidate';

/** Explicit follow-up retained for every non-killed PIT outcome. */
export interface PitMutationAction {
  readonly required: true;
  readonly category: PitMutationActionCategory;
  readonly reason: string;
}

/**
 * PIT 1.25+ may report EQUIVALENT, but a tool assertion is not a human
 * classification decision.
 */
export interface PitEquivalentCandidate {
  readonly value: 'equivalent';
  readonly status: 'candidate';
  readonly authoritative: false;
  readonly asserted_by: 'pitest';
}

/** Test information emitted either in compact or full-matrix PIT XML mode. */
export interface PitTestMatrix {
  readonly mode: 'summary' | 'full';
  readonly killing_tests: readonly string[];
  readonly succeeding_tests: readonly string[];
  readonly covering_tests: readonly string[];
}

interface PitMutationBase {
  /** Stable semantic identity, independent of result ordering and descriptions. */
  readonly id: string;
  readonly pit_status:
    | 'KILLED'
    | 'SURVIVED'
    | 'NO_COVERAGE'
    | 'TIMED_OUT'
    | 'NON_VIABLE'
    | 'MEMORY_ERROR'
    | 'RUN_ERROR'
    | 'EQUIVALENT';
  readonly detected: boolean;
  readonly tests_run: number;
  /** Provider-reported source label; not necessarily a repository path. */
  readonly source_file: string;
  readonly mutated_class: string;
  readonly mutated_method: string;
  readonly method_descriptor: string;
  readonly line: number;
  readonly mutator: string;
  readonly indexes: readonly number[];
  readonly blocks: readonly number[];
  readonly description: string;
  readonly tests: PitTestMatrix;
}

/** A mutation actually distinguished by a test. */
export interface PitKilledMutation extends PitMutationBase {
  readonly outcome: 'killed';
  readonly action: null;
  readonly equivalent_classification: null;
}

/** A mutation result that still requires an explicit engineering response. */
export interface PitActionableMutation extends PitMutationBase {
  readonly outcome: Exclude<PitMutationOutcome, 'killed'>;
  readonly action: PitMutationAction;
  readonly equivalent_classification: PitEquivalentCandidate | null;
}

/** One normalized record from a PIT XML report. */
export type PitMutation = PitKilledMutation | PitActionableMutation;

/** Lossless outcome counts for one normalized PIT run. */
export interface PitMutationTotals {
  readonly generated: number;
  readonly killed: number;
  readonly survived: number;
  readonly no_coverage: number;
  readonly timed_out: number;
  readonly non_viable: number;
  readonly memory_error: number;
  readonly run_error: number;
  readonly equivalent_candidates: number;
  readonly actionable: number;
}

/** Strict, deterministic normalized output of a PIT mutations.xml document. */
export interface PitMutationRun {
  /** Stable identity of the semantic results, independent of origin and order. */
  readonly id: string;
  readonly provider: 'pitest';
  readonly format: 'pitest-xml';
  /** Caller-provided, repository-relative logical location of the input. */
  readonly origin: string;
  /** Whether PIT declared this report to contain partial coverage. */
  readonly partial: boolean;
  readonly totals: PitMutationTotals;
  /** Sorted by stable semantic identity. */
  readonly mutations: readonly PitMutation[];
}
