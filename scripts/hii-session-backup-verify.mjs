// Restore the smallest available snapshot per provider without touching sources.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.HII_RUNTIME_DIR || path.join(homedir(), '.hii');
const binary = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'hii.exe' : 'hii');
const env = { ...process.env, HII_ROOT: root, HII_RUNTIME_DIR: runtime };
function invoke(args) {
  return JSON.parse(execFileSync(binary, ['session-backup', ...args], {
    encoding: 'utf8', env, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  }));
}
const snapshots = invoke(['list']);
const directory = path.join(runtime, 'session-backup', 'restore-proof');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const destination = mkdtempSync(path.join(directory, 'verified-'));
const results = [];
for (const provider of ['codex', 'claude', 'pi']) {
  const snapshot = snapshots.filter((item) => item.provider === provider)
    .sort((left, right) => left.bytes - right.bytes)[0];
  if (!snapshot) throw new Error(`No ${provider} snapshot available to verify`);
  const file = path.join(destination, `${provider}.jsonl`);
  const report = invoke(['restore', snapshot.snapshotId, file]);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!report.verified || sha256 !== snapshot.sha256) throw new Error(`${provider} restore checksum mismatch`);
  results.push({ provider, bytes: snapshot.bytes, verified: true });
}
console.log(JSON.stringify({ restoredToNewFiles: true, results }, null, 2));
