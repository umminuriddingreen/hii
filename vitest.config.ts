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
 * Fossil SvelteKit, API-route, and packaging tests were removed during the
 * core-surface cut. Current checks therefore run by default instead of living
 * behind a growing exclusion list.
 */

/** Written for `node --test`, not vitest; they import `node:test`. */
const nodeTestRunner = ['tests/codex-memory-context.test.mjs', 'tests/remote-test-gateway.test.mjs'];

export default defineConfig({
  plugins: [{
    // On Windows, Vite can hoist ESM imports ahead of a Node script's shebang
    // and then parse the shebang as an invalid mid-line token.
    name: 'strip-imported-node-script-shebang',
    enforce: 'pre',
    transform(source, id) {
      if (/[\\/]scripts[\\/].*\.mjs(?:\?.*)?$/.test(id) && source.startsWith('#!')) {
        return source.replace(/^#![^\r\n]*/, '');
      }
    }
  }],
  // tsconfig sets `jsx: preserve` for Next's own compiler, which leaves esbuild
  // unable to parse a `.tsx` test. Transforming JSX here keeps the app build
  // untouched while letting component tests run.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
    conditions: ['browser']
  },
  test: {
    environment: 'jsdom',
    // `.tsx` is included so a component test cannot be written and then
    // silently never run - the same failure mode the allowlist above caused.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      '**/archive/**',
      ...nodeTestRunner
    ],
    passWithNoTests: false,
    restoreMocks: true
  }
});
