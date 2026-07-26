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

## Current foundation slice

This repository currently proves one narrow end-to-end path:

```text
YAML artifact
  -> filesystem/YAML CLI adapter
  -> kind and schema-version detection
  -> provider-independent domain validation
  -> semantic policy checks
  -> clear validation result or concise inspection summary
```

Implemented artifacts:

- craftsmanship principles and attributed practice statements,
- evidence-aware project profiles,
- traceable project rules,
- assurance profiles and change-specific plans,
- quality-gate and mutation contracts,
- `CodeGraphProvider` and `MutationTestingProvider` ports.

The core does not scan repositories, call an LLM, query GitNexus, execute
mutation tools, generate rules, or run quality gates yet.

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
│   └── domain/               # Pure domain contracts, validation, and ports
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

Future packages are documented rather than created empty. The only runtime
dependency direction is:

```text
CLI -> domain -> Zod
```

The CLI additionally depends on Node filesystem APIs and the YAML parser.

## Architecture documentation

- [Architecture](docs/architecture/architecture.md)
- [Domain model](docs/architecture/domain-model.md)
- [Implementation plan](docs/architecture/implementation-plan.md)
- [ADR 0001: TypeScript monorepo](docs/decisions/0001-typescript-monorepo.md)
- [ADR 0002: Provider-independent core](docs/decisions/0002-provider-independent-core.md)
- [ADR 0003: Knowledge maturity separation](docs/decisions/0003-knowledge-maturity-separation.md)
- [ADR 0004: No global mutation score](docs/decisions/0004-no-global-mutation-score.md)

## Deferred work

The recommended next slice is basic repository technology detection. A
filesystem adapter can produce real, evidence-linked `ProjectObservation` and
`ProjectProfile` artifacts without yet introducing code graphs, LLM reasoning,
mutation execution, or rule derivation.

Also deferred:

- multi-file artifact registries and reference resolution,
- repository and Git diff analysis,
- fake and real code-graph providers,
- project-rule derivation and generated instructions,
- mutation report adapters and baseline comparison behavior,
- quality-gate orchestration and evidence ledgers,
- MCP, CI, GitHub, and GitLab adapters,
- Review Level 3.

## License

An open-source license has not yet been selected. License choice is a material
owner decision; until a license file is added, the repository should not claim
that redistribution rights have been granted.
