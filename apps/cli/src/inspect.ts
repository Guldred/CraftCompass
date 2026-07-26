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
      return [
        `Project profile ${artifact.id}: ${artifact.name}`,
        `Technologies: ${technologies}`,
        `Modules: ${modules}`,
        `Observations: ${observations}`,
        `${plural(artifact.constraints.length, 'constraint')}; ${plural(artifact.uncertainties.length, 'uncertainty', 'uncertainties')}`,
      ].join('\n');
    }
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
      const classifications = artifact.survivors
        .map(
          (survivor) =>
            `${survivor.id}=${survivor.classification}/${survivor.classification_status}`,
        )
        .join(', ');
      return [
        `Mutation report ${artifact.id} from ${artifact.provider}`,
        `Generated: ${artifact.totals.generated}; killed: ${artifact.totals.killed}; survived: ${artifact.totals.survived}; no coverage: ${artifact.totals.no_coverage}; timed out: ${artifact.totals.timed_out}; errors: ${artifact.totals.errors}`,
        `Scope confidence: ${artifact.scope.confidence.toFixed(2)}; survivors: ${classifications || 'none'}`,
      ].join('\n');
    }
  }
};
