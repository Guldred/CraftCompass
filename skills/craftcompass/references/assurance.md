# Change assurance and agent instructions

Use the exact `<supported-node>` and `<launcher>` bindings established by
`SKILL.md` for the entire workflow. Run `<launcher>` from the target repository
root. Prefer absolute paths so the trusted installed CraftCompass package and
the untrusted target remain unambiguous.

## Change-specific assurance

Require validated project, assurance-profile, change-context, and
already-normalized change-impact artifacts:

```text
<launcher> run assurance plan \
  <plan-id> \
  <project-id> \
  <assurance-profile-id> \
  <change-context-id> \
  <change-impact-id> \
  <absolute-artifact-or-directory>...
```

Treat the resulting `assurance_plan` as the authority for actual review and
gates. Without one, use Review Level 0. Preserve degraded graph evidence and
fallback limitations; centrality and clusters are signals only.

The current CLI consumes supplied normalized impact; it does not inspect a
live diff or query GitNexus. Do not imply that it did.

## Agent instructions

Render without writing:

```text
<launcher> run instructions render \
  <project-id> \
  <assurance-profile-id> \
  <absolute-artifact-or-directory>...
```

Check an existing target file without writing:

```text
<launcher> run instructions check \
  <absolute-target-root> \
  <project-id> \
  <assurance-profile-id> \
  <absolute-artifact-or-directory>...
```

Only after explicit authorization, create a missing file:

```text
<launcher> run instructions install \
  <absolute-target-root> \
  <project-id> \
  <assurance-profile-id> \
  <absolute-artifact-or-directory>...
```

Never replace or merge an existing `AGENTS.md` automatically. Report
`human_owned`, drift, and conflicts as human reconciliation work.
