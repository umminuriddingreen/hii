import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

describe('HII performance contract', () => {
  it('renders the canonical workspace before optional account synchronization', () => {
    const source = readFileSync(resolve(root, 'components/desktop/DesktopHiiAccess.tsx'), 'utf8');
    expect(source).toContain('<HiiRoot');
    expect(source).not.toContain('if (!ready)');
    expect(source).not.toContain('opening HII…');
  });

  it('defers uncommon workspace applications out of the initial interaction path', () => {
    const source = readFileSync(resolve(root, 'components/workspace/HiiRoot.tsx'), 'utf8');
    expect(source).toContain("lazy(() => import('./NativeDevBrowser')");
    expect(source).toContain("lazy(() => import('./HiiMarketplace')");
    expect(source).toContain('<DeferredSurface>');
  });

  it('backs off hidden application polling and skips off-screen object paint', () => {
    const workspace = readFileSync(resolve(root, 'components/workspace/HiiRoot.tsx'), 'utf8');
    const css = readFileSync(resolve(root, 'app/globals.css'), 'utf8');
    expect(workspace).toContain('cancelled || document.hidden || applicationPollActive.current');
    expect(workspace).toContain('window.setInterval(() => void poll(), 4000)');
    expect(css).toContain('content-visibility: auto');
    expect(css).toContain(':not([data-node-type="terminal"])');
  });

  it('makes the persistent objective the direct canvas entry point', () => {
    const source = readFileSync(resolve(root, 'components/workspace/HiiRoot.tsx'), 'utf8');
    expect(source).toContain('objectiveSeedFromText(event.key, { mode, contextNodeIds: selected })');
    expect(source).toContain('aria-label="Persistent objective"');
    expect(source).not.toContain('agentTerminalSeedFromText(event.key');
    expect(source).not.toContain("visibleNodes.filter((node) => node.type !== 'intent')");
  });
});
