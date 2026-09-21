# HII account, local identity, and providers

The website is the canonical account and workspace boundary. The CLI and
installed app connect as named, revocable computers; they do not create a
second account or grant a browser hidden access to a local terminal.

To connect the CLI:

```sh
hii login
hii login status
hii login account-logout
```

`hii login` opens the HII website, asks the user to authenticate with a
passkey, and accepts a short-lived, single-use computer code. The resulting
device credential is written privately to `~/.hii/account/device.json`, the
same account projection used by the installed app. Avoid putting the code on
the command line or in shell history. Revoking the computer in the web account
invalidates its server credential; `hii login account-logout` only removes the
local copy.

HII remains local-first and does not require a hosted identity service for
core local work. A separate local identity labels local receipts and
operator-owned state:

```sh
hii login local --name "Ummi"
hii login clear
```

`hii login local` does not create a cloud account, enable sync, read email,
read browser history, or grant any model new source permissions.

## Identity model

HII separates three things:

- **HII account**: who owns synchronized workspaces and which computers or
  collaborators have explicit, revocable access.
- **Local HII identity**: who labels local-only workspace state and receipts.
- **Provider login**: an existing account such as Codex, Claude, Google,
  Gmail, Calendar, Chrome, GitHub, or another connector.
- **Capability/source grant**: the exact browser tab, email thread, calendar
  window, file, or tool boundary approved for a task.

Provider login is not source permission. Google login must not imply Gmail
access. Chrome presence must not imply full browser-history ingestion. Each
source enters HII through an explicit context selection, provenance record, and
receipt.

## Provider connectors

Provider connectors remain optional. HII may hand off to the official provider
login flow when the user asks, for example:

```sh
hii login codex
hii login claude
```

The installed HII app opens a real PTY-backed HII terminal on first run. The
terminal starts the bundled HII CLI, shows `/providers`, and accepts
`/login codex`; the resulting login is the same Codex-managed ChatGPT device
flow used by the CLI. Codex owns that OAuth session, token persistence, and
refresh lifecycle. HII never reads or copies Codex credential files. A
successful ChatGPT provider login powers Codex-backed work but does not
silently create an HII account, synchronize a canvas, or grant source access.

The web app keeps the same first-run access choices, but deliberately does not
receive the native terminal or impersonate Codex's OAuth client. Browser-only
users continue through the HII passkey account flow. ChatGPT provider sign-in
is completed in the installed HII app until HII has a separately approved
hosted ChatGPT authentication boundary.

Future browser and calendar connectors should follow the same local contract:
authenticate only when needed, store the minimum local grant state, and require
a separate source selection before model use. Email now has a narrow read-only
IMAP slice described below; it does not grant background or write access.

## Email (read-only)

HII can check multiple explicitly configured IMAP accounts without importing a
mailbox or changing provider state. Account metadata lives under
`~/.hii/mail/`; the provider password or app-password lives in the operating
system credential vault and never enters HII config, receipts, or command-line
arguments.

```sh
hii mail setup                         # interactive Gmail/iCloud picker
hii mail setup gmail                  # prompts for email + app password
hii mail setup icloud --email you@icloud.com
hii mail add --id personal --email you@example.com --provider gmail
hii mail add --id school --email you@example.edu --provider custom --host imap.example.edu
hii mail list
hii mail check                         # UNSEEN across every configured account
hii mail check --account school --query 'SINCE 1-Sep-2026 FROM professor@example.edu'
hii mail read --account school --uid 12345
```

`setup` is the preferred human path. It derives a stable local account id,
prompts for the email when omitted, and accepts the app password only through a
hidden terminal prompt. Agents can call `mail_accounts` and
`mail_setup_guide` to inspect linked account metadata or prepare the exact
setup command, but the user must enter the secret in a local terminal.

`gmail`, `icloud`, and `outlook` are host presets, not OAuth grants. They work
only when that provider/account permits an IMAP password or app-password.
Provider policies that require OAuth remain unsupported by this first slice and
must fail honestly rather than reuse a browser or Outlook session.

The agent-facing `mail_search` and `mail_read` tools use the same CLI-owned
implementation through `hii mcp`. A search call grants only its named account
(or the configured-account set), mailbox, query, and per-account limit. A read
call grants one exact account, mailbox, and UID. Both use IMAP `BODY.PEEK`, so
they do not mark a message read. HII records only the scope, query hash, UIDs,
actor, timestamp, and side-effect claim in `~/.hii/mail/receipts.jsonl`; message
subjects and bodies are not copied into the receipt ledger.

## Google

Google identity, Gmail, Calendar, and Drive are separate capabilities:

- Google identity can label a provider account.
- Gmail access is approved per search, thread, label, or time window.
- Calendar access is approved per calendar window or scheduled-work sync.
- Drive access is approved per selected file/folder.

Do not request broad scopes for local HII login. Add provider scopes only when a
specific connector needs them, and record the source grant in HII state.

## Apple and macOS

On macOS, the local HII login should eventually be unlockable through the user's
macOS account, Touch ID, and Keychain-stored device keys. That is still a local
identity boundary, not a hosted account requirement.
