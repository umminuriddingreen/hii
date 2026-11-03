# Satellite

Satellite lets HII communicate through a phone identity the user already owns.
It is a replaceable transport adapter; HII remains the authority, context,
policy, execution, and receipt layer.

The first transport is intentionally narrow:

```text
HII on Windows
  -> authenticated SSH session
  -> owner-only Unix socket on the Mac
  -> SatelliteBridge.app
  -> Messages / iPhone Text Message Forwarding
  -> user's existing carrier number
```

`SatelliteBridge.app` accepts only same-user local socket clients. It never
accepts a recipient in a request: every message and call is forced to the
locally paired owner number. Receipts contain outcomes, not the raw phone
number, message body, or guessable hashes of either value.

## HII permission boundary

Satellite is registered as two HII capabilities:

- `hii.satellite.message_send`
- `hii.satellite.call_start`

Inspect the combined HII, bridge, and macOS permission state:

```powershell
hii satellite status
```

Both actions cross an external communication boundary. `read-only` and
`workspace` deny them, `external-preview` asks the local operator, and
`external-commit` allows an explicitly authorized request. YOLO still asks; it
cannot bypass the communication approval floor. Calls additionally require a
fresh confirmation in the Mac bridge every time.

Message text is read from a private terminal prompt or stdin so it is not put
in the SSH process arguments:

```powershell
'wsp' | hii satellite send --authority external-commit
```

HII writes metadata-only receipts to
`~/.hii/satellite/hii-receipts.jsonl`. The Mac bridge retains its independent
transport receipt. Neither receipt claims carrier delivery without separate
verification.

## macOS prototype

Build and test on the Mac:

```bash
bash integrations/satellite/macos/scripts/build-app.sh
python3 integrations/satellite/macos/scripts/pair-owner.py \
  --app integrations/satellite/macos/.build/SatelliteBridge.app
open integrations/satellite/macos/.build/SatelliteBridge.app
```

The first message send causes macOS to ask whether Satellite Bridge may control
Messages. That approval is required and must not be bypassed.

The lower-level transport probe remains available for bridge development:

```powershell
powershell -File integrations/satellite/scripts/invoke-mac-bridge.ps1 `
  -Action message.send -Body "wsp"
```

A call handoff is more privileged and always shows a local confirmation in
`SatelliteBridge.app` before opening the system calling UI:

```powershell
powershell -File integrations/satellite/scripts/invoke-mac-bridge.ps1 `
  -Action call.start
```

`call.start` proves only that macOS accepted a handoff to the system calling UI.
It does not claim that the carrier call connected or that HII can access call
audio. Live autonomous call audio is outside this prototype's authority.

## Security boundary

- The SSH layer authenticates the Windows-to-Mac hop.
- The Unix socket directory is mode `0700`; the socket is mode `0600`.
- The bridge additionally checks the peer effective user ID.
- The paired owner number is sealed into the signed app bundle and loaded once
  at launch; it is never supplied by an invocation or reloaded from mutable
  runtime state.
- Requests are size-bounded, schema-checked, and idempotent by `request_id`.
- Message bodies and guessable body/phone hashes are not written to receipts,
  process arguments, or bridge logs.
- Calls require a local human confirmation in the bridge for every request.
- Unknown recipients, attachments, group messaging, inbound command execution,
  and background call audio are denied by design.
