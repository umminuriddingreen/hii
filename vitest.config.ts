import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Every test runs unless it is quarantined below.
 *
 * This file used to carry a hand-listed `include` allowlist of 12 files. 90 test
 * files existed, so `npm run test` — and therefore `ci:fast`, `ci:full` and
 * `ci:release-candidate` — exercised 13% of the suite and reported green. Worse,
 * a newly written test did nothing until someone remembered to add its path
 * here, so the default state of a new test was "never runs".
 *
 * The allowlist was a workaround for the CLI-first cutover (ADR 004) and the
 * Next.js static-export move, which together deleted the SvelteKit routes and
 * the `app/api/*` route handlers that ~30 contract tests assert the existence
 * of. Those tests describe architectures the product no longer has. They are
 * quarantined here — visibly, with a reason — rather than silently omitted, so
 * the cost of the cutover stays on the books until each one is rewritten
 * against the current architecture or deliberately dropped.
 */

/** Tests asserting SvelteKit routes/components deleted by the Next.js cutover. */
const svelteKitFossils = [
  'tests/unit/activate-wizard-contract.test.ts',
  'tests/unit/agentic-workspace-contract.test.ts',
  'tests/unit/board-quality-boundary.test.ts',
  'tests/unit/capability-surface-parity.test.ts',
  'tests/unit/download-release-contract.test.ts',
  'tests/unit/hii-ecosystem-contract.test.ts',
  'tests/unit/hii-hud-contract.test.ts',
  'tests/unit/hii-logo.test.ts',
  'tests/unit/hii-os-overlay-contract.test.ts',
  'tests/unit/hii-remote-auth.test.ts',
  'tests/unit/install-route.test.ts',
  'tests/unit/knowledge-api-parity.test.ts',
  'tests/unit/learner-page-contract.test.ts',
  'tests/unit/native-browser-contract.test.ts',
  'tests/unit/next-server-compat.test.ts',
  'tests/unit/pilot-page-contract.test.ts',
  'tests/unit/public-homepage-contract.test.ts',
  'tests/unit/skill-replay-contract.test.ts',
  'tests/unit/svelte-route-parity.test.ts',
  'tests/unit/terminal-style-contract.test.ts',
  'tests/unit/web-docs-contract.test.ts',
  'tests/unit/workspace-followup-contract.test.ts',
  'tests/unit/workspace-viewers-contract.test.ts'
];

/** Tests asserting `app/api/*` handlers that `output: 'export'` cannot have. */
const apiRouteFossils = [
  'tests/unit/hii-browser-sync.test.ts',
  'tests/unit/hii-memory-api.test.ts',
  'tests/unit/terminal-stream-lifecycle.test.ts'
];

/**
 * Tests naming `scripts/hii-svelte-tauri-build.mjs`, the packaging script the
 * cutover replaced with the 33-line `scripts/hii-tauri-build.mjs`. The invariant
 * that mattered — the packaged app can actually reach what it shells out to —
 * is enforced against the current packaging by
 * `tests/unit/packaged-cli-closure.test.ts`.
 */
const packagingFossils = [
  'tests/unit/desktop-cross-platform-contract.test.ts',
  'tests/unit/packaged-app-release-contract.test.ts'
];

/** Written for `node --test`, not vitest; they import `node:test`. */
const nodeTestRunner = ['tests/codex-memory-context.test.mjs', 'tests/remote-test-gateway.test.mjs'];

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
    conditions: ['browser']
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      '**/archive/**',
      ...svelteKitFossils,
      ...apiRouteFossils,
      ...packagingFossils,
      ...nodeTestRunner
    ],
    passWithNoTests: false,
    restoreMocks: true
  }
});
