# Repository assessment and candidate rules

Use `<launcher>` to mean:

```text
node <skill-directory>/scripts/craftcompass.mjs
```

Run it from the target repository root. Prefer absolute paths so the trusted
installed CraftCompass package and the untrusted target remain unambiguous.

## Read-only repository assessment

Use this as the default when the user asks to apply CraftCompass to a
repository but has not asked for files to be created.

1. Run `<launcher> doctor`.
2. Read applicable target instructions and inspect Git status.
3. Run:

   ```text
   <launcher> run project scan <absolute-target-root>
   ```

4. Treat the emitted `project_profile` as a candidate observation. Do not save
   it automatically.
5. Report detected technologies, modules, architecture-role evidence,
   confidence, assumptions, and limitations separately.
6. State that repository observation does not execute project code, inspect a
   live Git diff, or prove runtime architecture.

If the provider reports unknown or weak evidence, retain that result. Do not
fill gaps from convention or guesswork.

## Artifact and registry validation

Validate or inspect one artifact:

```text
<launcher> run validate <absolute-artifact.yaml>
<launcher> run inspect <absolute-artifact.yaml>
```

Validate connected artifacts:

```text
<launcher> run registry validate <absolute-artifact-or-directory>...
```

Prefer the exact connected artifact closure. Supply a directory only when all
of its artifacts intentionally form one registry. Use registry validation
before deriving policy from multiple artifacts. Resolve every wrong-kind,
missing, duplicate, ambiguous, scope-mismatched, or evidence-mismatched
reference. Do not suppress registry errors to continue.

When authoring or changing an unreleased schema-v1 artifact, trace every
consumer and update valid fixtures, invalid fixtures, registry behavior,
inspection, tests, and documentation together.

## Candidate rule derivation

Require a validated project profile and applicable knowledge artifact:

```text
<launcher> run derive dependency-direction \
  <project-id> \
  <absolute-principle.yaml> \
  <absolute-project-profile.yaml>
```

The result must remain a non-blocking candidate. Present its applicability,
scope, risk, evidence, confidence, existing-debt treatment, and unresolved
decisions for human review. Never edit `status` to `active` or make enforcement
blocking on the user's behalf.
