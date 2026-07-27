# Mutation assurance

Use `<launcher>` to mean:

```text
node <skill-directory>/scripts/craftcompass.mjs
```

Run it from the target repository root. Prefer absolute artifact paths.

## Import attested PIT data

Require a validated plan with explicit mutation scope, caller-supplied tool
version, exact configuration fingerprint, and a repository-relative
configuration-evidence path:

```text
<launcher> run mutation import-pit \
  <report-id> \
  <assurance-plan-id> \
  <tool-version> \
  <sha256:configuration> \
  <configuration-evidence-path> \
  <repository-relative-mutations.xml> \
  <absolute-artifact-or-directory>...
```

The attestation is a caller assertion, not a cryptographic signature or proof
that PIT ran as claimed.

## Create a baseline candidate

Create only an inert candidate:

```text
<launcher> run mutation baseline create \
  <baseline-id> \
  <absolute-mutation-report.yaml>
```

Never add activation evidence or convert the candidate to active.

## Evaluate exact mutation policy

Evaluate a report and optional active baseline:

```text
<launcher> run mutation evaluate \
  <report-id> \
  <baseline-id-or-hyphen> \
  <assurance-profile-id> \
  <absolute-artifact-or-directory>...
```

Exit `0` means passed. Both failed and inconclusive return nonzero. Preserve
the stable reason codes and exact affected mutation IDs. Never reduce the
decision to a mutation score.

Treat partial, empty, unattested, incomparable, missing-baseline,
timeout-bearing, or error-bearing evidence as inconclusive. Treat expired
accepted-risk evidence as failed when the policy identifies it as applicable.
Do not retry by weakening validation, bypassing the launcher, following a
symlink, dropping evidence, or activating debt.
