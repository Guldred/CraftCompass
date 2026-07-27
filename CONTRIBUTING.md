# Contributing to CraftCompass

Thank you for helping build CraftCompass. The project is pre-1.0 and its
artifact contracts are still being established, so small, evidence-backed
changes are preferred over speculative framework work.

## Project and license status

The repository is version `0.0.0` and no open-source license has been selected
yet. Public source visibility does not by itself grant redistribution or reuse
rights. Do not copy third-party code, fixtures, documentation, or datasets
without compatible, documented permission. License selection remains a
maintainer decision that must be completed before a public release.

## Development setup

Prerequisites:

- Node.js 22.23.1+ or 24.18.0+ on the corresponding supported LTS line
- pnpm 10.33.0, pinned by the root `packageManager`
- Linux or macOS for the hardened CLI and repository scanner

Set up a reproducible checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The repository is a private pnpm workspace; compiled `dist` output,
`node_modules`, coverage, and TypeScript build metadata are ignored and should
not be committed.

## Before implementing

- Read the [README](README.md), [architecture](docs/architecture/architecture.md),
  [domain model](docs/architecture/domain-model.md), and relevant
  [architecture decisions](docs/decisions/).
- For a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of
  opening a public issue with exploit details.
- Discuss a change first when it introduces a new provider or dependency,
  changes a persisted artifact contract, expands authority, adds Review Level 3,
  or makes a new security or licensing decision.
- Keep the change focused. Do not combine feature work with unrelated cleanup.

## Design expectations

CraftCompass separates evidence from judgment and infrastructure from policy:

- `packages/domain` owns strict provider-independent contracts and may depend at
  runtime only on Zod.
- Pure engines derive assurance, mutation policy, and agent instructions without
  filesystem, process, network, vendor, or clock side effects.
- Provider packages parse and normalize untrusted external data behind
  provider-neutral boundaries.
- `apps/cli` owns YAML, filesystem behavior, terminal output, and process exit
  codes.

Preserve these invariants:

- Facts, interpretations, assumptions, uncertainty, debt, and human decisions
  remain distinct.
- Candidate or synthetic evidence never silently becomes blocking authority.
- Missing, degraded, stale, or incomparable evidence remains explicit and fails
  closed.
- Provider topology is evidence, not an architecture verdict.
- Mutation scores are context only; policy operates on exact mutation records.
- Generated agent instructions cannot overwrite human-owned files.
- Deterministic inputs produce stable ordering, identifiers, serialization, and
  decisions. Inject clocks instead of reading time in pure domain behavior.

## Tests and fixtures

Add focused tests for behavior and failure paths. Prefer explicit assertions over
large snapshots for important domain decisions.

When changing an artifact schema or parser:

- update representative valid and invalid fixtures,
- test cross-field and cross-artifact invariants,
- test bounds, malformed input, symlinks/path escapes, and ambiguous provider
  data where applicable,
- prove that unsupported or incomplete evidence stays visible,
- document compatibility impact while schema v1 remains unreleased.

Run the narrowest useful test while developing, for example:

```bash
pnpm exec vitest run packages/domain/src/registry.test.ts
```

Before opening a pull request, run the complete repository gate:

```bash
pnpm check
```

This runs formatting, linting, strict source-and-test type checking, tests, and
the build. Do not weaken a check or test to make a change pass. If an external
provider, runtime, or platform cannot be verified locally, state the unverified
boundary in the pull request.

## Pull requests and commits

Keep commits focused and use a short imperative subject. The existing history
uses subjects such as `feat: ...`, `fix: ...`, and `docs: ...`.

A pull request should explain:

- the intended behavior or contract,
- evidence for the change and the tests run,
- affected consumers and compatibility or security risk,
- the appropriate human-review depth,
- remaining uncertainty, required decisions, accepted risks, and deferred work.

Commit `pnpm-lock.yaml` only when dependency resolution intentionally changes.
Never commit credentials, tokens, private repository data, production reports,
or machine-specific configuration.

Documentation is part of the contract. Add an ADR for a durable architectural
decision and update architecture or domain documentation when public behavior
changes.
