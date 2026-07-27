import type {
  ArtifactRegistry,
  ReviewLevel,
  RuleScope,
} from '@craftcompass/domain';

/** Stable identifier for the generated instruction format. */
export const AGENT_INSTRUCTION_COMPILER_ID =
  'craftcompass-agent-instructions' as const;

/** Version of the deterministic Markdown contract, independent of package versions. */
export const AGENT_INSTRUCTION_FORMAT_VERSION = 1 as const;

/** Defensive upper bound for all project rules considered in one compilation. */
export const MAX_PROJECT_RULES = 256 as const;

/** Defensive upper bound for a rendered instruction document. */
export const MAX_RENDERED_INSTRUCTION_BYTES = 128 * 1024;

/** Defensive upper bound for any one runtime model collection. */
export const MAX_INSTRUCTION_COLLECTION_ITEMS = 1_024 as const;

/** Defensive aggregate item budget for one runtime instruction model. */
export const MAX_INSTRUCTION_MODEL_ITEMS = 8_192 as const;

/** Defensive upper bound for any one runtime model string. */
export const MAX_INSTRUCTION_TEXT_BYTES: number =
  MAX_RENDERED_INSTRUCTION_BYTES;

/** Authority an active project rule receives in generated agent instructions. */
export type AgentDirectiveAuthority =
  'must' | 'should' | 'conditional' | 'aspirational';

/** Scope copied from an active rule without enforcement-provider configuration. */
export interface AgentInstructionScope {
  readonly changeTypes: readonly RuleScope['change_types'][number][];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly existingViolations: RuleScope['existing_violations'];
}

/** One directive derived exclusively from an active project rule. */
export interface AgentRuleDirective {
  readonly ruleId: string;
  readonly authority: AgentDirectiveAuthority;
  readonly statement: string;
  readonly scope: AgentInstructionScope;
}

/** Machine-readable selectors that narrow an exception's applicability. */
export interface AgentExceptionApplicability {
  readonly artifactRefs: readonly string[];
  readonly mutationIds: readonly string[];
}

/** An active, scoped exception whose evidence and provider metadata stay private. */
export interface AgentInstructionException {
  readonly exceptionId: string;
  readonly sourceArtifactId: string;
  readonly owner: string;
  readonly scope: string;
  readonly appliesTo?: AgentExceptionApplicability;
  readonly expiresOn: string;
}

/** Human-review policy copied only from the explicitly selected profile. */
export interface AgentReviewPolicy {
  readonly alwaysReview: readonly string[];
  readonly selectiveReview: readonly string[];
  readonly alwaysReviewConcerns: readonly string[];
  readonly selectiveReviewConcerns: readonly string[];
}

/** Test expectations copied only from the explicitly selected profile. */
export interface AgentTestingPolicy {
  readonly unitTestsRequired: boolean;
  readonly acceptanceExpectations: readonly string[];
  readonly integrationExpectations: readonly string[];
  readonly acceptanceConcerns: readonly string[];
  readonly integrationConcerns: readonly string[];
}

/** Deterministic architecture-policy switches. */
export interface AgentArchitecturePolicy {
  readonly checksRequired: boolean;
  readonly baselineExistingViolations: boolean;
  readonly failOnNewViolations: boolean;
}

/** Security expectations copied only from the explicitly selected profile. */
export interface AgentSecurityPolicy {
  readonly dependencyScanningRequired: boolean;
  readonly humanReviewExpectations: readonly string[];
  readonly humanReviewConcerns: readonly string[];
}

/** Mutation policy whose score is always contextual, never authoritative. */
export interface AgentMutationPolicy {
  readonly forbidNewUnexplainedSurvivors: true;
  readonly existingSurvivors: 'classify_and_track' | 'not_available';
  readonly forbidBaselineRegression: true;
  readonly reportScore: boolean;
  readonly scoreDecisionRole: 'context_only';
}

/** Explicit assurance boundary selected for the same project. */
export interface AgentAssuranceBoundary {
  readonly profileId: string;
  readonly maximumHumanReviewLevel: ReviewLevel;
  readonly supportedHumanReviewLevels: readonly [0, 1, 2];
  readonly review: AgentReviewPolicy;
  readonly testing: AgentTestingPolicy;
  readonly architecture: AgentArchitecturePolicy;
  readonly security: AgentSecurityPolicy;
  readonly mutation: AgentMutationPolicy;
}

/** Sanitized applicability data for a rule that still needs a human decision. */
export interface AgentDecisionRequiredRule {
  readonly ruleId: string;
  readonly scope: AgentInstructionScope;
}

/** Unresolved artifacts that remain informational and never become commands. */
export interface PendingAgentInstructionDecisions {
  readonly candidateRuleIds: readonly string[];
  readonly decisionRules: readonly AgentDecisionRequiredRule[];
}

/**
 * Provider-neutral intermediate form for generated agent instructions.
 *
 * It intentionally has no origin paths, timestamps, observations, evidence
 * descriptions, enforcement configuration, or provider text.
 */
export interface AgentInstructionModel {
  readonly compilerId: typeof AGENT_INSTRUCTION_COMPILER_ID;
  readonly formatVersion: typeof AGENT_INSTRUCTION_FORMAT_VERSION;
  readonly effectiveOn: string;
  readonly projectId: string;
  readonly sourceArtifactIds: readonly string[];
  readonly sourceRuleIds: readonly string[];
  readonly assurance: AgentAssuranceBoundary;
  readonly directives: Readonly<{
    must: readonly AgentRuleDirective[];
    should: readonly AgentRuleDirective[];
    conditional: readonly AgentRuleDirective[];
    aspirational: readonly AgentRuleDirective[];
  }>;
  readonly activeExceptions: readonly AgentInstructionException[];
  readonly pending: PendingAgentInstructionDecisions;
}

/** Inputs required to select project-owned artifacts without guessing. */
export interface CompileAgentInstructionsRequest {
  readonly registry: ArtifactRegistry;
  /** Required UTC calendar date in canonical YYYY-MM-DD form. */
  readonly effectiveOn: string;
  readonly projectId: string;
  readonly assuranceProfileId: string;
}

export type InstructionCompilationErrorCode =
  | 'ambiguous_artifact'
  | 'artifact_kind_mismatch'
  | 'assurance_profile_project_mismatch'
  | 'expired_exception'
  | 'input_limit_exceeded'
  | 'invalid_artifact'
  | 'invalid_effective_date'
  | 'invalid_instruction_model'
  | 'invalid_registry'
  | 'missing_artifact'
  | 'output_too_large'
  | 'rule_limit_exceeded'
  | 'unsupported_review_level';

/** Stable, non-provider-specific compilation failure. */
export class InstructionCompilationError extends Error {
  readonly code: InstructionCompilationErrorCode;

  constructor(code: InstructionCompilationErrorCode, message: string) {
    super(message);
    this.name = 'InstructionCompilationError';
    this.code = code;
  }
}
