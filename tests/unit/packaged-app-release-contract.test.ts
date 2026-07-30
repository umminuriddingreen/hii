import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const tauriConfig = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const smoke = readFileSync(resolve(root, 'scripts/hii-packaged-app-smoke.mjs'), 'utf8');
const portableBuild = readFileSync(resolve(root, 'scripts/hii-svelte-tauri-build.mjs'), 'utf8');
const release = readFileSync(resolve(root, 'scripts/hii-macos-release.mjs'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/release-candidate.yml'), 'utf8');

describe('packaged app release candidate contract', () => {
  it('keeps the expensive clean-machine proof behind an explicit release gate', () => {
    expect(packageJson.scripts['hii:packaged-app:check']).toBe(
      'node scripts/hii-packaged-app-smoke.mjs'
    );
    expect(packageJson.scripts['ci:release-candidate']).toContain('build:tauri');
    expect(packageJson.scripts['ci:release-candidate']).toContain('hii:packaged-app:check');
    expect(packageJson.scripts['ci:product']).not.toContain('hii:packaged-app:check');
  });

  it('proves isolation, receipt compatibility, and recovery from packaged resources', () => {
    expect(smoke).toContain("path.join(temporaryRoot, 'Applications', 'HII.app')");
    expect(smoke).toContain("HII_RUNTIME_DIR: runtimeDir");
    expect(smoke).toContain("kind: 'receipt'");
    expect(smoke).toContain('afterReinstall.body.workspace.nodes[0].object.kind');
    expect(smoke).toContain("item.id === 'broken' && item.status === 'recovery'");
    expect(smoke).toContain("'--verify', '--deep', '--strict'");
    expect(portableBuild).toContain("['ws','node-pty','yaml']");
  });

  it('provides a manual macOS CI proof without uploading or publishing the app', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('runs-on: macos-14');
    expect(workflow).toContain('npm run ci:release-candidate');
    expect(workflow).not.toContain('upload-artifact');
    expect(workflow).not.toContain('action-gh-release');
    expect(workflow).not.toContain('gh release');
  });

  it('binds a public Mac archive to one clean committed release identity', () => {
    expect(packageJson.version).toBe('0.1.0');
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(tauriConfig.version).toBe(packageJson.version);
    expect(release).toContain("capture('git', ['rev-parse', '--verify', 'HEAD'])");
    expect(release).toContain("capture('git', ['status', '--porcelain', '--untracked-files=all'])");
    expect(release.match(/requireSourceIdentity\(gitCommit\)/g)).toHaveLength(2);
    expect(release).toContain("gitTree: 'clean'");
    expect(release).toContain('gitCommit');
  });
});
