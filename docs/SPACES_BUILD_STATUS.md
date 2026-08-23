# HII Spaces Build Status

## CURRENT MILESTONE

Local MVP through T12 integrated. T13 preview deployed and verified; production
routes remain unattached and await a real resolver plus explicit owner approval.

## COMPLETED

- T1 canonical Space identity record and durable record store.
- Claude repository audit and Spaces architecture, gap analysis, and implementation plan.
- T2 Space-only host with loopback-safe default, explicit physical-interface LAN mode, CIDR peer enforcement, Host allowlisting, and bounded read-only routes.
- T3 additive Space fields and object mappings on the existing `WorkspaceNode` model.
- Independent adversarial LAN boundary review with no remaining T2 blocker.
- Real-interface same-machine smoke through `en0` at `100.100.86.2/25`.
- T4 safe local image upload, retrieval, opaque references, quotas, rate limiting, metadata stripping, and internal deletion capability.
- T5 reduced touch-oriented Space surface over the existing canvas, with isolated per-Space browser state.
- Upload adversarial review; all three must-fix findings remediated.
- LAN upload, retrieval, host restart, and retrieval proof for the same blob.
- T6 host-authoritative realtime object channel with snapshot, incremental events, reconnect, presence heartbeat, idempotency, and bounded resources.
- T7 SIGKILL restart durability, Lamport continuation, concurrent convergence, corruption preservation, and shared Rust/TypeScript workspace locking.
- T8 guest identity and ephemeral participant presence.
- T9 four canonical policy modes enforced on HTTP, upload, and WebSocket boundaries.
- T10 queue-serialized process-local host controls and loopback operator API/UI.
- T12 stable access links and fully offline SVG QR generation.
- T11 provider-neutral explicit publication controller and exact-Space public listener, tested without external publication.

## IN PROGRESS

- T13 independent Worker package, route-collision tests, preview deployment, and
  Cloudflare ownership/topology proof.
- Physical-device and explicitly authorized real-publication validation.

## BLOCKED

- T13 production `/s/:spaceId` activation remains blocked on a reviewed real
  resolver and explicit production approval. Ownership and deployment path are
  proven.
- Later waves depend on Wave 1 integration and verification.

## AGENTS ACTIVE

- Lead: architecture integration, shared files, validation, and receipts.

## INTEGRATION STATUS

- T1 through T12 are integrated locally, excluding deferred T14-T17.
- T13 preview is deployed at
  `https://hii-spaces-public-preview.ummingreen.workers.dev` (version
  `d07bd351-92b9-4b10-a022-587203256858`). Production is not deployed.
- No physical second-device result has been observed yet.

## TEST STATUS

- `npm run test`: 88 files / 560 tests passed.
- `npm run build`: passed; 8 static pages generated.
- `npm run check` and `npm run lint`: passed sequentially after the build.
- `cargo build && cargo test` from `cli/`: passed; 386 tests.
- `npm run hii:spaces:check` and `npm run hii:workspace:check`: passed.
- `npm run security:secrets`: passed.
- Real-interface host smoke: `/s/lan-proof` and `/api/spaces/lan-proof` returned HTTP 200.
- Wave 2 real-interface smoke: image upload returned 201 and blob retrieval after host restart returned 200.
- `npm run hii:spaces:restart:check`: SIGKILL recovery preserved objects, positions, blob references, and Lamport order.
- Dual-listener smoke: created `14th-street`, opened operator and visitor shells, issued a guest session, kept visitor operator probe at 404, froze writes, restarted, and retained the frozen policy.
- T11 focused security gate: 7 files / 53 tests passed; no external Funnel action.
- `npm audit --omit=dev`: failed with high-severity advisories in current Next/PostCSS/Nanoid dependency lines.

## KNOWN RISKS

- A LAN listener expands exposure from one machine to peers on the selected physical subnet.
- Physical iPhone reachability and Wi-Fi client-isolation behavior remain unverified.
- The existing app shell remains Workspace-shaped until T5 provides the reduced Space surface.
- Whole-body upload buffering is bounded for LAN use but needs streaming or a global inflight cap before T11 publication.
- Space object state remains browser-local until T6 replaces the persistence adapter.
- Node atomic replacement lacks explicit file/directory `fsync`; power-loss durability is not proven.
- Physical two-device realtime remains unverified despite real WebSocket integration tests.
- Guest identities and participant removals do not survive host restart; old guest-owned objects become host-moderated but not editable by the returning guest identity.
- Plain LAN HTTP does not protect guest cookies from passive same-network interception.
- T11 currently publishes at most one Space per HII node.
- Live production is an archived-source SvelteKit Cloudflare deployment; active Wrangler config is stale and production Spaces routes are 404.
- Rust workspace writes remain unlocked while the TypeScript store uses file locking; concurrency reconciliation is deferred to T7 unless Wave 1 exposes a correctness issue.
- Physical-device reachability is not proven by localhost tests.

## NEXT DEPENDENCIES

- Replace the fail-closed production resolver with a reviewed provider-neutral
  published-Space resolver.
- Obtain explicit production approval before attaching the five reviewed routes.
- Run physical iPhone/Android and two-device LAN tests.
- Run an explicitly authorized real Funnel/cellular test.
- Plan a separately gated Next/PostCSS/Nanoid dependency remediation.
- Complete a physical second-device LAN smoke as soon as a phone is available.
