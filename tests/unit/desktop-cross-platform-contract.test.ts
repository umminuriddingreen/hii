import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('desktop cross-platform release contract', () => {
  it('builds a current-user Windows installer with an embedded WebView bootstrapper', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    expect(config.bundle.icon).toContain('icons/icon.ico');
    expect(config.bundle.windows.webviewInstallMode.type).toBe('embedBootstrapper');
    expect(config.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(read('package.json')).toContain('build:tauri:windows');
    expect(read('scripts/hii-tauri-build.mjs')).toContain("process.platform === 'win32' ? 'nsis' : 'app'");
  });

  it('packages the correct embedded runtime and profile paths on both platforms', () => {
    expect(read('scripts/hii-svelte-tauri-build.mjs')).toContain("process.platform==='win32'?'node.exe':'node'");
    const desktop = read('src-tauri/src/lib.rs');
    expect(desktop).toContain('std::env::var_os("USERPROFILE")');
    expect(desktop).toContain('join("node.exe")');
    expect(desktop).toContain('#[cfg(target_os = "macos")]');
    expect(read('server/pty-sessions.mjs')).toContain("process.platform === 'win32'");
  });

  it('has a Windows CI install test instead of claiming source compatibility', () => {
    const workflow = read('.github/workflows/windows-packaged-app.yml');
    const smoke = read('scripts/hii-windows-packaged-smoke.ps1');
    expect(workflow).toContain('runs-on: windows-2025');
    expect(workflow).toContain('hii-windows-packaged-smoke.ps1');
    expect(smoke).toContain("'/S'");
    expect(smoke).toContain("'http://127.0.0.1:3042/api/daemon'");
  });
});
