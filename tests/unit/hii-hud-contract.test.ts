import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const desktop = read('src-tauri/src/lib.rs');
const hud = read('src/routes/hud/+page.svelte');
const terminal = read('src/lib/components/TerminalPane.svelte');
const gateway = read('server/pty-gateway.mjs');
const sessions = read('server/pty-sessions.mjs');
const keyboard = read('cli/src/keyboard.rs');

describe('near-cursor HII HUD contract', () => {
  it('summons beside the cursor without replacing the governed Notch shortcut', () => {
    expect(desktop).toContain('Code::Space');
    expect(desktop).toContain('Code::KeyH');
    expect(desktop).toContain('super+shift+space');
    expect(desktop).toContain('alt+h');
    expect(desktop).toContain('"Summon HII"');
    expect(desktop).toContain('position_hii_hud');
    expect(desktop).toContain('cursor_position()');
    expect(desktop).toContain('.always_on_top(true)');
    expect(desktop).toContain('.visible_on_all_workspaces(true)');
  });

  it('captures one bounded, visible, removable screen context before the HUD appears', () => {
    expect(desktop).toContain('remember_screen_context(app)');
    expect(desktop.indexOf('let context = remember_screen_context(app);')).toBeLessThan(
      desktop.indexOf('window.show().map_err')
    );
    expect(desktop).toContain('/usr/sbin/screencapture');
    expect(desktop).toContain('.min(1200.0)');
    expect(desktop).toContain('.min(760.0)');
    expect(desktop).toContain('.hii/ambient/latest-screen.png');
    expect(hud).toContain('Screen context removed');
    expect(hud).toContain('includeContext = !includeContext');
    expect(hud).toContain("invoke<ScreenContext>('refresh_hii_hud_context')");
    expect(hud).toContain('Screen pixels stay local unless the selected model route sends them.');
  });

  it('uses the real interactive HII CLI and stages context for only the next request', () => {
    expect(hud).toContain('program="hii"');
    expect(hud).toContain('`/attach ${context.relativePath}`');
    expect(hud).toContain('includeContext = false');
    expect(gateway).toContain("msg.program !== 'hii'");
    expect(gateway).toContain('program: session.program');
    expect(sessions).toContain("path.join(os.homedir(), 'bin', 'hii')");
    expect(sessions).toContain("requestedProgram === 'hii'");
    expect(sessions).toContain("env.HII_UI_LINE_MODE = '1'");
    expect(keyboard).toContain('env::var_os("HII_UI_LINE_MODE").is_none()');
  });

  it('does not drop a request while the CLI session is starting', () => {
    expect(terminal).toContain('if (!sessionReady || !send');
    expect(terminal).toContain('if (!sessionReady) return;');
    expect(terminal).toContain("msg.t==='created'||msg.t==='attached'");
    expect(terminal).toContain('flushCommands();');
  });
});
