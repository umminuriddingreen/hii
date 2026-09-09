// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HiiWebAccess } from '../../components/auth/HiiWebAccess';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ mounts: vi.fn(), unsaved: undefined as undefined | ((value: boolean) => void), writes: vi.fn() }));
vi.mock('@/components/workspace/HiiRoot', () => ({ HiiRoot: (props: { spaceId: string; onUnsavedChanges: (value: boolean) => void }) => {
  state.unsaved = props.onUnsavedChanges;
  useEffect(() => { state.mounts(props.spaceId || 'guest'); }, []);
  return <div data-testid="canvas">{props.spaceId || 'guest'}</div>;
} }));
vi.mock('@/components/marketing/AsciiWave', () => ({ AsciiWave: () => null }));
vi.mock('@/components/auth/HiiWebPanels', () => ({ HiiWebPanel: () => null }));
vi.mock('@/components/spaces/SpaceCanvas', () => ({ browserSpacePersistence: (id: string) => ({ id, write: state.writes }) }));
vi.mock('@/lib/web/canvas-assets', () => ({ browserCanvasSeedsFromFiles: vi.fn(), hydrateBrowserCanvasAssets: vi.fn() }));
vi.mock('@/lib/web/account-workspace', () => ({
  AccountWorkspacePersistence: class { write = state.writes; dispose() {} },
  listAccountWorkspaces: vi.fn(async () => [{ id: 'account-work', name: 'Personal', role: 'owner' }]),
  listAccountDevices: vi.fn(async () => []), listWorkspaceMembers: vi.fn(async () => [])
}));

describe('browser canvas identity continuity', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    window.history.replaceState(null, '', '/?first-run=1');
    vi.stubGlobal('PublicKeyCredential', class {});
    const bytes = new Uint8Array([1]).buffer;
    vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => ({ id: 'key', rawId: bytes, type: 'public-key', response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes, userHandle: null } })) } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/start')
      ? { ceremonyId: 'ceremony', publicKey: { challenge: 'AQ' } }
      : { authenticated: true, accountId: 'a'.repeat(43), handle: 'Ummi', csrfToken: 'csrf' } })));
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function click(text: string) {
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === text);
    expect(button, text).toBeTruthy();
    await act(async () => button!.click());
  }
  async function login() {
    await act(async () => root.render(<HiiWebAccess />));
    await click('hii'); await click('log in'); await click('continue');
  }
  it('keeps the guest document mounted through login and switches only on request', async () => {
    await login();
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('guest');
    expect(state.mounts).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Ummi');
    expect(container.textContent).toContain('signing in does not upload or synchronize this canvas');
    expect(state.writes).not.toHaveBeenCalled();
    await click('open account workspace');
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('account-work');
    await click('open browser-only canvas');
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('guest');
    expect(container.textContent).toContain('Ummi');
    expect(container.textContent).toContain('log out');
  });
  it('guards unsaved work in both directions', async () => {
    await login();
    state.unsaved!(true);
    await click('open account workspace');
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('guest');
    expect(container.textContent).toContain('Save or retry');
    state.unsaved!(false);
    await click('open account workspace');
    state.unsaved!(true);
    await click('open browser-only canvas');
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('account-work');
    expect(container.textContent).toContain('Save or retry');
  });
});
