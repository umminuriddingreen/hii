import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopHiiAccess } from '@/components/desktop/DesktopHiiAccess';
import { useUpdateStatusAccess } from '@/components/workspace/UpdateBanner';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ status: vi.fn(), list: vi.fn(), selection: vi.fn(), save: vi.fn() }));
const local = vi.hoisted(() => ({ list: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/desktop/local-workspaces', () => ({ listLocalWorkspaces: local.list, selectLocalWorkspace: local.select }));
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
vi.mock('@/components/workspace/HiiRoot', () => ({ HiiRoot: ({ spaceId, persistentChrome, surface }: { spaceId: string; persistentChrome: boolean; surface: string }) => {
  const updateStatus = useUpdateStatusAccess();
  return <div data-testid="canvas" data-update-banner-owner={persistentChrome ? 'root' : undefined} data-surface={surface} data-persistent-chrome={String(persistentChrome)} data-update-command={String(Boolean(updateStatus?.openUpdateStatus))}>{spaceId || 'local'}</div>;
} }));
vi.mock('@/components/desktop/chat/LocalChatSurface', () => ({ LocalChatSurface: () => <div>Chat</div> }));
vi.mock('@/components/workspace/UpdateBanner', async (original) => {
  const actual = await original<typeof import('@/components/workspace/UpdateBanner')>();
  return { ...actual, UpdateBanner: () => <aside data-testid="update-banner" /> };
});

describe('desktop account access', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    local.list.mockResolvedValue({ selectedWorkspaceId: 'launch-proof', workspaces: [{ id: 'default', objects: 181, unreadable: false }, { id: 'launch-proof', objects: 33, unreadable: false }] });
    local.select.mockResolvedValue(undefined);
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
    expect(container.querySelector('[data-testid="canvas"]')?.getAttribute('data-persistent-chrome')).toBe('false');
    expect(container.querySelector('[data-testid="canvas"]')?.getAttribute('data-update-command')).toBe('true');
    expect(container.querySelectorAll('[data-testid="update-banner"]')).toHaveLength(1);
    const account = container.querySelector<HTMLButtonElement>('button[aria-label^="HII account"]')!;
    await act(async () => account.click());
    expect(container.querySelector('[aria-label="HII account synchronization"]')?.textContent).toContain('Ummi');
    expect(api.save).not.toHaveBeenCalled();
  });
  it('reveals existing device boards and opens one without uploading it', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Workspaces"]')!.click());
    expect(container.textContent).toContain('181 objects');
    const board = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('default'))!;
    await act(async () => board.click());
    expect(local.select).toHaveBeenCalledWith('default');
    expect(api.save).toHaveBeenCalledWith(null);
    expect(container.textContent).toContain('No content was uploaded');
  });
  it('keeps the local canvas available when not linked', async () => {
    api.status.mockResolvedValue({ linked: false });
    await render();
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('local');
    expect(api.list).not.toHaveBeenCalled();
  });
  it('does not hide existing local work on first account-linked launch', async () => {
    api.selection.mockResolvedValue({ configured: false, workspaceId: null });
    await render();
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe('local');
    expect(api.save).toHaveBeenCalledWith(null);
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
