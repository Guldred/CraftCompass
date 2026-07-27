# Domain model

## Artifact contract

Every persisted artifact is a strict, versioned mapping with
`schema_version`, `kind`, and `id`. Schema version 1 supports:

| Artifact kind             | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `craftsmanship_principle` | Long-lived, contextual engineering principle                           |
| `practice_statement`      | Attributed practice, current position, experiment, or product decision |
| `project_profile`         | Evidence-aware project state and constraints                           |
| `change_context`          | Evidence-backed changed files and symbols                              |
| `change_impact`           | Normalized direct, indirect, flow, cluster, and test impact            |
| `project_rule`            | Contextual, traceable adaptation of principles                         |
| `assurance_profile`       | Project-wide verification and review policy                            |
| `assurance_plan`          | Change-specific verification and human-review requirements             |
| `mutation_report`         | Provider-neutral mutation outcomes and survivor evidence               |
| `mutation_baseline`       | Human-governed mutation-debt comparison point                          |

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

Detected `Technology` and `ProjectModule` records carry evidence directly.
Their lists may be empty for unsupported or malformed repositories; absence is
not replaced by an `Unknown` technology. Scanner-created modules are candidates
until a human confirms the boundary and its responsibilities. The optional
`ProjectModule.architecture_role` is a separate evidence-backed judgment:
business policy, technical adapter, mixed, or unknown. It has its own
candidate/confirmed status, confidence, observation references, and evidence.
A confirmed role must reference a project decision with human-decision evidence.

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

`ProjectProfile.adaptation_context` is optional and typed across delivery stage,
architecture scale, business criticality, architecture intent, and confidence.
It references observations inside the same profile and must reproduce their
evidence exactly. Repository scanning does not invent this context.

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

Activation is itself a human decision: every active rule carries
`human_decision` evidence. Every active exception does too. A generated
candidate or a file marker can never silently promote guidance or grant an
exception.

Every `ProjectRule` requires:

- one project reference,
- one or more principle references,
- one or more observation references inside that project,
- zero or more module references inside that project,
- exact project evidence contributed by referenced observations and modules,
- the risk being addressed,
- confidence,
- explicit scope and legacy-debt treatment,
- one or more enforcement configurations,
- exception governance,
- an optional migration strategy.

An AI review cannot be blocking unless its `authorization_decision_ref` resolves
to human-decision evidence on that rule. This implements the product brief's
prohibition on blocking builds solely through subjective AI judgment.

## Registry and deterministic adaptation

`createArtifactRegistry` consumes validated artifacts paired with logical
origins. It rejects:

- duplicate or ambiguous top-level artifact IDs,
- missing or wrong-kind project/principle references,
- missing project observations or modules,
- rule evidence that differs from evidence on those observations or modules,
- missing, ambiguous, or conflicting source references,
- conflicting definitions that reuse an evidence ID within its scope.

Entries and issues are sorted independently of input order. Identical repeated
nested evidence/source definitions are allowed. Artifact and source IDs are
global. Evidence IDs are project-scoped for project-connected artifacts and
artifact-scoped for standalone reports, so independent projects may use the
same local evidence ID without colliding.

The first pure derivation recipe handles only the active dependency-direction
principle. It consumes typed adaptation context rather than parsing prose. It
produces distinct greenfield, legacy, intentionally simple, or
`requires_decision` rules. Every generated rule has `status: candidate`, and
every enforcement option is non-blocking until a human accepts the rule.

## Exceptions

`ExceptionPolicy` governs whether exceptions are allowed and whether reason,
owner, and expiration are required. An active `RuleException` records:

- identifier,
- reason,
- owner,
- scope,
- optional machine-readable artifact and mutation selectors,
- expiration date,
- evidence.

Schema structure and expiration are separate concerns. The structural schema
checks the record; default artifact validation compares `expires_on` with an
injected reference date and rejects an expired exception. Mutation-policy
evaluation uses an explicit preservation mode only long enough to classify
applicable expired debt as a failed policy outcome instead of an unrelated
registry error. An expired exception never waives a rule or assurance
requirement. Schema version 1 interprets the reference date in UTC so the same
input and instant produce the same decision in every locale. An accepted-risk
mutation must use an exception whose mutation selectors explicitly include
that exact mutation ID; prose scope alone cannot waive it.

## Assurance

### Profiles and plans

`AssuranceProfile` records project-wide choices for:

- criticality and generated-code share,
- a maximum Review Level and review targets,
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

The configured profile level is a ceiling, not an automatic entitlement. A
change-specific plan may choose a lower level when risk, evidence quality, or
project readiness requires more human review. Generated instructions therefore
defer to the plan and require conservative Level 0 review when no plan exists.

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
killed | survived | no_coverage | timed_out | error
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

Each debt-bearing result also has a classification status. An equivalent value
can remain a candidate; it is not automatically approved. `unknown` must remain
unresolved. `accepted_risk` requires an accepted exception and explicit
exception reference.

A `MutationReport` preserves provider identity, tool and normalization versions,
target and test scope, scope confidence, limitations, execution completeness,
outcome totals, every mutation outcome, and assurance evidence. Generated count
must equal the exact partition of all normalized outcomes. A passed mutation
gate requires a complete, non-empty, all-killed run whose execution provenance
matches the report. A fingerprint-bearing report must identify a
`build_configuration` evidence reference from the same provider, so execution
strings alone are not structurally decision-eligible. The evidence pointer
remains a caller assertion, not cryptographic proof.

A `MutationBaseline` is either `candidate`, `active`, or `superseded`.
CLI-created baselines are always inert candidates. Activation requires human
evidence, a complete non-empty source report, exact source totals, no provider
errors or timeouts, and the tool version used. Comparison is allowed only when
project, profile, provider, versions, targets, tests, and scope are identical.
Missing or incomparable baselines produce an inconclusive decision rather than
silently accepting a run. Creation cannot be in the future, and activation
cannot predate creation or carry a future review date.

Policy evaluates exact mutation IDs and classifications. New unexplained debt
fails. Existing debt can remain only under its recorded classification and
governance; accepted risk must resolve to the same active, unexpired exception.
A score may be displayed as context but is never a decision input.

## Provider ports and adapters

`CodeGraphProvider` returns evidence-qualified project summaries and change
impact, including confidence and limitations.

`MutationTestingProvider` determines support, runs a provider-neutral request,
and may return a non-authoritative classification candidate.

Neither interface mentions GitNexus, PIT, Stryker, MCP, files, shell commands, or
CI.

`packages/providers-filesystem` is a separate repository-observation adapter,
not a code-graph or mutation provider. It maps bounded filesystem evidence into
`ProjectProfile` without exposing Node paths or parser types in the domain.

`packages/providers-pitest` parses bounded PIT XML and normalizes it into the
provider-neutral mutation model. A PIT source-file name is preserved as
provider data; it is not claimed to be a repository path unless a separate,
explicit resolution supplies one. Complete policy evidence additionally
requires caller attestation binding the import to an exact assurance plan,
scope, configuration fingerprint, version, and evidence location.
