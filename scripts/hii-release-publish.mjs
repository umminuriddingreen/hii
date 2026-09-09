#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Publish a built HII installer to the R2 bucket the website serves from.
 *
 * The read path already existed and was never fed: `GET /download/<platform>`
 * in `workers/public-site/src/lib.rs` looks up `releases/latest-<platform>.json`,
 * reads its `filename`, and streams `releases/<filename>` with a sha256 header.
 * Nothing wrote those objects, so both routes answered `release_not_available`.
 *
 * Downloads are session-gated by the worker, which is the point: this publishes
 * to an audience that has an HII account, not to the open internet.
 *
 *   node scripts/hii-release-publish.mjs --platform windows \
 *     --artifact src-tauri/target/release/bundle/nsis/HII_0.1.0_x64-setup.exe
 *
 * `--dry-run` prints what would be uploaded and touches nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVABLE_FILENAME,
  downloadManifest,
  fileFacts
} from './hii-release-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = new Set(['macos', 'windows']);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dryRun = process.argv.includes('--dry-run');
const platform = arg('platform');
const artifact = arg('artifact');

if (!PLATFORMS.has(platform)) fail(`--platform must be one of: ${[...PLATFORMS].join(', ')}`);
if (!artifact) fail('--artifact is required.');

const artifactPath = path.resolve(root, artifact);
if (!existsSync(artifactPath)) fail(`Artifact not found: ${artifactPath}`);

const filename = path.basename(artifactPath);
if (!SERVABLE_FILENAME.test(filename)) {
  fail(`The worker will refuse this filename; it allows only [A-Za-z0-9._-]: ${filename}`);
}

const config = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = config.version;

const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
if (commit.status !== 0) fail('Unable to read the current git commit.');
const gitCommit = commit.stdout.trim();

// A published artifact must be traceable to a commit. A dirty tree is allowed
// for an unsigned owner build, but it is recorded rather than hidden.
const gitTree = dirty.stdout.trim() ? 'dirty' : 'clean';

const facts = fileFacts(artifactPath);
const manifest = downloadManifest({
  platform,
  version,
  filename,
  architecture: platform === 'windows' ? 'x86_64' : 'aarch64',
  minimumSystemVersion:
    platform === 'windows' ? '10' : config.bundle.macOS.minimumSystemVersion,
  gitCommit,
  // Nothing here is code-signed for distribution yet. Saying so in the manifest
  // is what lets the download page tell the truth without guessing.
  signed: false,
  notarized: false,
  ...facts
});
manifest.gitTree = gitTree;

const stageDir = path.join(root, 'dist', 'releases');
mkdirSync(stageDir, { recursive: true });
const manifestPath = path.join(stageDir, `latest-${platform}.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const contentType =
  platform === 'windows' ? 'application/vnd.microsoft.portable-executable' : 'application/x-apple-diskimage';

function wrangler(args) {
  if (dryRun) {
    console.log(`[dry-run] wrangler ${args.join(' ')}`);
    return;
  }
  const run = spawnSync('npx', ['wrangler', ...args], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

wrangler(['r2', 'object', 'put', `hii/releases/${filename}`, '--file', artifactPath, '--content-type', contentType, '--remote']);
wrangler(['r2', 'object', 'put', `hii/releases/latest-${platform}.json`, '--file', manifestPath, '--content-type', 'application/json', '--remote']);

console.log('');
console.log(`published ${filename}`);
console.log(`  version:  ${version}`);
console.log(`  bytes:    ${facts.bytes}`);
console.log(`  sha256:   ${facts.sha256}`);
console.log(`  commit:   ${gitCommit} (${gitTree})`);
console.log(`  reachable at https://humaninformationinterface.com/download/${platform} (sign-in required)`);
