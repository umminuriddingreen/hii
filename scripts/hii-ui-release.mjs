#!/usr/bin/env node
// Ship an interface-only release: build the Next desktop export, zip it, sign it
// with the same minisign key the desktop updater trusts, and write the manifest
// the running app polls. No Tauri rebuild, no reinstall.
//
//   node scripts/hii-ui-release.mjs --version 0.1.4 --base-url https://…/ui
//
// Outputs (default dist/ui):
//   hii-ui-<version>.zip   the static export
//   hii-ui-<version>.json  per-version manifest
//   ui-latest.json         the manifest endpoint apps poll

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function arg(name, fallback = null) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
  return result;
}

const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
).version;
const version = arg('version', packageVersion);
const outDir = path.resolve(repoRoot, arg('out', 'dist/ui'));
const exportDir = path.resolve(repoRoot, arg('export', 'out'));
const baseUrl = (arg('base-url', process.env.HII_UI_BASE_URL) || '').replace(/\/+$/, '');
const notes = arg('notes', '');

if (!baseUrl) {
  console.error(
    'A --base-url (or HII_UI_BASE_URL) is required: it is where the app will download the bundle from.'
  );
  process.exit(1);
}
if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(baseUrl)) {
  console.error('The bundle base URL must be https:// (loopback http is allowed for local testing).');
  process.exit(1);
}

if (!flag('skip-build')) {
  run('npm', ['run', 'build:desktop']);
}
if (!fs.existsSync(path.join(exportDir, 'index.html'))) {
  console.error(`No static export at ${exportDir}. Run npm run build:desktop first.`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const zipName = `hii-ui-${version}.zip`;
const zipPath = path.join(outDir, zipName);
fs.rmSync(zipPath, { force: true });
// Zip the export contents at the archive root so index.html lands at the top.
run('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: exportDir });

const bytes = fs.readFileSync(zipPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');

let signature = '';
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (privateKey) {
  const signArgs = ['tauri', 'signer', 'sign', fs.existsSync(privateKey) ? '--private-key-path' : '--private-key', privateKey];
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) {
    signArgs.push('--password', process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
  }
  signArgs.push(zipPath);
  const signEnv = { ...process.env };
  delete signEnv.TAURI_SIGNING_PRIVATE_KEY;
  run('npx', signArgs, { env: signEnv });
  const sigPath = `${zipPath}.sig`;
  const tauriSignature = fs.readFileSync(sigPath, 'utf8').trim();
  // Tauri's signer base64-wraps the complete minisign signature file. HII's
  // verifier consumes the minisign text itself so the manifest stays portable
  // across the shell updater and UI channel.
  signature = Buffer.from(tauriSignature, 'base64').toString('utf8').trim();
} else if (flag('allow-unsigned')) {
  console.warn(
    'Publishing an UNSIGNED interface bundle. Apps accept it only with HII_UI_ALLOW_UNSIGNED=1.'
  );
} else {
  console.error(
    'TAURI_SIGNING_PRIVATE_KEY is not set. Set it to sign the bundle, or pass --allow-unsigned for local testing.'
  );
  process.exit(1);
}

const manifest = {
  version,
  url: `${baseUrl}/${zipName}`,
  sha256,
  signature,
  notes,
  pubDate: new Date().toISOString()
};

const manifestPath = path.join(outDir, `hii-ui-${version}.json`);
const latestPath = path.join(outDir, 'ui-latest.json');
const body = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(manifestPath, body);
fs.writeFileSync(latestPath, body);

console.log(`\nInterface bundle ready (no Tauri rebuild required):`);
console.log(`  bundle    ${path.relative(repoRoot, zipPath)} (${(bytes.length / 1_000_000).toFixed(2)} MB)`);
console.log(`  sha256    ${sha256}`);
console.log(`  signed    ${signature ? 'yes' : 'NO — testing only'}`);
console.log(`  manifest  ${path.relative(repoRoot, latestPath)}`);
console.log(`\nUpload both files to ${baseUrl}/ and installed apps pick the release up on their next poll.`);
