# CraftCompass

CraftCompass is an evidence-first software-craftsmanship and assurance system.
It turns general engineering knowledge into contextual project rules,
change-specific assurance plans, mutation-debt decisions, and bounded
instructions for coding agents.

The project is deliberately conservative: evidence, interpretation,
assumptions, uncertainty, human decisions, and known debt remain distinct. A
principle is not a project mandate until its applicability, scope, risk,
enforcement, migration needs, and exceptions have been decided.

## Safety and claims

CraftCompass does not claim to be:

- a universal Clean Architecture or coding-style enforcer,
- proof that requirements, security, architecture, or behavior are complete,
- a replacement for human engineering responsibility,
- a reason to remove human review,
- a global mutation-score gate,
- a GitNexus, mutation-process, LLM, CI, or source-forge implementation.

Mutation testing is evidence that selected tests detect selected semantic
changes. The policy is:

> No new unexplained surviving mutation debt in changed business behavior.

Review is risk-based. Schema version 1 supports Levels 0–2 only. Level 3 is not
representable.

## What works today

CraftCompass currently provides four connected local workflows:

```text
repository manifests
  -> bounded observation
  -> evidence-linked candidate project profile

validated knowledge + project context
  -> deterministic candidate project rule
  -> bounded agent instructions after human activation

change context + graph evidence
  -> normalized impact
  -> change-specific assurance plan and mutation scope

attested PIT XML + active baseline
  -> lossless mutation report
  -> exact debt comparison
  -> passed, failed, or inconclusive policy result
```

Implemented safeguards include:

- strict, versioned Zod artifact contracts and semantic registry validation,
- safe repository and YAML traversal with path, symlink, size, count, and depth
  limits,
- evidence-linked Java/Maven and TypeScript/pnpm repository observation,
- provider-neutral observation-coverage and module-discovery provenance
  contracts,
- a fixture-only fake code-graph provider with honest degraded/unavailable
  states,
- deterministic Review Level 0–2 assurance planning,
- bounded, fail-closed PIT XML ingestion with semantic mutation identities,
- plan/scope/configuration/version execution attestation,
- candidate-only baseline creation and human-governed activation,
- score-independent mutation policy,
- deterministic instruction compilation that omits evidence text, rationale,
  and provider configuration,
- create-only atomic `AGENTS.md` installation; no existing file is overwritten.

CraftCompass does not yet execute PIT, inspect a live Git diff, query GitNexus,
run project quality gates, call an LLM, or persist an evidence ledger.

## Requirements

- Node.js 22.23.1+ or 24.18.0+ on the corresponding supported LTS line
- pnpm 10.33.0, pinned through `packageManager`
- Linux or macOS; hardened filesystem operations deliberately fail on Windows
  until equivalent no-follow and atomic guarantees are implemented

Install and verify:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, linting, strict source-and-test type checking,
tests, and the build.

## Codex skill

The canonical global-skill source lives in
[`skills/craftcompass`](skills/craftcompass/). After validating and committing
the checkout, install an immutable content-addressed package:

```bash
pnpm check
node skills/craftcompass/scripts/install-global.mjs \
  install "${CODEX_HOME:-$HOME/.codex}"
```

The installer refuses dirty source, reruns `pnpm check` inside an isolated
snapshot of the reviewed commit, creates a self-contained CLI bundle, rejects
runtime symlinks and external package imports, verifies the full content
manifest, makes the version read-only before publication, and atomically
updates an installer-managed global link. It neither builds in nor points
global skill discovery at the mutable development worktree.

The content hashes protect against corruption, torn updates, and worktree
drift. They do not authenticate against an attacker who can replace files as
the same operating-system user; signed skill releases would be a separate
product decision.

Open a new Codex task after installation, then invoke `$craftcompass`
explicitly or ask to apply CraftCompass for repository assessment,
project-rule derivation, an assurance plan, agent instructions, or
mutation-policy evaluation. The skill runs its own environment preflight and
never executes commands discovered inside the target repository.

## CLI

Run commands from the repository root. `pnpm craft` builds before invoking the
CLI. After `pnpm build`, `pnpm exec craft` calls the workspace binary directly.

### Artifacts and repository observation

Validate or inspect one artifact:

```bash
pnpm craft validate knowledge/principles/dependency-direction.yaml
pnpm craft inspect fixtures/valid/mutation-report-with-survivor.yaml
```

Scan a repository into a candidate profile:

```bash
pnpm craft project scan fixtures/repositories/java-spring-service
```

Repository-derived profiles may include `observation_coverage`, which records
the provider contract, supported or partial capabilities, inspected inputs,
optional traversal limits, and limitations. `complete_for_declared_scope`
requires non-empty capabilities and inputs, all capabilities to be supported,
all inputs to be parsed or observed, and no limitations. It means only that the
declared bounded scope was assessed; it is not a claim of complete repository,
architecture, runtime, or assurance knowledge. Partial and unknown coverage
require limitations, while missing coverage means unknown.

Module candidates may carry discovery provenance separately from architectural
roles. Manifest-declared modules can be unconditional, default candidates, or
conditional. The composite-observation contract requires declared local
modules to be followed before sorted, bounded, no-symlink discovery of embedded
supported manifests. Repository observation never executes project commands or
claims Maven profile activation, remote model resolution, or an effective
build. Scanner coverage cannot independently authorize reduced review, even
when complete for its declared scope. Review Level 2 additionally requires an
explicit assurance-relevant project-context capability with human-decision
evidence among its coverage inputs. Build-configuration evidence alone cannot
authorize reduced review. The retained input evidence remains visible in the
plan's decision trace; the filesystem scanner does not make that claim.

Validate a connected registry. Inputs may be YAML files or directories:

```bash
pnpm craft registry validate \
  knowledge \
  fixtures/valid/java-spring-project-profile.yaml
```

Derive a non-blocking dependency-direction candidate:

```bash
pnpm craft derive dependency-direction \
  PROJECT-ORDER-SERVICE \
  knowledge/principles/dependency-direction.yaml \
  fixtures/valid/java-spring-project-profile.yaml
```

### Change-specific assurance

Derive a plan from a project, assurance profile, change context, and normalized
impact:

```bash
pnpm craft assurance plan \
  ASSURANCE-PLAN-LOCAL \
  PROJECT-ORDER-SERVICE \
  ASSURANCE-PROFILE-ORDER-SERVICE \
  CHANGE-ORDER-CANCELLATION \
  IMPACT-ORDER-CANCELLATION \
  fixtures/valid/java-spring-project-profile.yaml \
  fixtures/valid/assurance-profile.yaml \
  fixtures/valid/change-context.yaml \
  fixtures/valid/change-impact.yaml
```

Graph centrality and clusters remain signals, not verdicts. Weak or unavailable
graph evidence lowers confidence and preserves limitations.

### Agent instructions

Render instructions from a validated registry:

```bash
pnpm craft instructions render \
  PROJECT-ORDER-SERVICE \
  ASSURANCE-PROFILE-ORDER-SERVICE \
  knowledge/principles/dependency-direction.yaml \
  fixtures/valid/java-spring-project-profile.yaml \
  fixtures/valid/assurance-profile.yaml \
  fixtures/valid/derived-architecture-rule.yaml
```

Create a missing root `AGENTS.md`, or check it for drift:

```bash
pnpm craft instructions install \
  ../order-service \
  PROJECT-ORDER-SERVICE \
  ASSURANCE-PROFILE-ORDER-SERVICE \
  knowledge/principles/dependency-direction.yaml \
  fixtures/valid/java-spring-project-profile.yaml \
  fixtures/valid/assurance-profile.yaml \
  fixtures/valid/derived-architecture-rule.yaml

pnpm craft instructions check \
  ../order-service \
  PROJECT-ORDER-SERVICE \
  ASSURANCE-PROFILE-ORDER-SERVICE \
  knowledge/principles/dependency-direction.yaml \
  fixtures/valid/java-spring-project-profile.yaml \
  fixtures/valid/assurance-profile.yaml \
  fixtures/valid/derived-architecture-rule.yaml
```

The target repository must already exist. Installation never overwrites an
existing file, including a drifted CraftCompass-generated file. Review and
reconcile changes explicitly.

### Mutation assurance

Importing PIT requires an existing assurance plan with mutation scope, the PIT
tool version, a SHA-256 configuration fingerprint, and a repository-relative
evidence location:

```bash
pnpm craft mutation import-pit \
  MUTATION-REPORT-LOCAL \
  ASSURANCE-PLAN-ORDER-CANCELLATION \
  1.25.3 \
  sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  target/pit-reports/execution-configuration.json \
  fixtures/pitest/valid/all-killed.xml \
  fixtures/valid/java-spring-project-profile.yaml \
  fixtures/valid/assurance-profile.yaml \
  fixtures/valid/change-assurance-plan.yaml
```

The import attests that the supplied XML belongs to that exact plan, scope, and
configuration. CraftCompass does not independently execute or verify the PIT
process yet.

Create an inert baseline candidate:

```bash
pnpm craft mutation baseline create \
  MUTATION-BASELINE-LOCAL \
  fixtures/valid/mutation-report-with-survivor.yaml
```

Only a separately reviewed artifact with human activation evidence can become
an active baseline. Evaluate a report against one:

```bash
pnpm craft mutation evaluate \
  MUTATION-REPORT-ALL-KILLED \
  MUTATION-BASELINE-ORDER-DOMAIN-ACTIVE \
  ASSURANCE-PROFILE-ORDER-SERVICE \
  fixtures/valid/java-spring-project-profile.yaml \
  fixtures/valid/assurance-profile.yaml \
  fixtures/valid/change-assurance-plan.yaml \
  fixtures/valid/mutation-report-all-killed.yaml \
  fixtures/valid/mutation-baseline-active.yaml
```

Exit code `0` means passed. Failed and inconclusive results both return non-zero
and include stable reason codes. Evaluation requires a complete connected
registry, including the current plan and the active baseline's source report.
Missing, candidate, superseded, incomparable, partial, empty, timeout-bearing,
or error-bearing evidence is inconclusive.

## Repository shape

```text
.
├── apps/
│   └── cli/
├── packages/
│   ├── assurance-engine/
│   ├── domain/
│   ├── instruction-compiler/
│   ├── mutation-engine/
│   ├── providers-filesystem/
│   └── providers-pitest/
├── knowledge/
├── fixtures/
├── skills/
│   └── craftcompass/
├── docs/
│   ├── architecture/
│   ├── decisions/
│   └── product/
└── .github/
```

The domain imports no filesystem, YAML, process, provider SDK, LLM, CI, or
source-forge implementation. Adapters depend inward on domain contracts.

## Development

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Important behavior uses explicit assertions rather than snapshots. New
provider input needs bounded parsing, hostile fixtures, and visible degraded
behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Architecture and decisions

- [Architecture](docs/architecture/architecture.md)
- [Domain model](docs/architecture/domain-model.md)
- [Implementation plan](docs/architecture/implementation-plan.md)
- [ADR 0001: TypeScript monorepo](docs/decisions/0001-typescript-monorepo.md)
- [ADR 0002: Provider-independent core](docs/decisions/0002-provider-independent-core.md)
- [ADR 0003: Knowledge maturity separation](docs/decisions/0003-knowledge-maturity-separation.md)
- [ADR 0004: No global mutation score](docs/decisions/0004-no-global-mutation-score.md)
- [ADR 0005: Evidence-first repository observation](docs/decisions/0005-evidence-first-repository-observation.md)
- [ADR 0006: Deterministic adaptation](docs/decisions/0006-unreleased-v1-and-deterministic-adaptation.md)
- [ADR 0007: Graph-backed assurance planning](docs/decisions/0007-graph-backed-assurance-planning.md)
- [ADR 0008: Attested mutation assurance](docs/decisions/0008-attested-mutation-assurance.md)
- [ADR 0009: Deterministic agent instructions](docs/decisions/0009-deterministic-agent-instructions.md)
- [ADR 0010: Bounded composite repository observation](docs/decisions/0010-bounded-composite-repository-observation.md)

## Deferred work

The next recommended slice is a read-only real code-graph adapter with explicit
index identity and freshness evidence. Later work includes mutation execution
behind an injectable process boundary, quality-gate orchestration,
evidence-ledger persistence, source-forge/MCP adapters, broader providers, and
a separately versioned Review Level 3.

## License

An open-source license has not yet been selected. License choice is a material
owner decision; until a license file is added, the repository should not claim
that redistribution rights have been granted.
