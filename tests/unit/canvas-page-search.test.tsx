// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickWebSearch } from '@/components/workspace/HiiRoot';

const state = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('@/lib/client/hii-bridge', async (original) => ({
  ...await original<typeof import('@/lib/client/hii-bridge')>(),
  findInformation: state.find
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('canvas saved-page search', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    state.find.mockReset();
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows indexed browser identity and opens a saved result in HII', async () => {
    const onOpen = vi.fn();
    state.find.mockResolvedValue([{ url: 'https://example.org/page', title: 'Survey', excerpt: 'Terrain notes', siteName: 'Example', browserName: 'Safari', versionId: 'version:abc12345', capturedAt: '2026-09-13T12:00:00Z' }]);
    await act(async () => root.render(<QuickWebSearch onDismiss={vi.fn()} onSearch={vi.fn()} onOpen={onOpen} />));
    const input = container.querySelector('input')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'terrain');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(180); await Promise.resolve(); });
    expect(state.find).toHaveBeenCalledWith('terrain', { web: false, limit: 8 });
    expect(container.textContent).toContain('Safari');
    expect(container.textContent).toContain('abc12345');
    await act(async () => container.querySelector('.hii-canvas-search-results article button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpen).toHaveBeenCalledWith('https://example.org/page');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/remote/browser?url=https%3A%2F%2Fexample.org%2Fpage');
  });
});
