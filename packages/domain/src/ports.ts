import type { EvidenceReference } from './common.js';
import type { ChangeContext, CodeGraphImpactData } from './change.js';
import type {
  MutationClassification,
  MutationPolicy,
  MutationReport,
  MutationScope,
  SurvivingMutant,
} from './assurance.js';
import type { ProjectObservation, ProjectProfile } from './project.js';

/** Provider-neutral summary produced by a code-relationship implementation. */
export interface CodeGraphSummary {
  readonly observations: readonly ProjectObservation[];
  readonly confidence: number;
  readonly limitations: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

/** Expected graph-query outcomes; unavailability is data, not a false empty result. */
export type CodeGraphChangeResult =
  | {
      readonly status: 'available' | 'degraded';
      readonly impact: CodeGraphImpactData;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      readonly evidence: readonly EvidenceReference[];
    };

/** Substitution boundary for future GitNexus or other graph implementations. */
export interface CodeGraphProvider {
  readonly id: string;
  /** Synthetic providers can exercise workflows but cannot authorize decisions. */
  readonly evidenceKind: 'observed' | 'synthetic';

  analyzeProject(profile: ProjectProfile): Promise<CodeGraphSummary>;

  analyzeChange(
    profile: ProjectProfile,
    change: ChangeContext,
  ): Promise<CodeGraphChangeResult>;
}

/** Input accepted by any future mutation-testing provider. */
export interface MutationExecutionRequest {
  readonly project: ProjectProfile;
  readonly scope: MutationScope;
  readonly policy: MutationPolicy;
}

/** A provider's non-authoritative classification suggestion. */
export interface MutationClassificationCandidate {
  readonly classification: MutationClassification;
  readonly confidence: number;
  readonly rationale: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

/** Substitution boundary for future PIT, Stryker, or other mutation tools. */
export interface MutationTestingProvider {
  readonly id: string;

  supports(project: ProjectProfile): Promise<boolean>;

  run(request: MutationExecutionRequest): Promise<MutationReport>;

  classifyCandidate(
    survivor: SurvivingMutant,
  ): Promise<MutationClassificationCandidate>;
}
