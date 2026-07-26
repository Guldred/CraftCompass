import {
  ChangeImpactSchema,
  CodeGraphImpactDataSchema,
  type ChangeContext,
  type ChangeImpact,
  type CodeGraphImpactData,
  type CodeGraphProvider,
  type CodeSymbol,
  type EvidenceReference,
  type ProjectProfile,
} from '@craftcompass/domain';

/** Fallback evidence is deliberately capped below reliable graph confidence. */
export const DIFF_FALLBACK_CONFIDENCE_CAP = 0.5;

export type ImpactAnalysisIssueCode =
  | 'conflicting_evidence'
  | 'invalid_provider_result'
  | 'no_changed_production_symbols'
  | 'project_reference_mismatch'
  | 'provider_error'
  | 'provider_unavailable';

/** One stable, actionable failure to produce a trustworthy impact artifact. */
export interface ImpactAnalysisIssue {
  readonly code: ImpactAnalysisIssueCode;
  readonly path: string;
  readonly message: string;
}

/** Result of normalizing graph evidence or a conservative diff fallback. */
export type ImpactAnalysisResult =
  | {
      readonly success: true;
      readonly impact: ChangeImpact;
    }
  | {
      readonly success: false;
      readonly issues: readonly ImpactAnalysisIssue[];
    };

export interface AnalyzeChangeImpactInput {
  readonly id: string;
  readonly project: ProjectProfile;
  readonly change: ChangeContext;
  readonly provider: CodeGraphProvider;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const uniqueSortedStrings = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

const stableSerialize = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const mergeEvidence = (
  groups: readonly (readonly EvidenceReference[])[],
):
  | { readonly evidence: EvidenceReference[] }
  | { readonly conflict: string } => {
  const byId = new Map<string, EvidenceReference>();
  for (const evidence of groups.flat()) {
    const existing = byId.get(evidence.id);
    if (
      existing !== undefined &&
      stableSerialize(existing) !== stableSerialize(evidence)
    ) {
      return { conflict: evidence.id };
    }
    byId.set(evidence.id, evidence);
  }
  return {
    evidence: [...byId.values()].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
};

const normalizeSymbols = (symbols: readonly CodeSymbol[]): CodeSymbol[] => {
  const byName = new Map<string, CodeSymbol>();
  symbols.forEach((symbol) => {
    byName.set(symbol.qualified_name, {
      ...symbol,
      evidence: [...symbol.evidence].sort((left, right) =>
        compareText(left.id, right.id),
      ),
    });
  });
  return [...byName.values()].sort((left, right) =>
    compareText(left.qualified_name, right.qualified_name),
  );
};

const normalizeSymbol = (symbol: CodeSymbol): CodeSymbol => ({
  ...symbol,
  evidence: [...symbol.evidence].sort((left, right) =>
    compareText(left.id, right.id),
  ),
});

const normalizeProviderData = (
  change: ChangeContext,
  data: CodeGraphImpactData,
): CodeGraphImpactData => {
  const changedSymbols = normalizeSymbols([
    ...data.changed_symbols,
    // The caller's normalized change context owns changed-symbol identity.
    ...change.changed_symbols,
  ]);
  const changedNames = new Set(
    changedSymbols.map((symbol) => symbol.qualified_name),
  );
  const directByName = new Map(
    data.direct_impacts
      .filter((impact) => !changedNames.has(impact.symbol.qualified_name))
      .map((impact) => [impact.symbol.qualified_name, impact]),
  );
  const indirect = data.indirect_impacts.filter(
    (impact) =>
      !changedNames.has(impact.symbol.qualified_name) &&
      !directByName.has(impact.symbol.qualified_name),
  );
  return {
    ...data,
    changed_symbols: changedSymbols,
    direct_impacts: [...directByName.values()]
      .map((impact) => ({
        ...impact,
        symbol: normalizeSymbol(impact.symbol),
        relationships: uniqueSortedStrings(impact.relationships),
      }))
      .sort((left, right) =>
        compareText(left.symbol.qualified_name, right.symbol.qualified_name),
      ),
    indirect_impacts: [...indirect]
      .map((impact) => ({
        ...impact,
        symbol: normalizeSymbol(impact.symbol),
        relationships: uniqueSortedStrings(impact.relationships),
      }))
      .sort((left, right) =>
        compareText(left.symbol.qualified_name, right.symbol.qualified_name),
      ),
    impacted_flows: [...data.impacted_flows]
      .map((flow) => ({
        ...flow,
        symbol_refs: uniqueSortedStrings(flow.symbol_refs),
        evidence: [...flow.evidence].sort((left, right) =>
          compareText(left.id, right.id),
        ),
      }))
      .sort((left, right) => compareText(left.id, right.id)),
    functional_clusters: [...data.functional_clusters]
      .map((cluster) => ({
        ...cluster,
        symbol_refs: uniqueSortedStrings(cluster.symbol_refs),
        signals: uniqueSortedStrings(cluster.signals),
        evidence: [...cluster.evidence].sort((left, right) =>
          compareText(left.id, right.id),
        ),
      }))
      .sort((left, right) => compareText(left.id, right.id)),
    candidate_tests: normalizeSymbols(data.candidate_tests),
    limitations: uniqueSortedStrings(data.limitations),
    evidence: [...data.evidence].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
};

const invalidResult = (
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): ImpactAnalysisResult => ({
  success: false,
  issues: issues.map((issue) => ({
    code: 'invalid_provider_result',
    path:
      issue.path.length === 0 ? '$' : `$.${issue.path.map(String).join('.')}`,
    message: issue.message,
  })),
});

const buildFallback = (
  input: AnalyzeChangeImpactInput,
  reason: string,
  code: 'provider_error' | 'provider_unavailable',
  providerEvidence: readonly EvidenceReference[],
): ImpactAnalysisResult => {
  const productionSymbols = normalizeSymbols(
    input.change.changed_symbols.filter(
      (symbol) => symbol.role === 'production' && symbol.target !== undefined,
    ),
  );
  if (productionSymbols.length === 0) {
    return {
      success: false,
      issues: [
        {
          code: 'no_changed_production_symbols',
          path: '$.changed_symbols',
          message: `${reason}; no changed production symbol with an explicit target is available for fallback`,
        },
        {
          code,
          path: '$.provider',
          message: reason,
        },
      ],
    };
  }

  const mergedEvidence = mergeEvidence([
    input.change.evidence,
    providerEvidence,
  ]);
  if ('conflict' in mergedEvidence) {
    return {
      success: false,
      issues: [
        {
          code: 'conflicting_evidence',
          path: '$.evidence',
          message: `Evidence ${mergedEvidence.conflict} has conflicting definitions`,
        },
      ],
    };
  }

  const confidence = Math.min(
    DIFF_FALLBACK_CONFIDENCE_CAP,
    ...productionSymbols.map((symbol) => symbol.confidence),
  );
  const candidateTests = normalizeSymbols(
    input.change.changed_symbols.filter(
      (symbol) => symbol.role === 'test' && symbol.target !== undefined,
    ),
  );
  const parsed = ChangeImpactSchema.safeParse({
    schema_version: 1,
    kind: 'change_impact',
    id: input.id,
    project_ref: input.project.id,
    change_ref: input.change.id,
    status: 'degraded',
    source: 'diff_fallback',
    completeness: 'unknown',
    provider: {
      id: input.provider.id,
      evidence_kind: input.provider.evidenceKind,
    },
    evidence_use:
      input.provider.evidenceKind === 'synthetic'
        ? 'synthetic_test_only'
        : 'decision',
    changed_symbols: productionSymbols,
    direct_impacts: [],
    indirect_impacts: [],
    impacted_flows: [],
    functional_clusters: [],
    candidate_tests: candidateTests,
    confidence,
    limitations: uniqueSortedStrings([
      reason,
      'Code-graph impact is unavailable; only changed production symbols are in scope.',
    ]),
    evidence: mergedEvidence.evidence,
  });
  return parsed.success
    ? { success: true, impact: parsed.data }
    : invalidResult(parsed.error.issues);
};

/**
 * Calls one graph provider and normalizes its evidence without ever treating an
 * unavailable or failed query as an empty successful impact.
 */
export const analyzeChangeImpact = async (
  input: AnalyzeChangeImpactInput,
): Promise<ImpactAnalysisResult> => {
  if (input.change.project_ref !== input.project.id) {
    return {
      success: false,
      issues: [
        {
          code: 'project_reference_mismatch',
          path: '$.project_ref',
          message: `Change ${input.change.id} references ${input.change.project_ref}, not project ${input.project.id}`,
        },
      ],
    };
  }

  let result;
  try {
    result = await input.provider.analyzeChange(input.project, input.change);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildFallback(
      input,
      `Code-graph provider ${input.provider.id} failed: ${message}`,
      'provider_error',
      [],
    );
  }

  if (result.status === 'unavailable') {
    return buildFallback(
      input,
      `Code-graph provider ${input.provider.id} is unavailable: ${result.reason}`,
      'provider_unavailable',
      result.evidence,
    );
  }

  const parsedProviderData = CodeGraphImpactDataSchema.safeParse(result.impact);
  if (!parsedProviderData.success) {
    return invalidResult(parsedProviderData.error.issues);
  }
  const data = normalizeProviderData(input.change, parsedProviderData.data);
  const mergedEvidence = mergeEvidence([input.change.evidence, data.evidence]);
  if ('conflict' in mergedEvidence) {
    return {
      success: false,
      issues: [
        {
          code: 'conflicting_evidence',
          path: '$.evidence',
          message: `Evidence ${mergedEvidence.conflict} has conflicting definitions`,
        },
      ],
    };
  }
  const limitations =
    result.status === 'degraded' && data.limitations.length === 0
      ? ['The code-graph provider reported degraded impact without details.']
      : data.limitations;
  const parsedImpact = ChangeImpactSchema.safeParse({
    schema_version: 1,
    kind: 'change_impact',
    id: input.id,
    project_ref: input.project.id,
    change_ref: input.change.id,
    status: result.status,
    source: 'code_graph',
    completeness: data.completeness,
    provider: {
      id: input.provider.id,
      evidence_kind: input.provider.evidenceKind,
    },
    evidence_use:
      input.provider.evidenceKind === 'synthetic'
        ? 'synthetic_test_only'
        : 'decision',
    changed_symbols: data.changed_symbols,
    direct_impacts: data.direct_impacts,
    indirect_impacts: data.indirect_impacts,
    impacted_flows: data.impacted_flows,
    functional_clusters: data.functional_clusters,
    candidate_tests: data.candidate_tests,
    confidence: data.confidence,
    limitations,
    evidence: mergedEvidence.evidence,
  });
  return parsedImpact.success
    ? { success: true, impact: parsedImpact.data }
    : invalidResult(parsedImpact.error.issues);
};
