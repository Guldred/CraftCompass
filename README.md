# CraftCompass

CraftCompass is an AI-assisted software-craftsmanship and assurance system. It
turns general engineering knowledge into context-aware project guidance,
traceable rules, and change-specific assurance strategies.

The project is starting with the contracts that later integrations must honor:
versioned knowledge, project evidence, project rules, assurance plans, mutation
evidence, and provider-independent ports.

## The problem

General principles such as dependency direction, cohesion, and testability need
project context. A sensible boundary in a business-critical service can be
unnecessary ceremony in a small utility. Existing code can represent intended
architecture, accidental structure, or known debt.

CraftCompass therefore keeps evidence separate from judgment and preserves:

- observed facts,
- interpretations,
- assumptions,
- uncertainties,
- human decisions,
- known technical debt.

A principle becomes a project rule only after its applicability, evidence, risk,
scope, enforcement, confidence, migration needs, and exceptions are considered.

## What CraftCompass does not claim

CraftCompass is not:

- a universal Clean Architecture or coding-style enforcer,
- proof that requirements, security, architecture, or behavior are complete,
- a replacement for human engineering responsibility,
- a claim that human code review is obsolete,
- a global mutation-score gate,
- a GitNexus, mutation-tool, LLM, CI, or source-forge implementation.

Mutation testing is modeled as evidence about whether tests detect selected
semantic changes. The first-class policy is:

> No new unexplained surviving mutants in changed business behavior.

Human review remains risk-based. Schema version 1 supports Review Levels 0, 1,
and 2 only; Level 3 is deliberately not representable.

## Current working slices

The repository now supports two usable evidence-first workflows:

```text
repository
  -> safe manifest inspection
  -> evidence-linked candidate project profile

artifact paths/directories
  -> strict YAML loading and domain validation
  -> cross-artifact reference registry
  -> deterministic candidate rule derivation
```

Implemented artifacts:

- craftsmanship principles and attributed practice statements,
- evidence-aware project profiles,
- traceable project rules,
- assurance profiles and change-specific plans,
- quality-gate and mutation contracts,
- `CodeGraphProvider` and `MutationTestingProvider` ports.

Implemented behavior:

- safe, deterministic Java/Maven and TypeScript/package-manager observation,
- honest partial profiles for malformed or unsupported repositories,
- evidence links for every detected technology and candidate module,
- bounded recursive YAML artifact loading with canonical input roots and no
  traversal through artifact or descendant symlinks,
- globally unique artifact IDs plus
  project/principle/observation/module/source/evidence reference resolution,
- deterministic dependency-direction candidates for greenfield, legacy,
  intentionally simple, and undecided contexts.

CraftCompass does not call an LLM, query a real code graph, execute mutation
tools, or run quality gates yet.

## Requirements

- Node.js 22.13 or newer on a supported LTS line
- pnpm 10.33.0 (pinned through `packageManager`)

Corepack can activate the pinned pnpm version:

```bash
corepack enable
```

Install dependencies:

```bash
pnpm install
```

## CLI

Validate a supported artifact:

```bash
pnpm craft validate knowledge/principles/dependency-direction.yaml
```

Inspect a valid artifact:

```bash
pnpm craft inspect fixtures/valid/mutation-report-with-survivor.yaml
```

Scan a repository into a candidate project profile:

```bash
pnpm craft project scan fixtures/repositories/java-spring-service
```

Validate a connected artifact set. Inputs may be YAML files or directories:

```bash
pnpm craft registry validate \
  knowledge/principles/dependency-direction.yaml \
  fixtures/valid/java-spring-project-profile.yaml
```

Derive a non-blocking candidate rule:

```bash
pnpm craft derive dependency-direction \
  PROJECT-ORDER-SERVICE \
  knowledge/principles/dependency-direction.yaml \
  fixtures/valid/java-spring-project-profile.yaml
```

The `pnpm craft` development shortcut builds first. After `pnpm build`, the
workspace-linked binary is also available:

```bash
pnpm exec craft validate fixtures/valid/assurance-profile.yaml
```

Invalid input returns a non-zero exit code and reports field paths:

```text
$.observations[0].confidence: Confidence must be at most 1 [too_big]
```

After building, the compiled executable can be run directly:

```bash
node apps/cli/dist/main.js validate fixtures/valid/assurance-profile.yaml
```

## Quality commands

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

`pnpm check` runs formatting, linting, strict source-and-test type checking,
tests, and the build. Tests use explicit assertions rather than snapshots for
important domain behavior.

## Repository shape

```text
.
├── apps/
│   └── cli/                  # Filesystem, YAML, terminal, and exit-code adapter
├── packages/
│   ├── domain/               # Pure contracts, registry, and derivation
│   └── providers-filesystem/ # Safe repository observation adapter
├── knowledge/
│   ├── current-positions/
│   └── principles/
├── fixtures/
│   ├── invalid/
│   └── valid/
└── docs/
    ├── architecture/
    ├── decisions/
    └── product/
```

The runtime dependency direction is:

```text
CLI -> providers-filesystem -> domain -> Zod
CLI ------------------------> domain
```

The CLI owns artifact-file traversal and YAML. The filesystem provider owns
repository paths, manifest reading, and structural XML/JSON parsing. The domain
imports neither.

## Architecture documentation

- [Architecture](docs/architecture/architecture.md)
- [Domain model](docs/architecture/domain-model.md)
- [Implementation plan](docs/architecture/implementation-plan.md)
- [ADR 0001: TypeScript monorepo](docs/decisions/0001-typescript-monorepo.md)
- [ADR 0002: Provider-independent core](docs/decisions/0002-provider-independent-core.md)
- [ADR 0003: Knowledge maturity separation](docs/decisions/0003-knowledge-maturity-separation.md)
- [ADR 0004: No global mutation score](docs/decisions/0004-no-global-mutation-score.md)
- [ADR 0005: Evidence-first repository observation](docs/decisions/0005-evidence-first-repository-observation.md)
- [ADR 0006: Unreleased schema refinement and deterministic adaptation](docs/decisions/0006-unreleased-v1-and-deterministic-adaptation.md)

## Deferred work

The next slice exercises change-impact behavior through a deterministic fake
code-graph provider before a real GitNexus integration.

Also deferred:

- repository and Git diff analysis,
- fake and real code-graph providers,
- broader project-rule derivation and generated instructions,
- mutation report adapters and baseline comparison behavior,
- quality-gate orchestration and evidence ledgers,
- MCP, CI, GitHub, and GitLab adapters,
- Review Level 3.

## License

An open-source license has not yet been selected. License choice is a material
owner decision; until a license file is added, the repository should not claim
that redistribution rights have been granted.
