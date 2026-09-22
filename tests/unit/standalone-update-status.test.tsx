import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasToolbar } from '@/components/workspace/CanvasToolbar';
import { UpdateBanner, UpdateStatusProvider } from '@/components/workspace/UpdateBanner';
import { hiiUpdateStatus } from '@/lib/client/hii-bridge';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/client/hii-bridge', async (original) => ({
  ...await original<object>(),
  hiiUpdateStatus: vi.fn().mockResolvedValue({ source: { commit: '12345678', dirty: false, changedFiles: 0 }, featureRunCount: 0, featureRuns: [] })
}));
vi.mock('@/lib/client/hii-updates', () => ({
  checkForUpdate: vi.fn().mockResolvedValue({ status: 'current' }),
  installUpdate: vi.fn()
}));

describe('standalone update status', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });

  it('opens the single standalone banner from the command palette', async () => {
    await act(async () => root.render(<UpdateStatusProvider><>
      <UpdateBanner />
      <CanvasToolbar activeTool="select" onToolChange={vi.fn()} onUpdateStatus={() => container.querySelector<HTMLButtonElement>('.hii-update-banner button')?.click()} />
    </></UpdateStatusProvider>));
    expect(container.querySelectorAll('.hii-update-banner')).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open HII companion"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[aria-label="Save to HII or search commands"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'update');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('HII update and source status'));
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(hiiUpdateStatus).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.hii-update-banner')).toHaveLength(1);
  });
});
