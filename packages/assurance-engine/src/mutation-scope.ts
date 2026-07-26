import {
  MutationScopeSchema,
  type ChangeContext,
  type ChangeImpact,
  type MutationScope,
} from '@craftcompass/domain';

export type MutationScopeIssueCode =
  | 'change_reference_mismatch'
  | 'invalid_mutation_scope'
  | 'no_mutation_targets'
  | 'project_reference_mismatch';

export interface MutationScopeIssue {
  readonly code: MutationScopeIssueCode;
  readonly path: string;
  readonly message: string;
}

export type MutationScopeDerivationResult =
  | {
      readonly success: true;
      readonly scope: MutationScope;
    }
  | {
      readonly success: false;
      readonly issues: readonly MutationScopeIssue[];
    };

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

/**
 * Derives provider-neutral mutation targets from explicit changed and impacted
 * symbol targets. It never parses class identity from display names.
 */
export const deriveMutationScope = (
  change: ChangeContext,
  impact: ChangeImpact,
): MutationScopeDerivationResult => {
  const referenceIssues: MutationScopeIssue[] = [];
  if (impact.project_ref !== change.project_ref) {
    referenceIssues.push({
      code: 'project_reference_mismatch',
      path: '$.project_ref',
      message: `Impact ${impact.id} and change ${change.id} reference different projects`,
    });
  }
  if (impact.change_ref !== change.id) {
    referenceIssues.push({
      code: 'change_reference_mismatch',
      path: '$.change_ref',
      message: `Impact ${impact.id} references ${impact.change_ref}, not change ${change.id}`,
    });
  }
  if (referenceIssues.length > 0) {
    return { success: false, issues: referenceIssues };
  }

  const missingTargetLimitations: string[] = [];
  const productionTargets = (
    symbols: readonly {
      readonly qualified_name: string;
      readonly role: string;
      readonly target?: string | undefined;
    }[],
    label: string,
  ): string[] =>
    symbols.flatMap((symbol) => {
      if (symbol.role !== 'production') {
        return [];
      }
      if (symbol.target === undefined) {
        missingTargetLimitations.push(
          `${label} ${symbol.qualified_name} has no explicit mutation target.`,
        );
        return [];
      }
      return [symbol.target];
    });

  const changedSymbolsByName = new Map(
    impact.changed_symbols.map((symbol) => [symbol.qualified_name, symbol]),
  );
  change.changed_symbols.forEach((symbol) => {
    changedSymbolsByName.set(symbol.qualified_name, symbol);
  });
  const primaryTargets = uniqueSorted([
    ...productionTargets([...changedSymbolsByName.values()], 'Changed symbol'),
    ...productionTargets(
      impact.direct_impacts.map((item) => item.symbol),
      'Directly impacted symbol',
    ),
  ]);
  if (primaryTargets.length === 0) {
    return {
      success: false,
      issues: [
        {
          code: 'no_mutation_targets',
          path: '$.primary_targets',
          message:
            'No changed or directly impacted production symbol has an explicit mutation target',
        },
      ],
    };
  }

  const primarySet = new Set(primaryTargets);
  const supportingTargets = uniqueSorted(
    productionTargets(
      impact.indirect_impacts.map((item) => item.symbol),
      'Indirectly impacted symbol',
    ).filter((target) => !primarySet.has(target)),
  );
  const relevantTests = uniqueSorted([
    ...impact.candidate_tests.flatMap((test) => {
      if (test.target === undefined) {
        missingTargetLimitations.push(
          `Candidate test ${test.qualified_name} has no explicit test target.`,
        );
        return [];
      }
      return [test.target];
    }),
    ...change.changed_symbols.flatMap((symbol) => {
      if (symbol.role !== 'test') {
        return [];
      }
      if (symbol.target === undefined) {
        missingTargetLimitations.push(
          `Changed test ${symbol.qualified_name} has no explicit test target.`,
        );
        return [];
      }
      return [symbol.target];
    }),
  ]);
  const limitations = uniqueSorted([
    ...impact.limitations,
    ...missingTargetLimitations,
    ...(impact.evidence_use === 'synthetic_test_only'
      ? [
          'Synthetic graph evidence is for deterministic testing only and cannot authorize a change.',
        ]
      : []),
  ]);
  const parsed = MutationScopeSchema.safeParse({
    primary_targets: primaryTargets,
    supporting_targets: supportingTargets,
    relevant_tests: relevantTests,
    confidence: impact.confidence,
    limitations,
  });
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid_mutation_scope',
        path:
          issue.path.length === 0
            ? '$'
            : `$.${issue.path.map(String).join('.')}`,
        message: issue.message,
      })),
    };
  }
  return { success: true, scope: parsed.data };
};
