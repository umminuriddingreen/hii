# Save to HII: canonical local ingest

Save to HII is a local capture operation. A user can save one page explicitly
or opt into continuous page indexing in the extension Options. It is not
publishing, sharing, browser-history import, or a public link-stream write.

## Canonical path

```text
explicit extension action
-> hii.web.capture JSON
-> hii info ingest-web --input - --json
-> hii-core information authority
-> ~/.hii/hii.db + content-addressed payload blob
-> local HII receipt under ~/.hii/runs/cli
```

`hii info ingest-web` accepts one payload on standard input by default, or from
`--input PATH`. The Rust runtime validates the contract, accepts only HTTP(S)
sources, requires `authority.localOnly: true`, computes the content and payload
hashes, and stores the result in the existing canonical information database.
`captureId` is an idempotency key: replaying the same payload returns the first
receipt, while reusing the ID for different content is rejected.

The captured source is written to `information_sources` and
`information_versions`, so existing `hii info find`, `hii info inspect`, and
context tooling can use it. Capture-specific provenance is retained in
`information_web_captures`; the exact accepted payload is also stored as a
content-addressed blob under `~/.hii/information/blobs/`. The completed receipt
records the capture ID, method, client, source ID, content hash, and local-only
authority.

Example:

```sh
printf '%s\n' '{
  "schemaVersion": 1,
  "kind": "hii.web.capture",
  "capturedAt": "2026-09-12T20:00:00Z",
  "captureId": "extension-generated-uuid",
  "source": {
    "url": "https://example.com/article",
    "title": "Useful article",
    "siteName": "Example",
    "mediaType": "text/plain"
  },
  "capture": {
    "method": "context-selection",
    "selectedText": "Explicitly selected evidence.",
    "note": "Use in the brief",
    "tags": ["research"]
  },
  "authority": {
    "client": "chrome-extension",
    "localOnly": true
  }
}' | hii info ingest-web --json
```

If `content.text` is present it is the indexed captured content. Otherwise HII
uses `capture.selectedText`, then `capture.note`, then an empty reference body.
If the sender provides `content.contentHash`, HII verifies it against that
chosen text before writing anything.

## Browser extension transport

`extensions/chrome-link-capture` builds the documented `hii.web.capture` payload
and sends it to Chrome native host `com.hii.save_to_hii`. The host lives at
`scripts/hii-chrome-native-host.mjs`; its only mutation is spawning
`hii info ingest-web --input - --json` and passing one bounded payload over
stdin. The extension default path no longer posts captures to a public-site or
checkout-local link endpoint.

Install the local development native host with:

```sh
node scripts/hii-chrome-native-host-install.mjs
```

The installer writes a platform launcher plus a native-host manifest template.
Register that manifest with Chrome after replacing the unpacked extension ID
placeholder with the installed extension ID. Native messaging is preferred over
inventing another long-lived daemon or making a development web route
authoritative. A loopback HTTP adapter can be added later as a projection if HII
already has a supervised local service, but it must call this same core function
and must not become a second store.

Canvas placement is intentionally separate. The canonical source can already
be found and inspected; a later inbox or `canvas_add` action should reference
its stable source ID and produce its own Runtime Space receipt. Capture must not
silently choose or mutate a canvas.

## Continuous rendered-page indexing

The same Chromium extension can index the rendered text of ordinary HTTP(S)
pages in Chrome or a compatible Chromium browser such as Helium. In Options,
the user must explicitly enable indexing and grant website access. Pause
unregisters the script and removes its host permissions. The extension does not
index private windows, internal URLs, sign-in/payment pages, pages containing
password or card-number fields, or form and editable contents. A page is sent
after it settles and at most once every 20 seconds while its visible text
changes. The local HII store keeps distinct content versions and searches the
latest one with `hii info find`.

The page-index payload includes the configured browser label and transient tab
ID for provenance. The URL saved for continuous indexing omits credentials,
query parameters, and fragments.

This implementation uses Chromium native messaging registration. On macOS,
`node scripts/hii-chrome-native-host-install.mjs --browser helium --extension-id ID`
registers the host in Helium's observed `net.imput.helium/NativeMessagingHosts`
profile; use `--browser chrome` for Chrome. Replace `ID` with the installed
extension ID from that browser. Safari needs its own
packaged WebExtension and is not covered by this Chromium package.

The account snapshot transport is available separately at
`/api/browser-snapshots`. It stores an opaque client-encrypted envelope in a
private R2 prefix and an account-scoped D1 manifest. A paired device uses its
existing HII chat ECDH key to unwrap the content key. Clients can build a local
search index after decryption. `lib/web/browser-snapshot-sync.ts` exposes upload,
incremental pull, and deletion helpers. The account quota is 1 GiB; exceeding
it rejects new uploads without deleting local data. Deletion emits a manifest
tombstone and removes the encrypted blob. When the Mac has an HII account-device
link, the native messaging host automatically encrypts each successfully
indexed page and uploads it with the linked device token. Its private ECDH key
is stored locally with mode `0600`; the server receives only public keys and
ciphertext. If the Mac is not linked, indexing remains local. The signed-in
website can call `searchSyncedBrowserSnapshots` to pull and decrypt snapshots
into its own IndexedDB and search their text locally. A browser device added
after a snapshot was uploaded cannot yet decrypt that older snapshot because
key rewrapping is not implemented. There is no website live-browser relay in
this change.

Publishing remains the explicit `hii links publish` family until it is migrated
to select canonical capture objects. It is never invoked by local ingest.
