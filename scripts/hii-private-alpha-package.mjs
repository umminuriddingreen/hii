// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const canvas = join(repo, 'src-tauri/target/release/bundle/macos/HII.app');
const bar = join(repo, 'macos/.build/HII Bar.app');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const releaseId = `hii-private-alpha-0.1.0-${timestamp}`;
const output = join(repo, 'dist/private-alpha', releaseId);
const archive = join(output, `${releaseId}-arm64-macos.zip`);
const temporary = mkdtempSync(join(tmpdir(), 'hii-private-alpha-'));
const packageRoot = join(temporary, 'HII Private Alpha');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeEntries(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const stat = lstatSync(path, { throwIfNoEntry: true });
    entries.push({ path, relative: relative(root, path), stat });
    if (stat.isDirectory()) entries.push(...treeEntries(root, path));
  }
  return entries;
}

function sha256Tree(root) {
  const hash = createHash('sha256');
  for (const entry of treeEntries(root)) {
    hash.update(entry.relative);
    if (entry.stat.isDirectory()) hash.update('\0directory\0');
    else if (entry.stat.isSymbolicLink()) hash.update(`\0symlink\0${readlinkSync(entry.path)}`);
    else hash.update('\0file\0').update(String(entry.stat.size)).update(readFileSync(entry.path));
  }
  return hash.digest('hex');
}

function copyBundle(source, destination) {
  execFileSync('ditto', [source, destination], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', destination], { stdio: 'inherit' });
}

if (!statSync(canvas).isDirectory() || !statSync(bar).isDirectory()) {
  throw new Error('Build HII.app and HII Bar.app before packaging the private alpha.');
}
mkdirSync(join(repo, 'dist/private-alpha'), { recursive: true });
mkdirSync(output, { recursive: false });
mkdirSync(packageRoot);
copyBundle(canvas, join(packageRoot, basename(canvas)));
copyBundle(bar, join(packageRoot, basename(bar)));

const manifest = {
  schemaVersion: 1,
  kind: 'hii.private-alpha.release/1',
  releaseId,
  version: '0.1.0-alpha',
  platform: 'macos-arm64',
  distribution: 'unlisted-private-alpha',
  signing: 'ad-hoc',
  notarized: false,
  createdAt: new Date().toISOString(),
  applications: [
    { name: 'HII', bundleIdentifier: 'com.ummi.hii', sha256Tree: sha256Tree(canvas) },
    { name: 'HII Bar', bundleIdentifier: 'ai.hii.bar', sha256Tree: sha256Tree(bar) }
  ],
  includes: ['HII Canvas', 'HII Bar', 'Waymark', 'HII Link'],
  boundary: 'HII Link opens user-controlled Apple handoffs. It does not read Messages history or send messages.'
};
writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(packageRoot, 'INSTALL.md'), `# Install the HII private alpha\n\nThis build is for a trusted private alpha on Apple-Silicon Macs. It is ad-hoc signed and not Apple-notarized.\n\n1. Move \`HII.app\` and \`HII Bar.app\` into \`/Applications\`.\n2. The first time, Control-click each app, choose Open, then confirm Open.\n3. Open HII Bar and grant Accessibility only if macOS asks and you want the intentional keyboard invocation.\n4. HII Canvas, HII Bar, Waymark, and HII Link share one local application registry.\n\nDo not bypass Gatekeeper globally. Do not redistribute this private link.\n`);
writeFileSync(join(packageRoot, 'RESTORE.md'), `# Restore a previous HII installation\n\nBefore replacing an existing installation, run \`hii clean\` to preview the exact scope, then \`hii clean --apply\`. HII moves only \`/Applications/HII.app\` and \`/Applications/HII Bar.app\` into a timestamped folder under \`~/HII Backups/Applications\` and writes its own manifest and restore instructions. It preserves \`~/.hii\`, repositories, creator packages, and user data.\n`);

execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', packageRoot, archive], { stdio: 'inherit' });
const release = {
  ...manifest,
  artifact: {
    fileName: basename(archive),
    bytes: statSync(archive).size,
    sha256: sha256File(archive)
  }
};
writeFileSync(join(output, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
writeFileSync(join(output, 'SHA256SUMS'), `${release.artifact.sha256}  ${release.artifact.fileName}\n`);
rmSync(temporary, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ output, archive, release }, null, 2)}\n`);
