# ADR 0010: Bounded composite repository observation

- Status: Accepted
- Date: 2026-07-27

## Context

ADR 0005 deliberately made repository detection positive-only and
non-exhaustive. The first filesystem provider reads supported manifests at the
repository root and emits useful evidence for conventional single-build
projects.

A realistic Maven reactor with profile-bound modules, nested aggregators, and
an independent frontend build exposed two contract gaps:

- finding one supported root manifest could leave `uncertainties` empty even
  though most build roots were not inspected,
- a generic `src` directory could be presented as a candidate module without
  manifest or source evidence.

Adding more filename heuristics would increase coverage without making its
limits explainable. Reproducing Maven's full effective model or executing a
target build would also violate the read-only, untrusted-input boundary.

## Decision

Persist provider-neutral observation coverage on scanner-created
`ProjectProfile` artifacts. Coverage records:

- a provider and observation-contract version,
- supported or partial capabilities,
- inspected, failed, unsupported, and budget-skipped inputs,
- explicit deterministic traversal limits,
- limitations.

Coverage is always relative to its declared capabilities and bounds. Missing
coverage means unknown. A result may say `complete_for_declared_scope` only
when it includes at least one supported capability and assessed input, every
input was parsed or observed, and no limitation remains. It never means complete
repository, runtime, architecture, or assurance knowledge. The filesystem
provider reports partial coverage until a narrower complete scope is explicitly
implemented.

Repository modules may retain provider-neutral discovery provenance:

- whether the candidate came from a manifest declaration, manifest presence,
  or source layout,
- whether its selection is unconditional, a default candidate, conditional,
  or unknown,
- optional context explaining the condition.

The filesystem provider composes supported build roots in this order:

1. parse supported root manifests,
2. follow declared Maven modules, including modules declared by profiles,
3. recursively follow declared local child modules within fixed budgets,
4. perform sorted, bounded discovery for independent supported manifests.

Declared module paths must resolve inside the repository to real directories
with regular child manifests. Traversal has fixed depth, directory-entry,
directory-count, manifest-count, aggregate-byte, and global declared-module
declaration-processing limits. The filesystem provider currently caps the last
of these at `max_declared_module_declarations: 4096`. Generated and dependency
output directories are excluded. Symlinked path components, special files,
malformed text or XML, input changes, and path escapes remain fail-closed or
explicitly limited.

Maven profile activation is observed, not evaluated. `activeByDefault` produces
a default candidate; property, JDK, OS, file, settings, command-line, and other
activation remains conditional or unknown. The provider does not execute
Maven, resolve remote parents or BOMs, read user settings, or claim to have
built an effective runtime model. `pluginManagement` and
`dependencyManagement` do not independently prove active tooling or
dependencies.

Evidence and identifiers are path-qualified and stable. Multiple build roots
may contribute evidence to one technology. Conflicting versions remain
explicit uncertainty rather than being resolved by traversal order. A tool not
observed inside the supported, inspected inputs is not reported as absent from
the repository.

Repository observation cannot independently authorize reduced review, even
when it is complete for its declared scanner scope. Review Level 2 additionally
requires an explicit `assurance_relevant_project_context` capability and
human-decision evidence among the coverage inputs; build-configuration evidence
alone cannot authorize the claim. The filesystem scanner does not emit that
capability. Coverage input evidence participates in the assurance plan's
decision basis whenever coverage affects review. A change-specific assurance
plan may only reduce review when that explicit, human-evidenced project-context
claim, relevant impact evidence, and all other readiness requirements establish
the affected scope.

## Consequences

- Complex multi-build repositories receive a more useful project inventory
  without upgrading filesystem evidence into an architecture verdict.
- Consumers can distinguish not found from not inspected or unsupported.
- Scanner output remains deterministic, read-only, provider-independent, and
  safe for untrusted repositories.
- Schema-v1 fixtures, registries, inspection, assurance planning, tests, and
  documentation must understand observation coverage.
- A realistic synthetic multi-build fixture and adversarial traversal tests
  become release gates for this capability.
- Framework-specific repository formats and publisher signing remain separate
  product slices backed by their own evidence and decisions.
