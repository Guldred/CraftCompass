# ADR 0009: Deterministic agent instructions

- Status: Accepted
- Date: 2026-07-26

## Context

Coding agents need concise project policy, but free-form generation can amplify
untrusted repository text, turn candidate guidance into commands, or silently
reduce required review. A generated `AGENTS.md` also creates an ownership risk:
automation must not overwrite a file maintained by a human or another project.

The instruction surface therefore needs deterministic authority mapping,
explicit provenance, bounded rendering, and conservative installation.

## Decision

Compile agent instructions as a pure operation over a validated artifact
registry, one explicitly selected project profile, its assurance profile, and
that project's rules. Evaluate exception eligibility against an explicit
effective UTC date. Do not call an LLM or perform I/O during compilation.

Map only active project rules to directive authority:

| Rule level     | Generated authority           |
| -------------- | ----------------------------- |
| `mandatory`    | `MUST`                        |
| `recommended`  | `SHOULD`                      |
| `contextual`   | `CONDITIONAL`                 |
| `aspirational` | `ASPIRATIONAL (NON-BLOCKING)` |

Candidate rules are rendered only as pending IDs. Non-retired
`requires_decision` rules retain their sanitized ID and scope so an agent can
recognize applicability, but never become instructions. Retired and
not-applicable rules do not become directives. Active exceptions retain only
the minimum operational metadata needed by an agent.

Copy selected project policy, rule statements, scopes, and assurance settings.
Do not copy observation prose, evidence descriptions, provider output,
enforcement configuration, origin paths, or timestamps into the instruction
model. Treat every copied human-authored string as untrusted display data and
escape Markdown structure, HTML/autolinks, control characters, and hidden
formatting before rendering.

Sort all sets deterministically, use LF line endings and one trailing newline,
and record stable compiler, format, project, and source-artifact provenance.
Limit one compilation to 256 project rules and 128 KiB of rendered output.

Generated instructions describe project-wide policy and a review ceiling. They
do not replace a change-specific `AssurancePlan`, authorize Review Level 3, or
independently permit reduced review. Without a validated change-specific plan,
the conservative review level is Level 0. Active policy conflicts and unresolved
decisions are human stop points.

Support three repository-root operations:

- `render` writes the expected managed Markdown to standard output.
- `check` is read-only and distinguishes current, missing, drifted, human-owned,
  foreign-project, and unsupported-version files.
- `install` creates a missing root `AGENTS.md` atomically and otherwise leaves an
  exact current file unchanged.

Installation never overwrites an existing file, including a drifted managed
file. A generated first-line ownership marker identifies managed content for
diagnostics but does not authorize replacement. File access is bounded,
no-follow, regular-file-only, repository-contained, and race checked. Creation
uses an exclusive same-directory temporary file, an atomic no-replace hard link,
and file and directory sync.

The CraftCompass repository's own root `AGENTS.md` is deliberately
human-authored and does not carry the generated ownership marker.

## Consequences

- Identical validated inputs produce byte-identical instructions.
- Policy changes produce reviewable drift rather than silent replacement.
- Candidate knowledge, provider evidence, and repository prose cannot smuggle
  new authority into generated instructions.
- Humans must deliberately reconcile or replace existing instruction files.
- Generated guidance is useful context for agents but is not a sandbox,
  authorization mechanism, or substitute for assurance evidence.
