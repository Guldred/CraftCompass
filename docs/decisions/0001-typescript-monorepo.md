# ADR 0001: TypeScript pnpm monorepo

- Status: Accepted
- Date: 2026-07-26

## Context

CraftCompass needs runtime-validated human-editable artifacts, a CLI, and later
MCP/provider adapters. The repository did not establish an implementation
language. The product brief prefers Node.js LTS, strict TypeScript, pnpm,
Vitest, Zod, YAML, ESLint, and Prettier.

Creating every proposed future package now would produce empty boundaries and
unused abstractions.

## Decision

Use a pnpm workspace with Node.js 22.13 or newer and TypeScript in strict mode.
Create only:

- `packages/domain`
- `apps/cli`

Use:

- Zod for runtime domain validation,
- `yaml` only at the CLI edge,
- Vitest for explicit behavioral tests,
- TypeScript project references for builds,
- ESLint and Prettier for static and formatting checks.

Pin the package-manager and dependency versions. Compile to native ESM with
NodeNext resolution. Keep internal packages private until a publication and
versioning strategy exists.

## Consequences

- CLI and future Node adapters share types without duplicating schemas.
- The root build validates package dependency order.
- One domain package avoids speculative package fragmentation.
- A future non-TypeScript adapter must consume a published artifact contract
  rather than internal TypeScript types.
- A generated JSON Schema may later be required for non-TypeScript consumers.
- Selecting a project license and package publication model remains an owner
  decision.
