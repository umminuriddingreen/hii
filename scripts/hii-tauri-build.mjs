#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const args = ['build', ...process.argv.slice(2)];
const build = spawnSync(tauri, args, { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

if (process.platform === 'darwin') {
  const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'HII.app');
  const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', bundle], {
    cwd: root,
    stdio: 'inherit'
  });
  if (sign.status !== 0) process.exit(sign.status ?? 1);
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], {
    cwd: root,
    stdio: 'inherit'
  });
  if (verify.status !== 0) process.exit(verify.status ?? 1);
  console.log(`hii signed desktop bundle: ${path.relative(root, bundle)}`);
}
