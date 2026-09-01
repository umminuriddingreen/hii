#!/usr/bin/env node
// Publish an already-built, signed HII UI release to the canonical R2 channel.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const releaseDir = path.resolve(repoRoot, 'dist/ui');
const manifestPath = path.join(releaseDir, 'ui-latest.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(args) {
  const result = spawnSync('npx', ['wrangler', ...args], { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) fail(`wrangler ${args.join(' ')} failed with status ${result.status}`);
}

if (!fs.existsSync(manifestPath)) fail('dist/ui/ui-latest.json is missing. Run npm run ui:release first.');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.signature || !manifest.sha256 || !manifest.url) fail('Refusing to publish an unsigned or incomplete UI manifest.');
if (new URL(manifest.url).origin !== 'https://humaninformationinterface.com') {
  fail('The canonical UI release URL must use https://humaninformationinterface.com.');
}
const bundleName = path.basename(new URL(manifest.url).pathname);
if (!/^hii-ui-[A-Za-z0-9._-]+\.zip$/.test(bundleName)) fail('The UI bundle filename is invalid.');
const bundlePath = path.join(releaseDir, bundleName);
if (!fs.existsSync(bundlePath)) fail(`${bundlePath} is missing.`);

run(['r2', 'object', 'put', `hii/ui/${bundleName}`, '--file', bundlePath, '--content-type', 'application/zip', '--remote']);
run(['r2', 'object', 'put', 'hii/ui/ui-latest.json', '--file', manifestPath, '--content-type', 'application/json', '--remote']);
console.log(`Published ${bundleName} and ui-latest.json to the canonical HII UI channel.`);
