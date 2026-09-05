import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopHiiAccess } from '@/components/desktop/DesktopHiiAccess';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ status: vi.fn(), list: vi.fn(), selection: vi.fn(), save: vi.fn() }));
vi.mock('@phosphor-icons/react', () => ({ ChatCircle: () => null, SquaresFour: () => null, UserCircle: () => null, SidebarSimple: () => null, X: () => null }));
vi.mock('@/lib/desktop/account-sync', () => ({
  accountSyncStatus: api.status,
  listNativeAccountWorkspaces: api.list,
  linkAccountSync: vi.fn(),
  NativeAccountWorkspacePersistence: class { constructor(readonly workspaceId: string) {} dispose() {} }
}));
vi.mock('@/lib/desktop/account-selection', async (original) => ({
  ...await original<object>(), readAccountWorkspaceSelection: api.selection, saveAccountWorkspaceSelection: api.save
}));
vi.mock('@/components/workspace/HiiRoot', () => ({ HiiRoot: ({ spaceId }: { spaceId: string }) => <div data-testid="canvas">{spaceId || 'local'}</div> }));
vi.mock('@/components/desktop/chat/LocalChatSurface', () => ({ LocalChatSurface: () => <div>Chat</div> }));

describe('desktop account access', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    api.status.mockResolvedValue({ linked: true });
    api.list.mockResolvedValue({ account: { handle: 'Ummi' }, device: { name: 'PC' }, workspaces: [{ id: 'canvas-a', name: 'Personal', role: 'owner' }] });
    api.selection.mockResolvedValue({ deviceId: 'device', configured: true, workspaceId: 'canvas-a' });
    api.save.mockResolvedValue({});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<DesktopHiiAccess />)); }
  it('restores the account canvas and exposes account controls', async () => {
    await render();
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('canvas-a');
    const account = container.querySelector<HTMLButtonElement>('button[title="HII account"]')!;
    await act(async () => account.click());
    expect(container.querySelector('[aria-label="HII account synchronization"]')?.textContent).toContain('Ummi');
    expect(api.save).not.toHaveBeenCalled();
  });
  it('keeps the local canvas available when not linked', async () => {
    api.status.mockResolvedValue({ linked: false });
    await render();
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('local');
    expect(api.list).not.toHaveBeenCalled();
  });
  it('does not expose an empty editable canvas when account loading fails', async () => {
    api.list.mockRejectedValue(new Error('Connection unavailable'));
    await render();
    expect(container.querySelector('[data-testid="canvas"]')).toBeNull();
    expect(container.textContent).toContain('Connection unavailable');
  });
  it('persists explicit local selection before changing canvas', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Workspaces"]')!.click());
    const local = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('this device'))!;
    await act(async () => local.click());
    expect(api.save).toHaveBeenCalledWith(null);
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('local');
  });
});
