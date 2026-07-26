# ADR 0006: Rebaseline unreleased schema v1 and adapt deterministically

- Status: Accepted
- Date: 2026-07-26

## Context

The repository is version `0.0.0`, has not published an artifact schema, and has
no compatibility consumers. Implementing real repository observation and
cross-file traceability exposed missing v1 fields:

- evidence on technologies and modules,
- candidate/confirmed module-boundary status,
- separately evidence-backed module roles with status, confidence, and
  observation references,
- typed project adaptation context,
- project, observation, and module references on project rules.

Retaining the earlier fixture shape would force derived rules to duplicate
evidence without proving which project and observations supplied it.

Rule derivation must also be repeatable before an LLM or code graph participates.
Mining free-form observation prose would make the same concept sensitive to
wording rather than typed project decisions.

## Decision

Treat schema version 1 as an unreleased pre-1.0 contract and rebaseline it in
place while the foundation is being established. Do not create a migration from
the earlier repository-only fixtures.

Before any public schema release or external compatibility commitment:

- freeze and publish the v1 contract,
- add compatibility fixtures for every released version,
- require a new schema version or explicit migration for incompatible changes.

Use a typed, evidence-linked `adaptation_context`. Build a deterministic
artifact registry that resolves project, principle, observation, module,
evidence, and source references. Artifact and source IDs are global, while
evidence IDs are scoped to their owning project or standalone artifact. The
first dependency-direction recipe supports one named principle and fixed
context branches.

All generated rules remain non-blocking candidates. Superseded principles fail
derivation, and missing or ambiguous context produces `requires_decision`.

## Consequences

- Current fixtures are authoritative for the still-unreleased v1 contract.
- No unsupported compatibility claim is made for commit-local pre-release
  shapes.
- The registry can prove an evidence chain instead of relying on matching IDs
  or duplicated prose.
- Repeated inputs produce the same rule and serialized YAML.
- Human acceptance remains a separate state transition; generation cannot
  silently create blocking policy.
