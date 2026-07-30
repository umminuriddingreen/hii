# Arry public HII test

This is a disposable shared HII session served from the M3 Max through
Tailscale Funnel. The unguessable URL opens directly into exactly two equal
panes:

- a live bare HII terminal
- the latest locally verified artifact

Wide screens place the panes side by side. Portrait screens stack them
top-to-bottom.

## Start

Build the release CLI, make sure Tailscale and Ollama are running, then start
the test:

```sh
cargo build --manifest-path cli/Cargo.toml --release
node scripts/hii-remote-test.mjs start
```

The start command checks that:

- the release HII binary exists
- Tailscale is connected
- Funnel ports 443 and 8443 are unused
- the two loopback ports are unused
- `qwen3.6:35b-mlx` is available from loopback Ollama
- a local Chrome-family browser is available for artifact verification

It prints the unguessable public URL only after both Funnel routes and the
gateway are ready.

## Session boundary

The PTY launches:

```text
hii --cwd <session-workspace> --model qwen3.6:35b-mlx --session-profile public-test
```

It is launched directly under a generated macOS sandbox profile, never through
a login shell. HII can invoke installed command-line tools from the Mac's
sanitized `PATH`, including tools that use normal outbound network access.
Credential-like environment variables and the rest of the host home directory
are unavailable. The disposable workspace and isolated HII runtime are the
only writable session locations. Deletion is denied.

Every browser that opens the unguessable URL joins the same live terminal and
artifact stream. Browser messages have per-client size and rate limits. The
90-second shutdown window begins only after the last viewer disconnects.

## Artifacts

HII publishes candidate output under:

```text
<session-workspace>/public/
```

The gateway rejects traversal, dotfiles, and symlinks. HTML is served to local
headless Chrome over HTTP and is published only after it returns HTTP 200,
loads required assets without browser errors, renders visible DOM or canvas,
and produces a screenshot. Artifact pages use a separate Funnel origin, so
generated JavaScript cannot access the terminal connection.

## Stop and recover

```sh
node scripts/hii-remote-test.mjs status
node scripts/hii-remote-test.mjs stop
```

A disconnected tester has 90 seconds to reconnect to the same PTY. After the
grace period, or after `stop`, the gateway terminates HII and removes only the
two Funnel routes it created. It preserves the workspace, runtime, transcript,
events, manifest, artifact records, verification reports, and screenshots
under:

```text
~/.hii/remote-tests/<session-id>/
```
