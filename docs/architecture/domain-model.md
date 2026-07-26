# Domain model

## Artifact contract

Every persisted artifact is a strict, versioned mapping with
`schema_version`, `kind`, and `id`. Schema version 1 supports:

| Artifact kind             | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `craftsmanship_principle` | Long-lived, contextual engineering principle                           |
| `practice_statement`      | Attributed practice, current position, experiment, or product decision |
| `project_profile`         | Evidence-aware project state and constraints                           |
| `project_rule`            | Contextual, traceable adaptation of principles                         |
| `assurance_profile`       | Project-wide verification and review policy                            |
| `assurance_plan`          | Change-specific verification and human-review requirements             |
| `mutation_report`         | Provider-neutral mutation outcomes and survivor evidence               |

Zod schemas are the runtime source of truth. A second handwritten JSON Schema is
not maintained because it would duplicate cross-field and time-dependent
invariants. Exported schemas can be generated later when an external consumer
requires them.

## Knowledge

### Maturity/category and lifecycle

`KnowledgeMaturity` uses these canonical values:

- `foundational`
- `established_practice`
- `current_position`
- `emerging_experiment`
- `product_decision`

Lifecycle is a separate dimension:

- `active`
- `contested`
- `superseded`

This separation allows, for example, a current position to become contested or
superseded without pretending it was once a foundational principle.

`CraftsmanshipPrinciple` requires `maturity: foundational`.
`PracticeStatement` cannot use `foundational`; this makes the distinction
structural rather than a directory or ID convention.

Both models keep attributed `source_references` separate from
`product_interpretation`. A current position requires a named author and a
matching authored source reference. Source text is paraphrased rather than
embedded.

### Principle applicability

A principle includes:

- statement and rationale,
- positive and warning signals,
- counter-indications,
- contexts, preconditions, and exclusions,
- possible enforcement mechanisms and their suitability,
- limitations,
- source metadata,
- CraftCompass's explicit product interpretation.

It is knowledge, not a project mandate.

## Project evidence

| Concept              | Ownership                                                           |
| -------------------- | ------------------------------------------------------------------- |
| `ProjectObservation` | A statement with epistemic type, confidence, and evidence           |
| `ProjectConstraint`  | A confirmed or provisional limitation that shapes guidance          |
| `ProjectUncertainty` | An unresolved question, its impact, and resolution need             |
| `ProjectProfile`     | Technologies, modules, observations, constraints, and uncertainties |

`ObservationType` is:

```text
fact
interpretation
assumption
uncertainty
decision
known_debt
```

All observations carry evidence even when their type makes clear that the
conclusion is uncertain. Confidence is finite and inclusive from `0` to `1`;
confidence never changes an interpretation into a fact.

## Evidence and provenance

| Type                | Represents                                           | Example                                          |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `SourceReference`   | Intellectual or documentary provenance for knowledge | Book topic, article URL, retrieved date          |
| `EvidenceReference` | Stable pointer to project or change evidence         | Relative source path, ADR, test artifact         |
| `AssuranceEvidence` | Normalized evidence retained for a decision          | Mutation run with tool/version/result references |
| `QualityGateResult` | Outcome of one required gate                         | Passed unit-test gate linked to evidence         |

The domain stores references and normalized claims. It does not read the
referenced file, execute a command, or decide that a provider's graph is
complete.

## Project rules

`RuleLevel` is:

```text
mandatory
recommended
contextual
aspirational
not_applicable
requires_decision
```

The last two values are adaptation outcomes retained in the rule contract for
explainability. Only an active rule at the `mandatory` level can have blocking
enforcement; recommendations, contextual guidance, candidates, and retired
rules remain non-blocking.

Every `ProjectRule` requires:

- one or more principle references,
- project evidence,
- the risk being addressed,
- confidence,
- explicit scope and legacy-debt treatment,
- one or more enforcement configurations,
- exception governance,
- an optional migration strategy.

An AI review cannot be blocking unless its `authorization_decision_ref` resolves
to human-decision evidence on that rule. This implements the product brief's
prohibition on blocking builds solely through subjective AI judgment.

## Exceptions

`ExceptionPolicy` governs whether exceptions are allowed and whether reason,
owner, and expiration are required. An active `RuleException` records:

- identifier,
- reason,
- owner,
- scope,
- expiration date,
- evidence.

Schema structure and expiration are separate concerns. The structural schema
checks the record; artifact validation compares `expires_on` with an injected
reference date. An expired exception invalidates the artifact and cannot waive a
rule or assurance requirement. Schema version 1 interprets that reference date
in UTC so the same input and instant produce the same decision in every locale.

## Assurance

### Profiles and plans

`AssuranceProfile` records project-wide choices for:

- criticality and generated-code share,
- Review Level defaults and review targets,
- unit, acceptance, and integration test policy,
- architecture checks and baselines,
- mutation policy,
- security review,
- exceptions.

`AssurancePlan` instantiates assurance for a change:

- evidence-backed `RiskAssessment`,
- impacted flows,
- required and blocking quality gates,
- optional mutation scope,
- Review Level and targets,
- rationale.

Review Level is exactly `0 | 1 | 2`:

- Level 0: conventional relevant human review plus ordinary checks.
- Level 1: gates run first, followed by complete relevant human review.
- Level 2: implementation review depth follows risk while intent, architecture,
  security, and exceptions remain reviewed.

Level 3 requires a future schema and explicit product decision.

### Mutation policy and evidence

`MutationPolicy.strategy` is always:

```text
no_new_unexplained_survivors
```

Changed business behavior forbids new unexplained survivors. Existing survivors
are classified and tracked or explicitly recorded as lacking a baseline.
Regression is forbidden. A score can be reported only with
`decision_role: context_only`.

Execution outcomes remain distinct from survivor interpretation:

```text
killed | survived | no_coverage | timed_out | errors
```

`MutationClassification` is:

```text
test_gap
equivalent
irrelevant_generated_code
unreachable_code
invalid_mutation
tool_limitation
accepted_risk
unknown
```

Each survivor also has a classification status. An equivalent value can remain
a candidate; it is not automatically approved. `unknown` must remain unresolved.
`accepted_risk` requires an accepted exception and explicit exception reference.

A `MutationReport` preserves target scope, scope confidence, limitations,
outcome totals, each survivor, baseline comparison, and assurance evidence.
Baseline comparison lists the exact new and resolved survivor IDs as well as
their counts. Generated count must equal all normalized outcomes, survivor count
must match the survivor records, and every new ID must resolve to a current
survivor.

## Provider ports

`CodeGraphProvider` returns evidence-qualified project summaries and change
impact, including confidence and limitations.

`MutationTestingProvider` determines support, runs a provider-neutral request,
and may return a non-authoritative classification candidate.

Neither interface mentions GitNexus, PIT, Stryker, MCP, files, shell commands, or
CI. Implementations are deferred.
