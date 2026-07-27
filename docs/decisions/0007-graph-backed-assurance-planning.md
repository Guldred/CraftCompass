# ADR 0007: Graph-backed assurance planning

- Status: Accepted
- Date: 2026-07-26

## Context

Change-specific assurance needs more than a list of changed files. Direct and
indirect callers, affected flows, and relevant tests can improve the selected
verification scope. A code graph is nevertheless incomplete evidence: indexes
can be stale, runtime edges can be absent, and graph topology does not determine
whether a design is good.

CraftCompass also needs useful deterministic behavior before a live GitNexus or
other graph adapter exists. A fake provider is valuable for exercising the port
and planning rules, but synthetic output must not be mistaken for production
evidence.

## Decision

Represent the caller's explicit change description as `ChangeContext` and the
normalized impact result as the provider-neutral `ChangeImpact`. Changed files,
changed symbols, concerns, symbol roles, and mutation targets are structured
inputs; planning does not infer them from filenames, display names, or prose.

Use `CodeGraphProvider` as the substitution boundary. Provider results retain:

- provider identity and whether evidence is `observed` or `synthetic`,
- available, degraded, or unavailable behavior,
- partial or unknown completeness,
- confidence, limitations, and evidence,
- changed, directly impacted, and indirectly impacted symbols,
- affected flows, functional-cluster signals, and candidate tests.

Synthetic provider output is marked `synthetic_test_only`. It may exercise
determinism and contracts but cannot authorize a change. Conflicting evidence or
an invalid provider result fails explicitly.

When a provider is unavailable or fails, derive a diff fallback only when the
change contains an explicit production symbol with an explicit target. The
fallback is always degraded, has unknown completeness, scopes only known changed
production symbols, and has confidence no greater than `0.5`. If even that
minimum evidence is absent, impact analysis fails rather than inventing a
target.

Derive `AssurancePlan` as a pure, deterministic operation over one validated
project profile, assurance profile, change context, and change impact. Validate
all cross-artifact references before planning. Use structured concerns, project
criticality, and impacted production radius to select risk and gates.
Functional-cluster and centrality signals remain context and are not risk or
architecture verdicts.

Derive mutation targets only from explicit symbol targets. Keep changed/direct
targets separate from indirect supporting targets and retain every limitation.
A missing required mutation scope makes planning more conservative.

Support Review Levels 0, 1, and 2 only:

- Level 0 is conventional relevant human review.
- Level 1 runs gates first, followed by complete relevant human review.
- Level 2 reduces implementation-review depth only when the profile permits it
  and the change has strong, decision-eligible evidence and the required
  maturity, baseline, rollback, architecture, and exception conditions.

Critical risk, degraded or synthetic impact, confidence below `0.6`, an unknown
change, or an unresolved required mutation scope selects Level 0. The profile's
default level is a maximum eligible level, not an authorization. The generated
change-specific assurance plan controls the actual gates and review.

## Consequences

- The fake graph provider proves deterministic port behavior, not live
  repository assurance.
- Missing or weak impact evidence fails closed to a smaller confidence claim and
  deeper review.
- Graph-backed targeting can reduce irrelevant verification without claiming
  complete blast-radius discovery.
- A real graph adapter must expose availability, limitations, evidence kind, and
  index-freshness evidence rather than silently returning an apparently complete
  graph.
- Runtime, reflection, configuration, deployment, and external-service edges
  can remain outside a source graph and require separate evidence.
