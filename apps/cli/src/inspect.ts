import type { CraftArtifact } from '@craftcompass/domain';

const plural = (
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string => `${count} ${count === 1 ? singular : pluralForm}`;

/** Renders a stable human summary without leaking validation-library details. */
export const inspectArtifact = (artifact: CraftArtifact): string => {
  switch (artifact.kind) {
    case 'craftsmanship_principle':
      return [
        `Craftsmanship principle ${artifact.id}: ${artifact.title}`,
        `Maturity: ${artifact.maturity}; lifecycle: ${artifact.lifecycle}`,
        `${plural(artifact.warning_signals.length, 'warning signal')}; ${plural(artifact.enforcement_options.length, 'enforcement option')}`,
      ].join('\n');
    case 'practice_statement':
      return [
        `Practice statement ${artifact.id}: ${artifact.title}`,
        `Maturity: ${artifact.maturity}; lifecycle: ${artifact.lifecycle}`,
        `Scope: ${artifact.scope.join(', ')}`,
      ].join('\n');
    case 'project_profile': {
      const technologies =
        artifact.technologies.map((technology) => technology.name).join(', ') ||
        'none detected';
      const modules =
        artifact.modules
          .map((module) => `${module.path} (${module.status})`)
          .join(', ') || 'none detected';
      const observationCounts = artifact.observations.reduce<
        Record<string, number>
      >((counts, observation) => {
        counts[observation.type] = (counts[observation.type] ?? 0) + 1;
        return counts;
      }, {});
      const observations =
        Object.entries(observationCounts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([type, count]) => `${type}: ${count}`)
          .join(', ') || 'none';
      const coverage = artifact.observation_coverage;
      return [
        `Project profile ${artifact.id}: ${artifact.name}`,
        `Technologies: ${technologies}`,
        `Modules: ${modules}`,
        `Observation coverage: ${coverage?.status ?? 'unknown'}${
          coverage === undefined ? '' : `; provider: ${coverage.provider.id}`
        }`,
        `Observations: ${observations}`,
        `${plural(artifact.constraints.length, 'constraint')}; ${plural(artifact.uncertainties.length, 'uncertainty', 'uncertainties')}`,
      ].join('\n');
    }
    case 'change_context':
      return [
        `Change context ${artifact.id} for ${artifact.project_ref}`,
        `Nature: ${artifact.nature}; concerns: ${artifact.concerns.join(', ')}`,
        `${plural(artifact.changed_files.length, 'changed file')}; ${plural(artifact.changed_symbols.length, 'changed symbol')}`,
      ].join('\n');
    case 'change_impact':
      return [
        `Change impact ${artifact.id} for ${artifact.change_ref}`,
        `Status: ${artifact.status}; source: ${artifact.source}; completeness: ${artifact.completeness}; confidence: ${artifact.confidence.toFixed(2)}`,
        `${plural(artifact.direct_impacts.length, 'direct impact')}; ${plural(artifact.indirect_impacts.length, 'indirect impact')}; ${plural(artifact.impacted_flows.length, 'impacted flow')}`,
      ].join('\n');
    case 'project_rule':
      return [
        `Project rule ${artifact.id}: ${artifact.title}`,
        `Level: ${artifact.level}; status: ${artifact.status}; confidence: ${artifact.confidence.toFixed(2)}`,
        `${plural(artifact.principle_refs.length, 'principle')}; ${plural(artifact.evidence.length, 'evidence reference')}; ${plural(artifact.enforcement.length, 'enforcement option')}`,
      ].join('\n');
    case 'assurance_profile':
      return [
        `Assurance profile ${artifact.id} for ${artifact.project_ref}`,
        `Criticality: ${artifact.project_criticality}; default review level: ${artifact.review_policy.default_level}`,
        `Mutation policy: ${artifact.mutation_policy.strategy}`,
      ].join('\n');
    case 'assurance_plan':
      return [
        `Assurance plan ${artifact.id} for change ${artifact.change_id}`,
        `Risk: ${artifact.risk.overall}; review level: ${artifact.human_review.level}`,
        `${plural(artifact.required_gates.length, 'required gate')}; ${plural(artifact.impacted_flows.length, 'impacted flow')}`,
      ].join('\n');
    case 'mutation_report': {
      const classifications = artifact.mutations
        .flatMap((mutation) =>
          'classification' in mutation
            ? [
                `${mutation.id}=${mutation.outcome}/${mutation.classification}/${mutation.classification_status}`,
              ]
            : [],
        )
        .join(', ');
      return [
        `Mutation report ${artifact.id} from ${artifact.provider.id}`,
        `Generated: ${artifact.totals.generated}; killed: ${artifact.totals.killed}; survived: ${artifact.totals.survived}; no coverage: ${artifact.totals.no_coverage}; timed out: ${artifact.totals.timed_out}; errors: ${artifact.totals.errors}`,
        `Run: ${artifact.run.completeness}; scope confidence: ${artifact.scope.confidence.toFixed(2)}; mutation debt: ${classifications || 'none'}`,
      ].join('\n');
    }
    case 'mutation_baseline':
      return [
        `Mutation baseline ${artifact.id} for ${artifact.project_ref}`,
        `Status: ${artifact.status}; provider: ${artifact.provider.id}; source report: ${artifact.source_report_ref}`,
        `${plural(artifact.entries.length, 'debt entry')}; source run: ${artifact.source_run.completeness}`,
      ].join('\n');
  }
};
