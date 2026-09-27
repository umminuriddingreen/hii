# Security Policy

HII runs a local daemon with filesystem access, spawns PTYs, holds credentials by
reference, and executes agent-authored work. Treat vulnerability reports here as
high-signal.

## Reporting a vulnerability

**Email ug7@njit.edu.** Do not open a public issue for anything exploitable.

Include what you can: affected component (`runtime/daemon`, `cli/`, `server/`, a web
surface), version or commit, reproduction steps, and impact. If GitHub Security
Advisories are enabled on this repository, private advisory reports are also fine.

Expect an acknowledgement within 72 hours and an assessment within seven days.
Please give a reasonable window for a fix before public disclosure. There is no
bug bounty.

## In scope

- Local privilege escalation or arbitrary code execution via the daemon, the
  capability registry, the PTY gateway, or the CLI.
- Credential or secret exposure — leakage into PTY environments, logs, traces,
  receipts, or agent context.
- Authority bypass: running work without the required grant, or forging a
  receipt or verification result.
- Anything that lets a remote party reach a surface intended to be local-only.

## Out of scope

- Anything under `external/` — report those upstream to the vendoring project.
- Findings that require an attacker who already has your unlocked machine.
- Missing hardening headers on a `localhost`-bound development surface, absent a
  concrete exploit.

## Handling secrets

Secrets are reference-only in this repository — vault-backed, never inline. If
you find a committed credential, report it privately rather than opening a PR
that deletes it; the commit history needs rotating, not just the working tree.
`npm run security:secrets` runs the local scanner.
