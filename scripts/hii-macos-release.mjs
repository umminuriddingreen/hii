#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFileSync,
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('hii:release:mac requires macOS.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const packageConfig = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const version = config.version;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch;
const app = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'HII.app');
const bootstrap = path.join(root, 'scripts', 'hii-bootstrap.sh');
const installGuide = path.join(root, 'docs', 'INSTALL.md');
const outputDir = path.join(root, 'dist', 'releases');
const releaseName = `HII-${version}-macos-${arch}`;
const archive = path.join(outputDir, `${releaseName}.zip`);
const identity = process.env.HII_SIGNING_IDENTITY?.trim();
const notaryProfile = process.env.HII_NOTARY_PROFILE?.trim();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${command} failed.\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function requireSourceIdentity(expectedCommit) {
  const currentCommit = capture('git', ['rev-parse', '--verify', 'HEAD']);
  const gitStatus = capture('git', ['status', '--porcelain', '--untracked-files=all']);
  if (currentCommit !== expectedCommit || gitStatus) {
    console.error([
      'hii:release:mac requires one unchanged clean Git commit.',
      'Commit or explicitly remove every tracked and untracked change before producing a signed release.'
    ].join('\n'));
    process.exit(2);
  }
}

if (
  packageConfig.version !== version
  || packageLock.version !== version
  || packageLock.packages?.['']?.version !== version
) {
  console.error(
    `hii:release:mac requires one release version; package, lockfile, and Tauri must all equal ${version}.`
  );
  process.exit(2);
}

if (!identity || !notaryProfile) {
  console.error([
    'hii:release:mac is intentionally closed until distribution trust is configured.',
    'Set HII_SIGNING_IDENTITY to an Apple Developer ID Application identity.',
    'Set HII_NOTARY_PROFILE to an xcrun notarytool keychain profile.',
    'The script will not create a public archive from an ad-hoc signed app.'
  ].join('\n'));
  process.exit(2);
}

const gitCommit = capture('git', ['rev-parse', '--verify', 'HEAD']);
requireSourceIdentity(gitCommit);

run('security', ['find-identity', '-v', '-p', 'codesigning']);
run('npm', ['run', 'build:tauri']);
requireSourceIdentity(gitCommit);

if (!existsSync(app) || !existsSync(bootstrap) || !existsSync(installGuide)) {
  console.error('hii:release:mac could not find the app, bootstrap, or install guide.');
  process.exit(1);
}

run('codesign', [
  '--force',
  '--deep',
  '--options',
  'runtime',
  '--timestamp',
  '--sign',
  identity,
  app
]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

const temporary = mkdtempSync(path.join(tmpdir(), 'hii-release-'));
try {
  const submission = path.join(temporary, `${releaseName}-notary.zip`);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, submission]);
  run('xcrun', [
    'notarytool',
    'submit',
    submission,
    '--keychain-profile',
    notaryProfile,
    '--wait'
  ]);
  run('xcrun', ['stapler', 'staple', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['-a', '-vv', '--type', 'execute', app]);

  const releaseFolder = path.join(temporary, releaseName);
  mkdirSync(releaseFolder);
  cpSync(app, path.join(releaseFolder, 'HII.app'), { recursive: true });
  copyFileSync(bootstrap, path.join(releaseFolder, 'hii-bootstrap.sh'));
  copyFileSync(installGuide, path.join(releaseFolder, 'INSTALL.md'));

  mkdirSync(outputDir, { recursive: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', releaseFolder, archive]);

  const bytes = statSync(archive).size;
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const manifest = {
    version,
    platform: 'macos',
    architecture: arch,
    minimumSystemVersion: config.bundle.macOS.minimumSystemVersion,
    filename: path.basename(archive),
    bytes,
    sha256,
    gitCommit,
    gitTree: 'clean',
    signed: true,
    notarized: true,
    createdAt: new Date().toISOString()
  };
  writeFileSync(path.join(outputDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`hii release ready: ${path.relative(root, archive)}`);
  console.log(`sha256: ${sha256}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
