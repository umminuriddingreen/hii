# Umbrel As A HII Browser Service Target

## Goal

Expose the Umbrel VM to HII as a browser-first service target.

This is not the Windows desktop control path.
It is the service path for the Umbrel interface itself.

## Current Target

- Umbrel Tailscale IP used in HII: `100.89.181.23`
- HII remote target name: `umbrel`

Registered in HII as:

```bash
cd /Users/ummi/hii
node dist/cli.js remote windows add \
  --name "umbrel" \
  --provider custom \
  --url "http://100.89.181.23"
```

## How To Use It

Once the Umbrel VM is online, open it through HII with:

```bash
cd /Users/ummi/hii
node dist/cli.js remote windows session umbrel --port 8787
```

Direct pane URL:

```text
http://127.0.0.1:8787/remote.html?remote=umbrel
```

## What To Do On The PC

1. Open Hyper-V Manager
2. Start the Umbrel VM
3. Wait for Umbrel to fully boot
4. Confirm Umbrel opens locally on the PC:
   - `http://umbrel.local`
   - or the VM IP
5. Confirm the Umbrel node is online in Tailscale
6. If the IP changed, update the HII target

## Important Distinction

- Umbrel = browser-accessible service target
- Windows host = SSH / Codex control target

Use Umbrel for service access.
Use the Windows host for command execution and Codex routing.

## If The Pane Fails

Check these first:

```bash
tailscale ping 100.89.181.23
```

If that fails:

- the Umbrel VM is off
- Tailscale inside Umbrel is offline
- or the IP changed
