# ADR 0008: Attested mutation assurance

- Status: Accepted
- Date: 2026-07-26

## Context

PIT's `mutations.xml` records what a mutation process reported. By itself, the
file does not prove which assurance plan selected the run, which targets and
tests were configured, or whether the report is complete. Aggregate mutation
scores can also hide one consequential survivor.

CraftCompass needs a provider-neutral report, honest treatment of incomplete
execution, and like-for-like debt comparison before it executes mutation tools
itself.

## Decision

Import PIT XML offline; do not execute PIT in this slice. Read the report as a
bounded regular file and parse a strict UTF-8 XML contract. The parser:

- accepts at most 32 MiB, 10,000 mutations, 200,000 elements, and nesting depth
  32,
- rejects DTDs, entity declarations, processing instructions, CDATA, unsupported
  fields or statuses, inconsistent status metadata, malformed XML, and duplicate
  semantic mutation identities,
- maps every completed PIT status without dropping timeout or provider-error
  outcomes,
- computes stable mutation identities from normalized semantic fields.

Normalize outcomes as killed, survived, no coverage, timed out, or error.
PIT-reported equivalent mutations remain non-authoritative candidates requiring
human review. Survivors and no-coverage records remain actionable; timeout and
tool failures remain explicit rather than being counted as kills.

An import is decision-eligible only with caller-supplied execution attestation
that binds:

- the selected assurance-plan ID,
- the exact primary, supporting, and relevant-test scope,
- a lowercase SHA-256 configuration fingerprint,
- versioned PIT provenance,
- an evidence reference for the execution configuration.

Reject mutation targets outside the attested scope. Without the attestation,
normalize the report as partial and conditional. The attestation is a structured
caller assertion, not a cryptographic signature or independent proof that PIT
ran as claimed. The evidence reference is a pointer; the current CLI does not
verify the referenced evidence file's contents.

Mutation evidence may be `passed` only for a complete, non-empty, all-killed run
with matching tool/version provenance and an invocation binding. Partial and
zero-mutation runs, survivors, no coverage, timeouts, errors, missing tool
versions, or unresolved debt remain conditional.

Create mutation baselines automatically only as inert `candidate` artifacts.
Activation requires explicit human-decision evidence, an owner and review date,
an exact provider tool version, and a complete, non-empty source run with no
timeouts or errors. An active baseline can participate only in exact
project/profile, provider ID, tool version, normalization version, configuration
fingerprint, and complete mutation-scope comparison. The fingerprint is
first-class report and baseline identity and must match the mutation-run
execution binding.

Evaluate policy only from a complete validated artifact registry. The registry
must contain the current report and plan, the assurance profile and project, the
active baseline, and that baseline's source report. This proves modeled
provider, scope, source-run, debt, and exception consistency before comparison.
The same mutation ID must retain its immutable provider/operator/location
identity; identity drift is incomparable rather than unchanged debt.

Apply the `no_new_unexplained_survivors` policy to record-level debt deltas:

- incomparable or ineligible evidence is `inconclusive`,
- new unexplained, uncovered, unconfirmed, or expired-exception debt fails,
- unchanged accepted risk must retain the exact same machine-applicable
  exception and remains subject to current validity,
- a comparable run with no policy violation passes.

Mutation scores are context only and are never read as the policy decision.
CLI evaluation exits successfully only for `passed`; both `failed` and
`inconclusive` remain non-zero.

## Consequences

- No mutation can disappear inside a favorable aggregate score.
- Legacy debt can be baselined without making automatic generation an approval.
- Exact normalized records make new, unchanged, transitioned, and resolved debt
  auditable.
- An imported report is only as trustworthy as its caller, execution evidence,
  and retained provenance.
- PIT process execution, signed attestations, evidence-content verification,
  and other mutation providers remain later work.
