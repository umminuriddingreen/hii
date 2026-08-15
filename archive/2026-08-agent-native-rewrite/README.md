# HII agent-native rewrite archive

Archived on 2026-08-14 during the decisive desktop cutover.

The active product is now a statically exported Next.js + React canvas hosted
directly by Tauri, with local state and agent execution exposed through Rust
commands. Nothing in this directory is part of the active build.

## Contents

- `legacy-svelte/`: the former SvelteKit application and Vite configuration.
- `legacy-tauri-node/`: the packaged Node server and its Tauri bootstrap scripts.
- `legacy-next-api/`: API routes from the former Next.js control plane.
- `prototypes/`: snapshots of the earlier control-plane and React canvas work.
- `capability-packs/`: useful specialist surfaces removed from the default
  product, including browser sync, workstation UI, terminal/browser/board nodes,
  other canvas widgets, and the rejected ambient/notch surface.
- `deferred-cloud/`: support and payment surfaces outside the local-first core.

Restore a capability only after it has a concrete agent-configurable use case,
a versioned Rust boundary, and a focused verification path. Do not import this
directory from active application code.

Generated workstation `target/`, `node_modules/`, and `dist/` directories were
intentionally omitted; lockfiles and source remain sufficient to rebuild them.
