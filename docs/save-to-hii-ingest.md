# Save to HII: canonical local ingest

Save to HII is an explicit local capture operation. It is not publishing,
sharing, browser-history collection, or a public link-stream write.

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

## Current transport gap

`extensions/chrome-link-capture` still posts the legacy URL/title/note shape to
the Next.js-oriented `/api/links` endpoint. `scripts/hii-link-cache.mjs` also
reads checkout-local `.hii/link-posts.jsonl`. Those are link feed/cache and
optional publish prototypes; they are not the canonical Save to HII authority.

The next transport change should preserve the command above as the authority:

1. Add a small native-messaging host whose only mutation is spawning
   `hii info ingest-web --json` and passing one bounded payload over stdin.
2. Change `extensions/chrome-link-capture/background.js` and `popup.js` to build
   the documented payload and call that host.
3. Change `manifest.json` to declare the native-messaging permission and remove
   public-site host permission from the default capture path.
4. Change `options.js`/`options.html` so publishing endpoints and tokens are not
   Save to HII settings.
5. Add extension payload tests plus a native-host-to-CLI smoke using an isolated
   `HII_RUNTIME_DIR`.

Native messaging is preferred over inventing another long-lived daemon or
making a development web route authoritative. A loopback HTTP adapter can be
added later as a projection if HII already has a supervised local service, but
it must call this same core function and must not become a second store.

Canvas placement is intentionally separate. The canonical source can already
be found and inspected; a later inbox or `canvas_add` action should reference
its stable source ID and produce its own Runtime Space receipt. Capture must not
silently choose or mutate a canvas.

Publishing remains the explicit `hii links publish` family until it is migrated
to select canonical capture objects. It is never invoked by local ingest.
