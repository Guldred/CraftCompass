# ADR 0003: Separate knowledge maturity, lifecycle, and product interpretation

- Status: Accepted
- Date: 2026-07-26

## Context

The product documents describe foundational principles, established practices,
current positions, emerging experiments, contested ideas, superseded ideas, and
CraftCompass product decisions.

Their proposed `KnowledgeMaturity` enum combines source category and lifecycle,
omits `product_decision`, and an example alternates between `emerging` and
`emerging_experiment`. Without a structural distinction, a recent attributed
position could be represented as timeless foundational guidance.

Attributed source material must also remain distinct from CraftCompass's own
interpretation.

## Decision

Keep the required `KnowledgeMaturity` name for the source/maturity category:

```text
foundational
established_practice
current_position
emerging_experiment
product_decision
```

Represent lifecycle separately:

```text
active
contested
superseded
```

`CraftsmanshipPrinciple` requires `foundational`.
`PracticeStatement` supports every non-foundational category and rejects
`foundational`.

Every knowledge artifact stores source references and
`product_interpretation` in separate fields. Serialized vocabulary uses lower
snake case.

## Consequences

- A current position can become contested or superseded without changing its
  historical category.
- A CraftCompass product choice cannot be mistaken for an author's statement.
- The current position on agent-written code cannot validate as foundational.
- The type name `KnowledgeMaturity` is broader than an ideal taxonomy name, but
  preserving it satisfies the requested public concept without adding redundant
  fields.
- A later schema version may rename this axis to `knowledge_kind` if external
  usage proves the distinction valuable enough to justify migration.
