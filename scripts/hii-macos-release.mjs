#!/usr/bin/env node
/**
 * Produce one distributable macOS release: a notarized DMG plus the signed updater
 * artifact and the `latest.json` manifest the app polls.
 *
 * Distribution trust has two independent signatures and both are required:
 *   - Apple Developer ID + notarization, so Gatekeeper opens the download.
 *   - A minisign key, so the updater refuses any bundle it cannot verify.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadManifest, fileFacts, updaterFeed, updaterUrl } from './hii-release-manifest.mjs';

if (process.platform !== 'darwin') {
  console.error('hii:release:mac requires macOS.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const packageConfig = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const version = config.version;
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const app = path.join(bundleDir, 'macos', 'HII.app');
const dmg = path.join(bundleDir, 'dmg', `HII_${version}_${arch}.dmg`);
const updaterArchive = path.join(bundleDir, 'macos', 'HII.app.tar.gz');
const updaterSignature = `${updaterArchive}.sig`;
const outputDir = path.join(root, 'dist', 'releases');
const releaseDmg = path.join(outputDir, `HII-${version}-macos-${arch}.dmg`);
const releaseUpdater = path.join(outputDir, `HII-${version}-macos-${arch}.app.tar.gz`);

const identity = process.env.HII_SIGNING_IDENTITY?.trim();
const notaryProfile = process.env.HII_NOTARY_PROFILE?.trim();
const updaterKeyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()
  || path.join(process.env.HOME ?? '', '.hii', 'keys', 'hii-updater.key');

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

/** A release must name one exact commit, so a receipt can be traced back to its source. */
function requireSourceIdentity(expectedCommit) {
  const currentCommit = capture('git', ['rev-parse', '--verify', 'HEAD']);
  const gitStatus = capture('git', ['status', '--porcelain', '--untracked-files=all']);
  if (currentCommit !== expectedCommit || gitStatus) {
    console.error([
      'hii:release:mac requires one unchanged clean Git commit.',
      'Commit or explicitly remove every tracked and untracked change before producing a release.'
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
    'hii:release:mac is closed until Apple distribution trust is configured.',
    '',
    'Set HII_SIGNING_IDENTITY to an Apple Developer ID Application identity.',
    'Set HII_NOTARY_PROFILE to an xcrun notarytool keychain profile.',
    '',
    'Without both, macOS Gatekeeper refuses a downloaded build and the only',
    'workaround asks every user to weaken their own security. Run',
    '`npm run build:tauri:dmg` for an unsigned local build instead.'
  ].join('\n'));
  process.exit(2);
}

if (!existsSync(updaterKeyPath)) {
  console.error([
    `hii:release:mac could not read the updater signing key at ${updaterKeyPath}.`,
    'Generate one with: npx tauri signer generate -w ~/.hii/keys/hii-updater.key',
    'Its public half must match plugins.updater.pubkey in src-tauri/tauri.conf.json.'
  ].join('\n'));
  process.exit(2);
}

const gitCommit = capture('git', ['rev-parse', '--verify', 'HEAD']);
requireSourceIdentity(gitCommit);

run('security', ['find-identity', '-v', '-p', 'codesigning']);

// Tauri signs the app with the Apple identity and the updater archive with minisign.
run('npm', ['run', 'build:tauri:release'], {
  env: {
    ...process.env,
    APPLE_SIGNING_IDENTITY: identity,
    TAURI_SIGNING_PRIVATE_KEY: updaterKeyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  }
});
requireSourceIdentity(gitCommit);

for (const required of [app, dmg, updaterArchive, updaterSignature]) {
  if (!existsSync(required)) {
    console.error(`hii:release:mac expected ${path.relative(root, required)} and it is missing.`);
    process.exit(1);
  }
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

// Notarize the DMG. Stapling the disk image covers the app inside it.
run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', notaryProfile, '--wait']);
run('xcrun', ['stapler', 'staple', dmg]);
run('xcrun', ['stapler', 'validate', dmg]);
run('spctl', ['-a', '-vv', '--type', 'install', dmg]);

mkdirSync(outputDir, { recursive: true });
copyFileSync(dmg, releaseDmg);
copyFileSync(updaterArchive, releaseUpdater);
copyFileSync(updaterSignature, `${releaseUpdater}.sig`);

const { bytes: dmgBytes, sha256: dmgSha256 } = fileFacts(releaseDmg);
const signature = readFileSync(updaterSignature, 'utf8').trim();
const macosUpdaterUrl = updaterUrl('macos');
const publishedAt = new Date().toISOString();

// The Tauri updater feed covers every platform in one document, so merge into
// whatever a Windows publish last wrote rather than replacing it.
const feedPath = path.join(outputDir, 'latest.json');
const existingFeed = existsSync(feedPath) ? JSON.parse(readFileSync(feedPath, 'utf8')) : null;
writeFileSync(
  feedPath,
  `${JSON.stringify(
    updaterFeed(
      {
        version,
        publishedAt,
        platforms: {
          'darwin-aarch64': { signature, url: macosUpdaterUrl },
          'darwin-x86_64': { signature, url: macosUpdaterUrl }
        }
      },
      existingFeed
    ),
    null,
    2
  )}\n`
);

// The document the Worker reads to find and verify the artifact it serves.
writeFileSync(
  path.join(outputDir, 'latest-macos.json'),
  `${JSON.stringify(
    downloadManifest({
      platform: 'macos',
      version,
      filename: path.basename(releaseDmg),
      architecture: arch,
      minimumSystemVersion: config.bundle.macOS.minimumSystemVersion,
      gitCommit,
      signed: true,
      notarized: true,
      bytes: dmgBytes,
      sha256: dmgSha256,
      publishedAt
    }),
    null,
    2
  )}\n`
);

console.log(`hii release ready: ${path.relative(root, releaseDmg)}`);
console.log(`sha256: ${dmgSha256}`);
console.log('');
console.log('Publish with:');
console.log(`  gh release create v${version} dist/releases/* --title "HII ${version}" --notes "HII ${version}"`);
