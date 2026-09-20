#!/usr/bin/env node
// Publish only verified CI artifacts; move the public latest pointer last.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const CLI_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'];

export function verifiedRelease(directory, tag) {
  if (!/^cli-v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Expected a cli-vMAJOR.MINOR.PATCH tag');
  const checksums = new Map();
  for (const line of readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(hii-[A-Za-z0-9_-]+\.tar\.gz)$/.exec(line);
    if (!match || checksums.has(match[2])) throw new Error('Invalid or duplicate SHA256SUMS entry');
    checksums.set(match[2], match[1].toLowerCase());
  }
  const files = CLI_TARGETS.map((target) => `hii-${target}.tar.gz`);
  if (checksums.size !== files.length) throw new Error('Checksum inventory differs from supported targets');
  for (const filename of files) {
    const actual = createHash('sha256').update(readFileSync(path.join(directory, filename))).digest('hex');
    if (checksums.get(filename) !== actual) throw new Error(`Checksum mismatch: ${filename}`);
  }
  return { tag, files, checksums };
}

function main() {
  const [directory, tag, ...flags] = process.argv.slice(2);
  if (!directory || !tag || flags.some((flag) => flag !== '--dry-run')) throw new Error('Usage: hii-cli-release-publish <artifact-directory> <cli-vX.Y.Z> [--dry-run]');
  const release = verifiedRelease(path.resolve(directory), tag);
  const dryRun = flags.includes('--dry-run');
  if (!dryRun && process.env.CI === 'true' && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('CI publication requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'hii-cli-publish-'));
  const upload = (key, file, contentType = 'application/octet-stream') => {
    if (dryRun) { console.log(`verified upload: ${key}`); return; }
    const result = spawnSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put', `hii/${key}`, '--file', file, '--content-type', contentType, '--remote'], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Upload failed: ${key}`);
  };
  try {
    const prefix = `cli/releases/${tag}`;
    for (const file of [...release.files, 'SHA256SUMS']) upload(`${prefix}/${file}`, path.resolve(directory, file));
    // Keep old Mac/Linux links working against the same verified bytes.
    for (const [alias, target] of [['hii-macos-arm64.tar.gz', 'aarch64-apple-darwin'], ['hii-linux-x64.tar.gz', 'x86_64-unknown-linux-gnu']]) {
      const canonical = `hii-${target}.tar.gz`;
      upload(`${prefix}/${alias}`, path.resolve(directory, canonical));
      const checksum = path.join(temporary, `${alias}.sha256`);
      writeFileSync(checksum, `${release.checksums.get(canonical)}  ${alias}\n`);
      upload(`${prefix}/${alias}.sha256`, checksum, 'text/plain');
    }
    const manifest = path.join(temporary, 'latest.json');
    writeFileSync(manifest, JSON.stringify({ tag, targets: CLI_TARGETS, publishedAt: new Date().toISOString() }));
    upload('cli/releases/latest.json', manifest, 'application/json');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
