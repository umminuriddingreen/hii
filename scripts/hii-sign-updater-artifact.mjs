#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Sign a Windows updater payload on the machine that holds the minisign key.
 *
 * The Windows installer is built on a PC that does not hold
 * ~/.hii/keys/hii-updater.key, and moving a private key to a second machine to
 * make a build work is not a trade worth making. Tauri's NSIS updater payload
 * is just the setup executable in a zip, so the PC can produce the bundle with
 * --no-updater and this can assemble and sign the payload here, where the key
 * already lives. The key never leaves this machine.
 *
 *   node scripts/hii-sign-updater-artifact.mjs --installer <path-to-setup.exe>
 *
 * Writes <installer>.nsis.zip and <installer>.nsis.zip.sig beside the output
 * directory and prints the signature for the updater feed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const installer = argument('installer');
if (!installer || !existsSync(installer)) {
  console.error('Pass --installer <path to *-setup.exe>.');
  process.exit(2);
}

const outputDir = argument('out') || path.join(root, 'dist', 'releases');
mkdirSync(outputDir, { recursive: true });

const key = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
  || path.join(homedir(), '.hii', 'keys', 'hii-updater.key');
if (!existsSync(key)) {
  console.error(`No updater signing key at ${key}. This must run on the machine that holds it.`);
  process.exit(2);
}

// Tauri's NSIS updater payload is the installer, zipped, under its own name.
const payload = path.join(outputDir, `${path.basename(installer)}.nsis.zip`);
const zip = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', installer, payload], { stdio: 'inherit' });
if (zip.status !== 0) {
  console.error('Could not build the updater payload archive.');
  process.exit(zip.status ?? 1);
}

const tauri = path.join(root, 'node_modules', '.bin', 'tauri');
const sign = spawnSync(
  tauri,
  ['signer', 'sign', '--private-key-path', key, '--password', process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '', payload],
  { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }
);
if (sign.status !== 0) {
  console.error('Signing the updater payload failed.');
  process.exit(sign.status ?? 1);
}

const signaturePath = `${payload}.sig`;
if (!existsSync(signaturePath)) {
  console.error(`Signing reported success but produced no ${path.basename(signaturePath)}.`);
  process.exit(1);
}

console.log(`updater payload: ${path.relative(root, payload)}`);
console.log(`signature:       ${path.relative(root, signaturePath)}`);
console.log(readFileSync(signaturePath, 'utf8').trim());
