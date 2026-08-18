// SPDX-License-Identifier: LicenseRef-BSL-1.1
/**
 * @vitest-environment node
 *
 * The desktop app is a window onto the `hii` CLI: every agent run shells out to
 * it. `hii_binary()` once resolved only `~/bin/hii`, `~/hii/target/release/hii`
 * and `/opt/homebrew/bin/hii` — three developer-machine paths — while
 * `tauri.conf.json` declared no bundle resources. A downloaded HII.app therefore
 * built, signed, launched, and failed at the first agent run with "HII could not
 * locate its Rust CLI" on every computer except the one that built it.
 *
 * These assertions keep the three halves of the fix in agreement without needing
 * a Tauri build, so the drift is caught by `npm run test` rather than by the
 * first stranger to open the app.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const read = (...segments: string[]) => readFile(path.join(repoRoot, ...segments), 'utf8');

describe('packaged CLI closure', () => {
  it('bundles the CLI as an app resource', async () => {
    const config = JSON.parse(await read('src-tauri', 'tauri.conf.json'));
    expect(config.bundle.resources).toContain('resources/hii');
  });

  it('builds the CLI and copies it where the bundle expects it', async () => {
    const script = await read('scripts', 'hii-stage-cli.mjs');
    expect(script).toMatch(/['"]build['"],\s*['"]--release['"],\s*['"]-p['"],\s*['"]hii-cli['"]/);
    expect(script).toMatch(/['"]src-tauri['"],\s*['"]resources['"]/);
  });

  it('stages before anything reads the resource list', async () => {
    // Tauri's build script validates `bundle.resources` before compiling, so a
    // missing staged binary breaks `cargo check` and `tauri dev`, not just the
    // release path. Staging therefore runs from the before-dev/before-build
    // commands rather than only from the packaging script.
    const build = await read('scripts', 'hii-tauri-build.mjs');
    expect(build.indexOf('stageCli(')).toBeLessThan(build.indexOf('spawnSync(tauri'));

    const config = JSON.parse(await read('src-tauri', 'tauri.conf.json'));
    const scripts = JSON.parse(await read('package.json')).scripts;
    for (const command of [config.build.beforeDevCommand, config.build.beforeBuildCommand]) {
      const script = scripts[command.replace(/^npm run /, '')];
      expect(script, `${command} must stage the CLI`).toContain('hii-stage-cli.mjs');
    }
  });

  it('resolves the bundled CLI before any developer-machine path', async () => {
    const source = await read('src-tauri', 'src', 'lib.rs');
    const body = source.slice(source.indexOf('fn hii_binary'), source.indexOf('fn emit_agent'));
    expect(body).toContain('resource_dir()');
    expect(body.indexOf('resource_dir()')).toBeLessThan(body.indexOf('home_dir()'));
  });

  it('names the CLI binary per platform', async () => {
    const source = await read('src-tauri', 'src', 'lib.rs');
    expect(source).toMatch(/#\[cfg\(windows\)\]\s*const CLI_BINARY_NAME: &str = "hii\.exe";/);
    expect(source).toMatch(/#\[cfg\(not\(windows\)\)\]\s*const CLI_BINARY_NAME: &str = "hii";/);
  });
});
