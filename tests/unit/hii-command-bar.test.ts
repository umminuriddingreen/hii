import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('minimal HII command bar', () => {
  const root = read('components/workspace/HiiRoot.tsx');
  const css = read('app/globals.css');
  const bridge = read('lib/client/hii-bridge.ts');

  it('keeps the contextual prompt compact while Command-K routes to the PTY', () => {
    expect(root).toContain("event.key.toLowerCase() === 'k'");
    expect(root).toContain("ensureWorkspaceTerminal('quick')");
    expect(root).toContain('const promptWidth = Math.min(560');
    expect(root).toContain('<PromptResponse value={visibleResponse} running={running}');
    expect(root).not.toContain('<InferenceConstellation');
    expect(css).toContain('.hii-prompt-line { position: relative; display: grid;');
    expect(css).toContain('min-height: 42px;');
  });

  it('offers Commands and Settings from the compact menu', () => {
    expect(root).toContain('aria-label="Commands and settings"');
    expect(root).toContain("setMenu('commands')");
    expect(root).toContain("setMenu('settings')");
    expect(root).toContain('Direct model stream');
  });

  it('opens the complete keyboard command list with question mark', () => {
    expect(root).toContain("event.key === '?'");
    expect(root).toContain("(event.metaKey || event.ctrlKey) && event.key === '?'");
    expect(root).toContain("menu: 'commands'");
    expect(root).toContain("['⌘ K', 'Quick terminal']");
    expect(root).toContain("['⌘ T', 'Search Google on the canvas']");
    expect(root).toContain("['Esc', 'Dismiss, clear, or open canvas manager']");
  });

  it('preserves exact web response deltas', () => {
    expect(bridge).toContain("nextText.slice(previousText.length) : nextText");
    expect(bridge).toContain("kind: delta ? 'delta' : state.kind");
  });
});
