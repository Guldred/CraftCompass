# ADR 0005: Evidence-first repository observation

- Status: Accepted
- Date: 2026-07-26

## Context

CraftCompass needs real project evidence before it can adapt general guidance.
Repository detection is also a trust boundary: input may be malformed, very
large, ambiguous, unreadable, or deliberately constructed to escape the root.

Filename heuristics and artifact-name-only matching would create false
certainty. Treating every package.json as npm, every `spring-boot-*` artifact as
Spring, or every parser failure as absence would make downstream rules look more
reliable than their evidence.

## Decision

Create `packages/providers-filesystem` as a concrete adapter that depends on the
provider-independent domain.

Detection is positive-only and deliberately non-exhaustive. Initially support:

- package.json dependency declarations, tsconfig, package-manager declarations,
  and recognized lockfiles,
- Maven models, Java source roots, trusted group/artifact coordinates, and
  declared Maven modules.

Every detected technology and module carries repository-relative evidence.
Unsupported repositories produce empty detection lists plus uncertainty rather
than invented `Unknown` facts. Conflicting package-manager evidence remains
uncertain.

Parse XML structurally with entity processing disabled and syntax validation.
Reject DOCTYPE declarations, manifest symlinks, files above 2 MiB, paths outside
the repository, modules resolving to the root, and non-ENOENT filesystem
failures. Do not classify Maven `pluginManagement` declarations as active
plugins.

## Consequences

- A profile can be useful without pretending detection is complete.
- Evidence consumers can verify the file that supports each claim.
- Common Java/Maven and TypeScript projects work now; Gradle, Python, and other
  ecosystems remain unsupported until parser-backed fixtures exist.
- False negatives are preferred to false certainty.
- Node filesystem and XML/JSON parser types remain outside the domain.
