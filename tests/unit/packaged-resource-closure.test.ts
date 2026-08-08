/**
 * @vitest-environment node
 *
 * The packaged desktop app stages a hand-listed subset of the repository into
 * `HII.app/Contents/Resources`. A hand-listed subset drifts: `aii/daemon`
 * gained an import of `aii/model-runtime`, the packaging script was not
 * updated, and the result was an application that built, signed, launched and
 * then failed at the first agent run with a module-not-found error pointing
 * inside the app bundle.
 *
 * The build script now refuses to produce that bundle. This test makes the same
 * invariant cheap to check: it needs no Tauri build, so the drift is caught by
 * `npm run test` rather than by a user opening the app.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const packagingScript = path.join(repoRoot, 'scripts', 'hii-svelte-tauri-build.mjs');

/** Paths the packaging script copies out of the repository, relative to the root. */
async function stagedSourcePaths() {
  const source = await readFile(packagingScript, 'utf8');
  const staged = new Set<string>();
  for (const match of source.matchAll(/path\.join\(root,\s*((?:'[^']+'\s*,\s*)*'[^']+')\s*\)/g)) {
    const segments = [...match[1].matchAll(/'([^']+)'/g)].map((part) => part[1]);
    staged.add(segments.join('/'));
  }
  return staged;
}

/** Every local file reachable from an entrypoint by static relative imports. */
async function importClosure(entry: string) {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const candidates = path.extname(target)
        ? [target]
        : [`${target}.mjs`, `${target}.js`, path.join(target, 'index.mjs')];
      for (const candidate of candidates) {
        const exists = await stat(candidate).then(
          (info) => info.isFile(),
          () => false
        );
        if (exists) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

function isStaged(relative: string, staged: Set<string>) {
  const segments = relative.split('/');
  for (let depth = segments.length; depth > 0; depth -= 1) {
    if (staged.has(segments.slice(0, depth).join('/'))) return true;
  }
  return false;
}

describe('packaged resource closure', () => {
  it('stages every module the packaged daemon imports', async () => {
    const staged = await stagedSourcePaths();
    const closure = await importClosure(path.join(repoRoot, 'aii', 'daemon', 'hiid.mjs'));
    const unstaged = [...closure]
      .map((file) => path.relative(repoRoot, file))
      .filter((relative) => !isStaged(relative, staged))
      .sort();
    expect(unstaged).toEqual([]);
  });

  it('stages every module the packaged web server imports', async () => {
    const staged = await stagedSourcePaths();
    const closure = await importClosure(path.join(repoRoot, 'server.mjs'));
    const unstaged = [...closure]
      .map((file) => path.relative(repoRoot, file))
      .filter((relative) => !relative.startsWith('build/'))
      .filter((relative) => relative !== 'server.mjs')
      .filter((relative) => !isStaged(relative, staged))
      .sort();
    expect(unstaged).toEqual([]);
  });

  it('stages the runtime configuration the daemon reads from its own root', async () => {
    const staged = await stagedSourcePaths();
    const daemon = await readFile(path.join(repoRoot, 'aii', 'daemon', 'hiid.mjs'), 'utf8');
    // `ROOT` resolves to the staged server directory inside the app bundle, so a
    // file read as `ROOT/x/y` has to have been copied there.
    const required = [...daemon.matchAll(/path\.join\(ROOT,\s*((?:"[^"]+",\s*)*"[^"]+")\s*\)/g)]
      .map((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join('/'))
      .filter((relative) => relative.endsWith('.json'));
    expect(required.length).toBeGreaterThan(0);
    for (const relative of required) {
      expect(isStaged(relative, staged), `${relative} is read at runtime but never packaged`).toBe(
        true
      );
    }
  });

  it('finds the daemon entrypoint the packaged app actually spawns', async () => {
    const entries = await readdir(path.join(repoRoot, 'aii', 'daemon'));
    expect(entries).toContain('hiid.mjs');
  });
});
