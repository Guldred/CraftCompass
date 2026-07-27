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

## Slice 1b: Bounded composite repository observation

Status: complete.

Extend the basic scanner without turning it into a build executor or complete
architecture model:

- persist provider-neutral observation coverage and module-discovery
  provenance,
- treat missing coverage as unknown and qualify completeness by declared scope,
- reserve complete-for-declared-scope for non-empty, fully supported and
  successfully observed inputs with no limitations,
- follow valid local Maven module declarations within separate depth and global
  declaration-processing limits before bounded manifest discovery,
- preserve default and conditional provenance for profile-bound modules,
- recognize independent supported build roots such as an embedded frontend,
- reject unsupported, unsafe, changing, or over-budget inputs without silently
  treating them as absent,
- keep all scanner evidence conservative for downstream assurance and require a
  separately declared assurance-relevant project-context capability backed by
  human-decision coverage evidence before Review Level 2.

Delivered with the domain contract and ADR: filesystem composition,
cross-artifact consumers, realistic multi-build fixtures, adversarial traversal
verification, and read-only acceptance against a representative multi-build
repository. The provider does not execute Maven, evaluate its full
profile-activation environment, resolve remote parents or BOMs, read user
settings, or claim an effective build model.

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

Status: complete.

Exercise `CodeGraphProvider` with deterministic responses before a GitNexus
adapter. Add change impact, graph limitations, and scope-confidence behavior.

Exit criteria:

- direct, indirect, low-confidence, and missing-runtime-edge cases are covered,
- graph centrality and cluster membership remain signals rather than verdicts,
- no provider type leaks into domain artifacts.

Delivered:

- strict `ChangeContext` and `ChangeImpact` artifacts,
- a fixture-only fake `CodeGraphProvider`,
- deterministic direct, indirect, degraded, unavailable, and provider-error
  behavior,
- explicit confidence caps and limitations for diff-only fallback,
- pure mutation-scope and Review Level 0–2 assurance-plan derivation,
- `craft assurance plan`.

## Slice 4: Mutation report parsing and baselines

Status: complete for report ingestion and policy evaluation. Mutation-process
execution remains deferred.

Implement a fixture-backed provider adapter parser without executing mutation
tools initially. Normalize killed, survived, no-coverage, timed-out, and error
outcomes; compare a stored baseline; enforce no new unexplained survivors.

Exit criteria:

- equivalent classifications remain candidates,
- expired accepted risks do not waive survivors,
- score is contextual only,
- provider errors and scope limitations remain visible.

Delivered:

- lossless provider-neutral mutation records for killed, survived, no-coverage,
  timed-out, and error outcomes,
- a bounded, fail-closed PIT XML parser with semantic mutation identities,
- explicit execution attestation that binds a report to one assurance plan,
  exact mutation scope, configuration fingerprint, version, and evidence,
- candidate-only baseline creation and separately human-activated baselines,
- strict baseline comparability and record-level debt deltas,
- pass, fail, and inconclusive policy outcomes that never decide by score,
- `craft mutation import-pit`, `craft mutation baseline create`, and
  `craft mutation evaluate`.

## Slice 5: Deterministic agent instructions

Status: complete.

Compile active project rules and an assurance profile into bounded,
deterministic Markdown for coding agents. Treat all human-authored descriptions
and scopes as untrusted display data.

Exit criteria:

- active mandatory rules render as `MUST`, recommendations as `SHOULD`, and
  undecided applicability remains an explicit stop point,
- source evidence, reasons, and provider configuration cannot leak into the
  generated file,
- expired exceptions cannot be rendered as active,
- assurance-plan output remains authoritative over the project-wide review
  ceiling,
- an existing `AGENTS.md` is never overwritten automatically.

Delivered:

- runtime-validated artifact-registry compilation with an injected effective
  date,
- escaped, size- and cardinality-bounded Markdown rendering,
- explicit Level 0–2 semantics and conservative no-plan behavior,
- read-only drift checks and create-only atomic installation,
- `craft instructions render`, `craft instructions install`, and
  `craft instructions check`.

## Later slices

- real GitNexus adapter and index-freshness evidence,
- PIT execution for Maven through an injectable command runner,
- evidence-ledger persistence,
- MCP, CI, GitHub, and GitLab adapters,
- broader mutation providers,
- explicitly earned and separately versioned Review Level 3.
