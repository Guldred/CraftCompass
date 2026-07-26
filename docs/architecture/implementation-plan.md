# Implementation plan

CraftCompass is developed as vertical slices that produce usable, verified
artifacts without pre-creating the full future architecture.

## Slice 0: Artifact-contract foundation

Status: complete in the initial repository foundation.

Outcome:

- strict TypeScript/pnpm workspace,
- provider-independent knowledge, project, rule, assurance, and mutation models,
- explicit code-graph and mutation-provider ports,
- eight connected YAML fixtures,
- deterministic `craft validate` and `craft inspect`,
- focused invalid fixtures and contract tests,
- architecture documentation and decisions.

Exit criteria:

- format, lint, strict source-and-test type checks, tests, and build pass,
- every artifact detects by kind and schema version,
- errors contain actionable paths,
- evidence survives semantic YAML round trips,
- no provider or filesystem dependency exists in the domain.

## Slice 1: Basic repository technology detection

Status: complete.

Add one filesystem adapter that observes:

- languages,
- build tools,
- frameworks declared in build manifests,
- test frameworks,
- candidate module/source roots.

It produces `ProjectObservation` records and a candidate `ProjectProfile`.
Detected declarations are facts; architectural intent remains an interpretation
or uncertainty. No LLM or code graph is needed.

Exit criteria:

- synthetic Java/Maven/Spring and TypeScript/pnpm repositories produce stable,
  different profiles,
- every observation references a relative repository location,
- unsupported repositories produce useful partial evidence rather than false
  certainty,
- the domain remains unchanged unless real adapter needs expose a contract gap.

Delivered:

- `packages/providers-filesystem` with bounded JSON/XML manifest parsing,
- Maven-coordinate and package-manager conflict checks that avoid false facts,
- evidence-linked technology/module records and honest partial profiles,
- path, symlink, size, permission, DOCTYPE/entity, and root-escape controls,
- `craft scan` and `craft project scan`,
- Java/Maven/Spring/JUnit and TypeScript/pnpm/Vitest fixture repositories.

## Slice 2: Cross-artifact registry and deterministic derivation fixture

Status: complete.

Add directory loading, reference resolution, and one explicit rule-derivation
use case over fixtures. Keep derivation deterministic before introducing an LLM.

Exit criteria:

- missing and duplicate references fail clearly,
- source, project evidence, and rule traceability resolve end to end,
- one dependency principle yields different candidate levels for a new service,
  legacy monolith, and intentionally simple tool.

Delivered:

- bounded recursive, sorted, deduplicated, single-document YAML loading with
  canonical roots and artifact/descendant symlink rejection,
- deterministic registry issues for artifact, principle, project, observation,
  module, evidence, and source references,
- typed, evidence-linked project adaptation context,
- greenfield, legacy, simple-tool, and requires-decision recipe branches,
- candidate-only non-blocking output,
- `craft registry validate` and `craft derive dependency-direction`.

## Slice 3: Fake code-graph provider

Status: in progress.

Exercise `CodeGraphProvider` with deterministic responses before a GitNexus
adapter. Add change impact, graph limitations, and scope-confidence behavior.

Exit criteria:

- direct, indirect, low-confidence, and missing-runtime-edge cases are covered,
- graph centrality and cluster membership remain signals rather than verdicts,
- no provider type leaks into domain artifacts.

## Slice 4: Mutation report parsing and baselines

Status: planned after Slice 3.

Implement a fixture-backed provider adapter parser without executing mutation
tools initially. Normalize killed, survived, no-coverage, timed-out, and error
outcomes; compare a stored baseline; enforce no new unexplained survivors.

Exit criteria:

- equivalent classifications remain candidates,
- expired accepted risks do not waive survivors,
- score is contextual only,
- provider errors and scope limitations remain visible.

## Later slices

- real GitNexus adapter and index-freshness evidence,
- PIT execution for Maven through an injectable command runner,
- broader assurance planning and Review Level 0–2 recommendation,
- rule and agent-instruction compilation,
- evidence-ledger persistence,
- MCP, CI, GitHub, and GitLab adapters,
- broader mutation providers,
- explicitly earned and separately versioned Review Level 3.
