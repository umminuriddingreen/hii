# HII Spaces production topology

Status: preview deployed; production routes not attached.

## Current production site

- Cloudflare account: `Ummingreen@icloud.com's Account`
- Account ID: `3294b5b71adf18c2e93bf7dde5c305b5`
- Zone: `humaninformationinterface.com`
- Zone ID: `688bed392f9b3c3806f89898c42704f2`
- Apex and `www` are Custom Domains of Worker `hii`.
- Current deployment ID: `99292d0c-ec81-4f3d-aadd-f41beb9d9d2c`.
- Active version: `3c18cff3-137c-4873-b425-c715fb32783a` at 100% traffic.
- No zone-pattern Worker routes currently exist.
- The live artifact is from the archived SvelteKit application family. Its exact
  Git commit is not present in Cloudflare deployment metadata.
- Root `wrangler.jsonc` describes the historical `hii` Worker but its build
  paths are stale. It is not the Spaces deployment configuration.

The existing homepage Worker is not modified, redeployed, proxied, or replaced
by T13.

## Worker ownership

| Surface | Worker | Authority |
| --- | --- | --- |
| Existing production origin | `hii` | Current homepage and all existing paths |
| Preview | `hii-spaces-public-preview` | Read-only fixture projection on workers.dev |
| Proposed production routes | `hii-spaces-public` | Spaces-only public projection, currently fail-closed |

The Spaces Worker has no Workspace, terminal, agent, filesystem, model,
operator, R2, KV, D1, service, secret, or environment binding. The local HII
node remains authoritative. A later public resolver may expose only a validated,
derived, replaceable read projection for explicitly published Spaces.

## HII Spaces preview

- URL: `https://hii-spaces-public-preview.ummingreen.workers.dev`
- Current version: `d07bd351-92b9-4b10-a022-587203256858`
- Preview fixture: `14th-street`, immutable and read-only.
- Policy: `PUBLIC READ / LOCAL WRITE`.
- Active config: `workers_dev=true`, `preview_urls=true`, no routes, no custom
  domains, and no bindings.

The fixture proves routing and presentation only. It is not a canonical Space,
publication directory, replica, or cloud write store.

## Proposed production routes

```text
https://humaninformationinterface.com/spaces
https://humaninformationinterface.com/spaces/*
https://humaninformationinterface.com/new
https://humaninformationinterface.com/new/
https://humaninformationinterface.com/s/*
```

Do not use `/spaces*`, `/new*`, or `/s*`. Cloudflare wildcards match arbitrary
characters and those patterns can capture unrelated paths. Exact `/new/` is
listed separately; `/spaces/*` covers `/spaces/` and descendants. `/s/*` covers
the canonical Space address and any explicitly supported subordinate path.

The Worker independently allowlists methods and paths. Unknown `/spaces/*`
children receive a Worker-owned `404`. Unsupported and privileged paths receive
safe errors and are never forwarded to private HII surfaces.

## Route precedence and collision matrix

Cloudflare zone Routes take precedence over a Worker Custom Domain on the same
hostname; the most-specific matching route wins. With the proposed set:

| Request | Owner after activation |
| --- | --- |
| `/` | existing `hii` Worker |
| `/about` | existing `hii` Worker |
| `/existing-valid-path` | existing `hii` Worker |
| `/spaces` | Spaces Worker |
| `/spaces/` | Spaces Worker |
| `/spaces/example` | Spaces Worker, owned `404` unless implemented |
| `/new` | Spaces Worker |
| `/new/` | Spaces Worker |
| `/s/<spaceId>` | Spaces Worker |
| `/s/<spaceId>/...` | Spaces Worker, strict validation/`404` unless supported |
| `/random-existing-path` | existing `hii` Worker |

Exact Cloudflare patterns do not capture query-string variants. The Worker also
rejects queries on routes it receives to prevent invite-token, cache-key, and
resolver ambiguity. Production activation must recheck query fall-through
against the existing Worker.

## DNS and Pages

- Public DNS resolves to Cloudflare anycast A and AAAA addresses.
- Authenticated enumeration of individual DNS records failed with Cloudflare
  error `10000` under the current OAuth grant. No DNS mutation is required.
- The account has one unrelated Pages project, `umminuriddingreen`; it has no
  HII domain and is not involved in this topology.

## Build and deployment commands

Preview validation and deployment:

```sh
npm --prefix workers/spaces-public install
npm --prefix workers/spaces-public run typecheck
npm --prefix workers/spaces-public test
npm --prefix workers/spaces-public run build
npm --prefix workers/spaces-public exec -- wrangler deploy --config wrangler.jsonc
```

Production dry run, safe now:

```sh
npm --prefix workers/spaces-public run build:production
```

Exact production action awaiting separate owner approval:

```sh
npm --prefix workers/spaces-public exec -- wrangler deploy --config wrangler.production.jsonc
```

Do not run the production command until a reviewed real resolver replaces the
fail-closed resolver and the owner explicitly authorizes route attachment.

## Rollback procedure

The homepage does not depend on the Spaces Worker. Rollback is route removal:

1. Remove only the five `hii-spaces-public` zone Routes through Cloudflare or
   deploy a reviewed configuration with those routes removed.
2. Confirm the zone route list no longer contains the five patterns.
3. Probe `/`, `/about`, `/spaces`, `/new`, and `/s/test` and confirm all requests
   again reach the existing `hii` Custom Domain Worker.
4. Delete the `hii-spaces-public` Worker only after route removal is proven.

Never modify DNS, the `hii` Worker, its Custom Domains, its bindings, or the
archived homepage deployment during rollback.

## Dependency advisory analysis

The standalone Worker pins Wrangler `4.124.0` in its own lockfile and its
package audit reports zero vulnerabilities. Neither preview nor production
bundle contains Next, PostCSS, nanoid, Miniflare, Undici, or Node runtime code.
The root Next/PostCSS/nanoid advisories therefore do not block this Worker
preview. They remain a separate root-application remediation task and must not
be hidden by this conclusion.

## Physical acceptance still required

Local, same Wi-Fi:

1. Start HII on the Mac with explicit LAN mode and create one Space.
2. Scan its QR from iPhone A and join without an account.
3. Open the same Space from iPhone B.
4. Upload/take a photo, add text/sticker/drawing, move an object, and verify
   immediate propagation.
5. Disconnect public internet while retaining Wi-Fi; verify both phones can
   still write locally.
6. Restart HII and confirm identity, objects, and policy persist.

Remote, cellular:

1. Explicitly publish the local Space.
2. Turn iPhone Wi-Fi off and cellular on.
3. Open the stable public URL and verify the published projection loads.
4. Verify remote reads succeed and create/move/delete/upload requests fail.
5. Verify local participants remain able to write.

These steps are not complete until performed on physical devices.

## Known risks and blockers

- Production Space resolution is intentionally fail-closed until a validated,
  provider-neutral resolver is implemented and reviewed.
- Exact deployed source revision for the current homepage is unknown.
- Individual DNS record enumeration is unavailable with the current OAuth grant.
- Physical two-phone and real cellular/publication tests remain unperformed.
- Production route attachment remains explicitly unauthorized.

