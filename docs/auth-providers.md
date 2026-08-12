# HII local login and account providers

HII is local-first and does not require Supabase or any hosted identity service
for core use. The canonical HII user is a local profile and device/session
boundary stored under the user's own `~/.hii` runtime.

Use:

```sh
hii login local --name "Ummi"
hii login status
hii login clear
```

`hii login local` writes a private local identity file. It does not create a
cloud account, enable sync, read email, read browser history, or grant any model
new source permissions.

## Identity model

HII separates three things:

- **Local HII login**: who owns this local workspace, receipts, device grants,
  and profile.
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

Future browser, email, and calendar connectors should follow the same local
contract: authenticate only when needed, store the minimum local grant state,
and require a separate source selection before model use.

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
