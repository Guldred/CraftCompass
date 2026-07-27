# Security policy

CraftCompass processes repository files, YAML artifacts, XML reports, provider
evidence, and generated instructions. Treat all of those inputs as untrusted.
The project is pre-release and is not itself a security control or sandbox.

## Supported versions

There are no published releases yet.

| Version           | Support                                    |
| ----------------- | ------------------------------------------ |
| Current `main`    | Best-effort security fixes during pre-1.0  |
| Published release | None; no release has been published so far |

Security fixes may change the unreleased schema-v1 contract when that is needed
to fail safely.

## Reporting a vulnerability

Do not include exploit details, secrets, or sensitive repository data in a
public issue.

Use GitHub's private vulnerability-reporting flow when it is available from the
repository's Security tab. Until the maintainers publish another concrete
private contact, do not send exploit details when that flow is unavailable.
Open a public issue containing only a request for a private reporting channel,
or wait for a secure channel to be published.

Include:

- the affected commit and component,
- impact and realistic attack prerequisites,
- minimal reproduction steps or a safe proof of concept,
- whether untrusted local files, repository content, or provider data is
  involved,
- a suggested mitigation, if known,
- any disclosure deadline or prior disclosure.

Do not test against systems or data you do not own or have permission to use.
The project cannot promise a response SLA before maintainership and release
processes are formalized, but reports should be acknowledged and triaged as
soon as practical.

## Current trust boundaries

### Local files and repositories

Repository roots, artifact paths, PIT reports, and generated-file targets may
be hostile. Security-sensitive readers use explicit byte limits, strict UTF-8
where text is expected, regular-file checks, no-follow opens, repository
containment, and identity checks around reads and writes. Managed writes use
same-directory exclusive temporary files and atomic replacement semantics.

These hardened filesystem operations currently support Linux and macOS. They
fail closed on Windows because the required no-follow, directory-handle, and
directory-synchronization guarantees do not yet have an equivalent tested
implementation.

Those controls reduce common traversal, symlink, special-file, oversized-input,
and race risks. They do not make CraftCompass a malware scanner or operating
system sandbox. Do not run the CLI with broader filesystem permissions than the
task requires.

### Structured input

Artifact YAML is selected by explicit schema version and kind, validated with
strict Zod schemas, and loaded with traversal and aggregate budgets. PIT XML is
bounded and rejects DTDs, entity declarations, processing instructions, CDATA,
unknown record fields, and unsupported statuses.

Parser success proves only that input satisfies the modeled contract. It does
not establish that an observation or provider claim is true.

### Evidence and assurance

Provider results are evidence, not instructions or verdicts. Synthetic graph
evidence is test-only. Missing, degraded, partial, stale, or incomparable
evidence must remain visible and cannot silently authorize reduced review.
Review Levels 0–2 are supported; Level 3 is not.

A PIT execution attestation is supplied by the caller. Its plan, scope,
configuration fingerprint, version, and evidence bindings are checked
structurally, but it is not signed and does not independently prove execution.
Active-baseline comparison requires the exact same first-class configuration
fingerprint and complete scope. Mutation evidence still does not prove
requirements, correctness, security, architecture quality, or production
fitness.

### Generated instructions

Repository and artifact text is untrusted display data. The deterministic
instruction renderer excludes provider/evidence prose, escapes Markdown and
control syntax, and bounds output. Installation creates a missing managed file
but refuses to overwrite an existing human-owned, foreign, unsupported, or
drifted `AGENTS.md`.

Generated instructions are guidance, not an authorization boundary. They cannot
override a change-specific assurance plan, a human decision, repository access
controls, or the user's requested scope.

## Secrets and dependencies

Never place credentials, access tokens, private keys, production data, or
proprietary source/report contents in fixtures, logs, issues, or pull requests.
Use synthetic minimal fixtures for parser and security regression tests.

Dependency changes must update the lockfile intentionally and pass the
repository's dependency review and `pnpm check`. Pin automation actions and
tools to reviewed versions. Report a vulnerable dependency privately when
public disclosure would expose an immediately exploitable project path.

## Coordinated disclosure

Give maintainers a reasonable opportunity to investigate, prepare a fix, add a
regression test, and communicate affected versions before public disclosure.
Once a fix is available, the project should publish a concise advisory that
credits the reporter when requested and does not expose private data.
