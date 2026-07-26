# ADR 0004: No global mutation score as the decision policy

- Status: Accepted
- Date: 2026-07-26

## Context

A single aggregate mutation threshold can hide one dangerous survivor inside a
high average, penalize equivalent-mutant candidates, make legacy adoption
impractical, and encourage low-value tests written only to improve a number.

Mutation testing evaluates whether selected tests detect selected semantic
changes. It does not prove requirement completeness, correctness, security,
architecture quality, concurrency behavior, integration behavior, or production
fitness.

## Decision

Schema version 1 has one primary mutation strategy:

```text
no_new_unexplained_survivors
```

New unexplained survivors in changed business behavior are forbidden. Existing
survivors are classified and tracked through a baseline, and regression is
forbidden.

An aggregate score may be reported only as contextual evidence. It cannot be
the strategy or sole approval criterion, and the domain does not model a global
minimum threshold.

Keep execution outcomes separate from survivor classifications. Equivalent
mutants begin as candidates rather than automatic approvals. Unknown
classifications remain unresolved, and accepted risks require an explicit
exception.

## Consequences

- One consequential survivor cannot disappear inside an aggregate score.
- Legacy projects can baseline debt while applying stricter changed-code policy.
- Reports retain killed, survived, no-coverage, timed-out, and error outcomes.
- Human or independently justified classification remains necessary.
- Mutation evidence must be combined with specifications, tests, architecture,
  security, impact, and review evidence.
