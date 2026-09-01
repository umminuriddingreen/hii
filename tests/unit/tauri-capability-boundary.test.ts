import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const capability = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8')
) as {
  windows?: string[];
  webviews?: string[];
  remote?: { urls?: string[] };
};

describe('Tauri capability boundary', () => {
  it('grants IPC to the trusted main webview, not every child in the main window', () => {
    expect(capability.windows).toBeUndefined();
    expect(capability.webviews).toEqual(['main']);
    expect(capability.webviews).not.toContain('hii-browser-*');
  });

  it('keeps localhost HMR scoped to that trusted webview', () => {
    expect(capability.remote?.urls).toContain('http://127.0.0.1:*');
    expect(capability.remote?.urls).toContain('http://localhost:*');
  });

  it('starts the canvas terminal through the bundled HII CLI while preserving an explicit shell entry', () => {
    const terminal = readFileSync(path.join(process.cwd(), 'src-tauri/src/terminal.rs'), 'utf8');
    const bridge = readFileSync(path.join(process.cwd(), 'lib/client/hii-bridge.ts'), 'utf8');
    expect(terminal).toContain('"hii" => hii_command(&app, &cwd)?');
    expect(terminal).toContain('"shell" => shell_command(&cwd)');
    expect(terminal).toContain('terminal commands are restricted to the trusted HII webview');
    expect(bridge).toContain("entry?: 'hii' | 'shell'");
  });
});
