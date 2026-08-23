# HII Spaces public Worker

Independent, preview-only public read surface for HII Spaces.

Owned routes:

- `GET|HEAD /spaces`
- `GET|HEAD /spaces/*` (unknown children are owned 404s)
- `GET|HEAD /new`
- `GET|HEAD /new/`
- `GET|HEAD /s/:spaceId`

Everything else returns `ROUTE_NOT_OWNED` with
`X-HII-Fallback: route-scoped-upstream`. Production must attach only the exact
patterns in `routes.production.json`; that manifest is deliberately disabled.
The existing homepage and Workspace origin remain authoritative.

The checked-in resolver is a non-secret preview fixture. It is not a cloud
Space store and never accepts writes, uploads, operator actions, guest tokens,
or runtime authority. A production resolver must implement
`PublicSpaceResolver` and return only `PublicSpaceProjection` after publication.

Local verification:

```sh
npm run types
npm run typecheck
npm test
npm run build
npm run build:production
```

## Production approval gate

**DO NOT RUN THE FOLLOWING DEPLOY COMMAND WITHOUT EXPLICIT OWNER APPROVAL.** It
immediately attaches the five production routes to `hii-spaces-public`:

```sh
./node_modules/.bin/wrangler deploy --config wrangler.production.jsonc
```

Before an approved deploy, record the current production version with
`./node_modules/.bin/wrangler versions list --name hii-spaces-public`. If the
new version must be rolled back, immediately run:

```sh
./node_modules/.bin/wrangler rollback <PREVIOUS_VERSION_ID> --name hii-spaces-public --config wrangler.production.jsonc
```

Rollback changes code but preserves configured routes. If this is the first
activation and no previous version exists, remove the five routes in the
Cloudflare dashboard to restore the existing origin, then delete the failed
Worker only with separate owner approval. Never add a production resolver or
binding until its public-read contract has been reviewed and approved.
