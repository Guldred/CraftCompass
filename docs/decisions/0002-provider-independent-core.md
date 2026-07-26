# ADR 0002: Provider-independent core

- Status: Accepted
- Date: 2026-07-26

## Context

The long-term product may use GitNexus, MCP, LLMs, mutation tools, source
forges, filesystems, shell commands, and CI systems. Making any one of these a
domain concept would couple the central model to infrastructure and misstate
provider evidence as authoritative judgment.

The first slice still needs explicit future substitution boundaries for code
graphs and mutation testing.

## Decision

The domain may depend on Zod for runtime contract validation and on no other
runtime library.

Filesystem and YAML behavior belong to `apps/cli`. Future providers implement
the minimal `CodeGraphProvider` or `MutationTestingProvider` ports using only
provider-neutral request and result types.

Provider results must preserve:

- evidence,
- confidence,
- limitations,
- unresolved interpretation.

Do not create provider packages until an implementation exists. Do not expose
GitNexus, PIT, Stryker, MCP, LLM, shell, HTTP, CI, GitHub, or GitLab types through
the domain.

## Consequences

- The dependency direction is `adapter -> domain`, never the reverse.
- A code graph supplies evidence and cannot declare a craftsmanship violation.
- A mutation provider supplies normalized outcomes and non-authoritative
  classification candidates.
- Adapters incur explicit mapping work, which is intentional protection against
  vendor contract leakage.
- The two ports exist because the current requirements mandate real future
  substitution boundaries; other interfaces wait for concrete need.
