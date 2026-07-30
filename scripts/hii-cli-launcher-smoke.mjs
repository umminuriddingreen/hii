import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installLauncher } from './hii-cli-install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalLauncher = path.join(root, 'scripts', 'hii-launcher.sh');
const scratch = mkdtempSync(path.join(tmpdir(), 'hii-launcher-'));
const fakeRepo = path.join(scratch, 'repo');
const fakeBinary = path.join(fakeRepo, 'target', 'release', 'hii');
const fakeCargo = path.join(scratch, 'fake-cargo.mjs');
const buildCount = path.join(scratch, 'build-count.txt');
const installedLauncher = path.join(scratch, 'bin', 'hii');

try {
  mkdirSync(path.join(fakeRepo, 'cli', 'src'), { recursive: true });
  writeFileSync(path.join(fakeRepo, 'Cargo.toml'), '[workspace]\nmembers = ["cli"]\n');
  writeFileSync(path.join(fakeRepo, 'Cargo.lock'), 'version = 4\n');
  writeFileSync(path.join(fakeRepo, 'cli', 'Cargo.toml'), '[package]\nname = "hii-cli"\n');
  const mainSource = path.join(fakeRepo, 'cli', 'src', 'main.rs');
  const removedSource = path.join(fakeRepo, 'cli', 'src', 'removed.rs');
  writeFileSync(mainSource, 'fn main() {}\n');
  writeFileSync(removedSource, 'fn removed() {}\n');

  const git = (...args) => execFileSync('git', args, { cwd: fakeRepo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'hii-launcher-smoke@local');
  git('config', 'user.name', 'HII launcher smoke');
  git('add', 'Cargo.toml', 'Cargo.lock', 'cli');
  git('commit', '-qm', 'initial CLI source');

  writeFileSync(fakeCargo, `#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const countPath = process.env.HII_FAKE_BUILD_COUNT;
const binaryPath = process.env.HII_CLI_BIN;
let count = 0;
try { count = Number(readFileSync(countPath, 'utf8')); } catch {}
writeFileSync(countPath, String(count + 1));
mkdirSync(path.dirname(binaryPath), { recursive: true });
writeFileSync(binaryPath, '#!/usr/bin/env bash\\nprintf "fake-hii:%s\\\\n" "$*"\\n');
chmodSync(binaryPath, 0o755);
`);
  chmodSync(fakeCargo, 0o755);

  const environment = {
    ...process.env,
    HII_ROOT: fakeRepo,
    HII_CLI_BIN: fakeBinary,
    HII_CARGO_BIN: fakeCargo,
    HII_FAKE_BUILD_COUNT: buildCount
  };

  const first = execFileSync(canonicalLauncher, ['health', '--text'], {
    encoding: 'utf8',
    env: environment
  }).trim();
  assert.equal(first, 'fake-hii:health --text');
  assert.equal(readFileSync(buildCount, 'utf8'), '1');

  execFileSync(canonicalLauncher, ['health'], { encoding: 'utf8', env: environment });
  assert.equal(readFileSync(buildCount, 'utf8'), '1', 'fresh launcher must not rebuild');

  const old = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(fakeBinary, old, old);
  writeFileSync(mainSource, 'fn main() { println!("changed"); }\n');
  execFileSync(canonicalLauncher, ['space', 'health'], {
    encoding: 'utf8',
    env: environment
  });
  assert.equal(readFileSync(buildCount, 'utf8'), '1', 'dirty Rust work must reuse the last release');

  git('add', 'cli/src/main.rs');
  git('commit', '-qm', 'change CLI source');
  execFileSync(canonicalLauncher, ['space', 'health'], {
    encoding: 'utf8',
    env: environment
  });
  assert.equal(readFileSync(buildCount, 'utf8'), '2', 'committed Rust source must rebuild');

  utimesSync(fakeBinary, old, old);
  rmSync(removedSource);
  execFileSync(canonicalLauncher, ['health'], { encoding: 'utf8', env: environment });
  assert.equal(readFileSync(buildCount, 'utf8'), '2', 'dirty source deletion must reuse the last release');

  git('add', 'cli/src/removed.rs');
  git('commit', '-qm', 'remove CLI source');
  execFileSync(canonicalLauncher, ['health'], { encoding: 'utf8', env: environment });
  assert.equal(readFileSync(buildCount, 'utf8'), '3', 'committed source deletion must rebuild');

  installLauncher({ source: canonicalLauncher, destination: installedLauncher });
  assert.equal(readFileSync(installedLauncher, 'utf8'), readFileSync(canonicalLauncher, 'utf8'));
  assert.equal(statSync(installedLauncher).mode & 0o111, 0o111);
  assert.equal(existsSync(installedLauncher), true);

  console.log('HII CLI launcher smoke');
  console.log('status:       ok');
  console.log('missing:      release CLI built on first use');
  console.log('fresh:        unchanged release CLI reused');
  console.log('dirty:        in-progress Rust work reused last successful release');
  console.log('committed:    changed Rust source forced release rebuild');
  console.log('deleted:      committed Rust source deletion forced rebuild');
  console.log('install:      canonical launcher installed atomically');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
