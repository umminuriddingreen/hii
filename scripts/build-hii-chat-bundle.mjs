#!/usr/bin/env node
// Generates the public, checksum-addressed HII Chat link bundle.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'public/hii-chat/files');
mkdirSync(output, { recursive: true });

const sources = {
  'hii-remote-host.mjs': 'remote/host/hii-remote-host.mjs',
  'install-local.sh': 'remote/host/install.sh',
  'update.sh': 'remote/host/update.sh',
};

const files = {};
for (const [name, source] of Object.entries(sources)) {
  const from = resolve(root, source);
  const to = resolve(output, name);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  files[name] = createHash('sha256').update(readFileSync(from)).digest('hex');
}
const bundleHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const version = `1.${BigInt(`0x${bundleHash.slice(0, 15)}`).toString()}`;
writeFileSync(resolve(root, 'public/hii-chat/manifest.json'), `${JSON.stringify({ schemaVersion: 1, version, files }, null, 2)}\n`);
