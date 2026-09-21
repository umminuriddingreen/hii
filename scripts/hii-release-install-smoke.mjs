#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const installer = path.join(repoRoot, 'hii-release-installer.mjs');
const isWin = process.platform === 'win32';

function runInstaller(env, args = []) {
  const output = execFileSync(process.execPath, [installer, ...args], {
    encoding: 'utf8',
    env
  });
  return {
    ok: true,
    output: output.trim(),
    status: 0
  };
}

function runInstallerSafe(env, args = []) {
  try {
    return runInstaller(env, args);
  } catch (error) {
    return {
      ok: false,
      output: error.stdout ? error.stdout.toString() : error.message,
      status: Number.isInteger(error.status) ? error.status : 1
    };
  }
}

function parseResult(text) {
  return JSON.parse(text);
}

function fileSha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function readHistoryLines(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split(/\r?\n/);
}

function releaseManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function locatePowerShell() {
  const candidates = ['pwsh', 'powershell'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-NoProfile', '-NoLogo', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8'
      });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function parsePowerShellScript(shell, scriptPath) {
  const sourcePath = JSON.stringify(scriptPath);
  const command = [
    `$path = ${sourcePath}`,
    '$errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)',
    'if ($errors -and $errors.Count -gt 0) {',
    '  $errors | ForEach-Object { Write-Error $_.Message }',
    '  exit 1',
    '}'
  ].join('\n');
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  execFileSync(shell, ['-NoProfile', '-NoLogo', '-EncodedCommand', encoded], {
    encoding: 'utf8'
  });
}

const scratch = mkdtempSync(path.join(tmpdir(), 'hii-release-installer-'));
const source = path.join(scratch, 'source');
const releaseRoot = path.join(scratch, 'releases');
const launcher = path.join(scratch, 'bin', isWin ? 'hii.ps1' : 'hii');
mkdirSync(path.dirname(launcher), { recursive: true });

try {
  mkdirSync(path.join(source, 'cli', 'src'), { recursive: true });
  writeFileSync(path.join(source, 'Cargo.toml'), '[workspace]\nmembers = ["cli"]\n');
  writeFileSync(
    path.join(source, 'cli', 'Cargo.toml'),
    '[package]\nname = "hii-cli"\nversion = "0.1.0"\n\n[[bin]]\nname = "hii"\npath = "src/main.rs"\n'
  );
  writeFileSync(
    path.join(source, 'cli', 'src', 'main.rs'),
    'use std::env;\n\nfn main() {\n    for arg in env::args().skip(1) {\n        match arg.as_str() {\n            "--help" | "-h" => {\n                println!("hii fixture");\n                return;\n            }\n            "--version" => {\n                println!("0.1.0");\n                return;\n            }\n            _ => {}\n        }\n    }\n\n    println!("hii release fixture");\n}\n'
  );
  execFileSync('cargo', ['generate-lockfile', '--manifest-path', path.join(source, 'Cargo.toml')]);

  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'hii-installer-smoke@local'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'HII Installer Smoke'], { cwd: source });
  execFileSync('git', ['add', 'Cargo.toml', 'Cargo.lock', 'cli'], { cwd: source });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: source });

  const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8'
  }).trim();

  const env = {
    ...process.env,
    HII_RELEASE_ROOT: releaseRoot,
    HII_HOME: path.join(scratch, 'home')
  };

  const dryRun = parseResult(runInstaller(env, ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher, '--dry-run']).output);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.wouldRunBuild, true);
  assert.equal(existsSync(releaseRoot), false, 'dry-run should not write');

  writeFileSync(launcher, 'legacy-shim');

  const first = parseResult(
    runInstaller(env, ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher]).output
  );
  assert.equal(first.ok, true);
  assert.equal(first.action, 'installed');
  assert.equal(first.buildPerformed, true);
  assert.equal(first.smoke.ok, true);
  assert.equal(first.launcherBackup !== null, true);
  assert.equal(existsSync(first.launcherBackup), true, 'launcher backup should be created');
  assert.equal(readFileSync(first.launcherBackup, 'utf8'), 'legacy-shim', 'launcher backup should preserve previous shim');
  assert.equal(existsSync(first.releaseBinary), true);
  const firstManifest = releaseManifest(path.join(first.releaseDir, 'release.json'));
  const firstManifestChecksum = fileSha256(first.releaseBinary);
  assert.equal(firstManifest.binarySha256, firstManifestChecksum, 'release manifest checksum must match built binary');
  const markerAfterFirst = readFileSync(path.join(releaseRoot, 'current.bin'), 'utf8').trim();
  const markerMtime = statSync(first.releaseBinary).mtimeMs;
  const historyPath = first.historyPath;
  const historyAfterFirst = readHistoryLines(historyPath).map((line) => JSON.parse(line));
  const lastAfterFirst = historyAfterFirst.at(-1);
  assert.equal(historyAfterFirst.length, 1);
  assert.equal(lastAfterFirst.launcherBackup, first.launcherBackup);

  const second = parseResult(runInstaller(env, ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher]).output);
  assert.equal(second.action, 'already-current');
  assert.equal(second.buildPerformed, false);
  assert.equal(readFileSync(path.join(releaseRoot, 'current.bin'), 'utf8').trim(), markerAfterFirst);
  const secondManifest = releaseManifest(path.join(second.releaseDir, 'release.json'));
  const secondManifestChecksum = fileSha256(second.releaseBinary);
  assert.equal(secondManifest.binarySha256, firstManifest.binarySha256, 'idempotent run should not change release manifest checksum');
  assert.equal(firstManifestChecksum, secondManifestChecksum, 'idempotent run should not change release binary checksum');
  assert.equal(markerMtime, statSync(second.releaseBinary).mtimeMs, 'idempotent run should not change release binary mtime');
  assert.equal(readHistoryLines(historyPath).length, 2);

  writeFileSync(path.join(source, 'cli', 'src', 'main.rs'), 'fn main() { println!("dirty"); }\n');
  const dirty = runInstallerSafe(env, ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher]);
  assert.equal(dirty.ok, false);
  assert.equal(readHistoryLines(historyPath).length, 2, 'failed run should not append history');

  const local = parseResult(
    runInstaller(env, [
      '--source-root', source,
      '--release-root', releaseRoot,
      '--launcher-path', launcher,
      '--from-working-tree'
    ]).output
  );
  assert.equal(local.ok, true);
  assert.equal(local.sourceKind, 'working-tree');
  assert.equal(local.sourceTreeClean, false);
  assert.match(local.releaseId, new RegExp(`^${sourceCommit.slice(0, 12)}-local-`));
  assert.notEqual(local.releaseDir, first.releaseDir);
  assert.equal(existsSync(local.releaseBinary), true);
  assert.equal(
    existsSync(path.join(source, 'target', 'release', isWin ? 'hii.exe' : 'hii')),
    false,
    'installer build should not write the checkout target directory'
  );
  const localManifest = releaseManifest(path.join(local.releaseDir, 'release.json'));
  assert.equal(localManifest.schema, 'hii-release-v2');
  assert.equal(localManifest.sourceKind, 'working-tree');
  assert.equal(localManifest.sourceTreeClean, false);

  const customLauncher = '# custom marker-aware launcher\n';
  writeFileSync(launcher, customLauncher);
  const customLocal = parseResult(
    runInstaller(env, [
      '--source-root', source,
      '--release-root', releaseRoot,
      '--launcher-path', launcher,
      '--from-working-tree',
      '--keep-launcher'
    ]).output
  );
  assert.equal(customLocal.ok, true);
  assert.equal(customLocal.launcherManaged, false);
  assert.equal(readFileSync(launcher, 'utf8'), customLauncher, '--keep-launcher must preserve custom setup');
  assert.equal(readFileSync(path.join(releaseRoot, 'current.bin'), 'utf8').trim(), customLocal.releaseBinary);

  execFileSync('git', ['-C', source, 'checkout', '--', 'cli/src/main.rs']);
  const snapshotSource = path.join(scratch, 'snapshot');
  cpSync(source, snapshotSource, {
    recursive: true,
    filter: (sourcePath) => path.basename(sourcePath) !== '.git'
  });
  assert.equal(existsSync(path.join(snapshotSource, '.git')), false, 'snapshot source should not include .git');

  const snapshot = parseResult(
    runInstaller(env, ['--source-snapshot', snapshotSource, '--source-commit', sourceCommit, '--release-root', releaseRoot, '--launcher-path', launcher]).output
  );
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.sourceCommitVerified, false);

  const snapshotInGitParent = path.join(scratch, 'snapshot-in-git-parent');
  mkdirSync(snapshotInGitParent, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: snapshotInGitParent });
  execFileSync('git', ['config', 'user.email', 'hii-installer-smoke-ancestor@local'], { cwd: snapshotInGitParent });
  execFileSync('git', ['config', 'user.name', 'HII Installer Smoke Ancestor'], { cwd: snapshotInGitParent });
  writeFileSync(path.join(snapshotInGitParent, 'ancestor-root.txt'), 'ancestor git repository\n');
  execFileSync('git', ['add', 'ancestor-root.txt'], { cwd: snapshotInGitParent });
  execFileSync('git', ['commit', '-qm', 'ancestor root marker'], { cwd: snapshotInGitParent });
  const ancestorSnapshot = path.join(snapshotInGitParent, 'snapshot');
  cpSync(snapshotSource, ancestorSnapshot, { recursive: true });
  const snapshotFromGitParent = parseResult(
    runInstaller(env, ['--source-snapshot', ancestorSnapshot, '--source-commit', sourceCommit, '--release-root', releaseRoot, '--launcher-path', launcher]).output
  );
  assert.equal(snapshotFromGitParent.ok, true);
  assert.equal(snapshotFromGitParent.sourceCommitVerified, false);

  const historyBeforeUntracked = readHistoryLines(historyPath).length;
  writeFileSync(path.join(source, 'untracked-source.txt'), 'tracked by git? no, but should fail clean check\n');
  const untrackedSource = runInstallerSafe(
    env,
    ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher]
  );
  assert.equal(untrackedSource.ok, false, 'untracked source file must fail clean check');
  assert.equal(readHistoryLines(historyPath).length, historyBeforeUntracked, 'untracked source file should not append history');
  rmSync(path.join(source, 'untracked-source.txt'), { force: true });

  const targetUntracked = path.join(source, 'cli', 'target', 'smoke-artifact.txt');
  mkdirSync(path.dirname(targetUntracked), { recursive: true });
  writeFileSync(targetUntracked, 'build artifact should be ignored\n');
  const allowedTargetArtifact = parseResult(runInstaller(env, ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher]).output);
  assert.equal(allowedTargetArtifact.ok, true);
  assert.equal(allowedTargetArtifact.action, 'already-current');

  const historyBeforeMismatch = readHistoryLines(historyPath).length;
  const mismatchCommit = sourceCommit.replace(/^./, sourceCommit[0] === 'a' ? 'b' : 'a');
  const mismatch = runInstallerSafe(
    env,
    ['--source-root', source, '--release-root', releaseRoot, '--launcher-path', launcher, '--source-commit', mismatchCommit]
  );
  assert.equal(mismatch.ok, false, 'commit mismatch must reject explicit --source-commit');
  assert.equal(readHistoryLines(historyPath).length, historyBeforeMismatch, 'mismatch failure should not append history');

  const wrapperScript = path.join(repoRoot, 'hii-install-release.ps1');
  const powerShell = locatePowerShell();
  if (powerShell) {
    parsePowerShellScript(powerShell, wrapperScript);
    parsePowerShellScript(powerShell, launcher);
  } else {
    console.log('PowerShell unavailable; skipping PowerShell parse checks.');
  }

  if (!isWin) {
    execFileSync('bash', ['-n', launcher]);
  }

  console.log('HII release installer smoke complete');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
