import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installLauncher, setInstallRoot } from './hii-cli-install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('custom launchers are preserved unless replacement is explicit, and then backed up', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'hii-install-contract-'));
  try {
    const source = path.join(temporary, 'source');
    const destination = path.join(temporary, 'hii');
    writeFileSync(source, 'new generic launcher');
    writeFileSync(destination, 'existing launcher with selected local model');
    assert.throws(() => installLauncher({ source, destination }), /preserved/);
    assert.equal(readFileSync(destination, 'utf8'), 'existing launcher with selected local model');
    const installed = installLauncher({ source, destination, replaceExisting: true });
    assert.equal(readFileSync(installed.backup, 'utf8'), 'existing launcher with selected local model');
    assert.equal(readFileSync(destination, 'utf8'), 'new generic launcher');
    assert.equal(installLauncher({ source, destination }).unchanged, true);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('install-root rejects ambiguous paths and preserves the previous root', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'hii-install-root-'));
  try {
    const repo = path.join(temporary, 'repo with spaces');
    mkdirSync(path.join(repo, 'cli'), { recursive: true });
    writeFileSync(path.join(repo, 'Cargo.toml'), '[workspace]');
    writeFileSync(path.join(repo, 'cli', 'Cargo.toml'), '[package]');
    const destination = path.join(temporary, 'install-root');
    writeFileSync(destination, 'previous root\n');
    assert.throws(() => setInstallRoot('relative', { destination }), /absolute/);
    assert.throws(() => setInstallRoot(`${repo}\nother`, { destination }), /absolute/);
    const installed = setInstallRoot(repo, { destination });
    assert.equal(readFileSync(installed.backup, 'utf8'), 'previous root\n');
    assert.equal(readFileSync(destination, 'utf8'), `${repo}\n`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('installed launcher passes literal arguments including quotes, Unicode and empty values', () => {
  const values = ['plain', '', 'a"b', 'tail\\', 'space and \\"', '$(untrusted)', 'line\nnext', 'é字'];
  const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values];
  const env = { ...process.env, HII_ROOT: root, HII_CLI_BIN: process.execPath };
  let output;
  if (process.platform === 'win32') {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${quote(path.join(root, 'scripts', 'hii-launcher.ps1'))} ${args.map(quote).join(' ')}`;
    output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  } else {
    output = execFileSync('bash', [path.join(root, 'scripts', 'hii-launcher.sh'), ...args], { env, encoding: 'utf8', timeout: 10000 });
  }
  assert.deepEqual(JSON.parse(output), values);
});
