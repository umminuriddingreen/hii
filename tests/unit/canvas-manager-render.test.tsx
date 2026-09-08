import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasManager } from '../../components/workspace/CanvasManager';
import type { WorkspaceNode } from '../../lib/workspace/types';

// React 18 reads this to keep act() from warning about unbatched updates.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function node(
  id: string,
  type: WorkspaceNode['type'],
  options: { title?: string; frameId?: string; updatedAt?: string; x?: number; y?: number } = {}
): WorkspaceNode {
  return {
    id,
    type,
    x: options.x ?? 0,
    y: options.y ?? 0,
    w: 200,
    h: 150,
    z: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: options.updatedAt ?? '2026-08-01T00:00:00.000Z',
    frameId: options.frameId,
    payload: { title: options.title ?? id }
  } as WorkspaceNode;
}

const nodes = [
  node('rooms', 'frame', { title: 'Room schedule' }),
  node('sections', 'frame', { title: 'Wall sections' }),
  node('plan', 'image', { title: 'Level 2 plan', frameId: 'rooms', updatedAt: '2026-08-05T00:00:00.000Z' }),
  node('brief', 'note', { title: 'Client brief', frameId: 'rooms', x: 400 }),
  node('detail', 'cad', { title: 'Parapet detail', frameId: 'sections', updatedAt: '2026-08-09T00:00:00.000Z' }),
  node('stray', 'note', { title: 'Parapet callback', updatedAt: '2026-08-03T00:00:00.000Z' })
];

describe('canvas manager renders and responds', () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;
  const onFocusBoard = vi.fn();
  const onFocusNode = vi.fn();
  const onClose = vi.fn();

  const dialog = () => document.querySelector('[role="dialog"][aria-label="Canvas manager"]')!;
  const search = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Search every board"]')!;
  const cards = () => [...dialog().querySelectorAll('button')].filter((button) => button.querySelector('img, [class*="preview"]'));
  const text = () => dialog().textContent ?? '';

  function type(value: string) {
    const input = search();
    act(() => {
      // React tracks the last value it set, so a plain assignment is ignored.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    onFocusBoard.mockClear();
    onFocusNode.mockClear();
    onClose.mockClear();
    container = document.createElement('div');
    opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <CanvasManager nodes={nodes} onFocusBoard={onFocusBoard} onFocusNode={onFocusNode} onClose={onClose} />
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    opener.remove();
  });

  it('opens on the feed with every board and its object counts', () => {
    expect(text()).toContain('Canvases');
    expect(text()).toContain('Wall sections');
    expect(text()).toContain('Room schedule');
    expect(text()).toContain('Loose objects');
    expect(text()).toContain('2 objects');
    // Newest board first: Wall sections was touched 2026-08-09.
    expect(cards()[0].textContent).toContain('Wall sections');
  });

  it('focuses the search field so typing searches immediately', () => {
    expect(document.activeElement).toBe(search());
    expect(dialog().parentElement).toBe(document.body);
  });

  it('wraps Tab and Shift+Tab inside the dialog, including after filtering', () => {
    const tab = (shiftKey = false) => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      act(() => document.activeElement?.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };
    tab(true);
    expect(document.activeElement).toBe(cards().at(-1));
    tab();
    expect(document.activeElement).toBe(search());
    type('zzzznothing');
    tab(true);
    expect(document.activeElement?.textContent).toBe('Close · Esc');
    tab();
    expect(document.activeElement).toBe(search());
  });

  it('contains outside focus and restores the opener when closed', () => {
    opener.focus();
    expect(document.activeElement).toBe(search());
    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it('offers a pointer-accessible return from an empty canvas', () => {
    act(() => root.render(<CanvasManager nodes={[]} onFocusBoard={onFocusBoard} onFocusNode={onFocusNode} onClose={onClose} />));
    expect(text()).toContain('add text or a file');
    const back = [...dialog().querySelectorAll('button')].find((button) => button.textContent === 'Back to canvas')!;
    act(() => back.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('searches every board at once and names the board each hit lives on', () => {
    type('parapet');
    expect(text()).toContain('Across every board');
    expect(text()).toContain('Parapet detail');
    expect(text()).toContain('Parapet callback');
    // Each hit is attributed, which is what makes a cross-board list navigable.
    expect(text()).toContain('Wall sections');
    expect(text()).toContain('Loose objects');
    // Boards without a hit drop out of the feed.
    expect(text()).not.toContain('Room schedule');
  });

  it('says so plainly when nothing matches', () => {
    type('zzzznothing');
    expect(text()).toContain('Nothing on any board matches');
  });

  it('jumps to the object behind a hit', () => {
    type('parapet');
    const hit = [...dialog().querySelectorAll('button')].find((button) => button.textContent?.includes('Parapet detail'))!;
    act(() => hit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onFocusNode).toHaveBeenCalledTimes(1);
    expect(onFocusNode.mock.calls[0][0].id).toBe('detail');
  });

  it('jumps to the board behind a card', () => {
    act(() => cards()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onFocusBoard).toHaveBeenCalledTimes(1);
    expect(onFocusBoard.mock.calls[0][0].id).toBe('sections');
  });

  it('takes the first hit on Enter so search-then-Enter is one gesture', () => {
    type('parapet');
    act(() => {
      search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onFocusNode.mock.calls[0][0].id).toBe('detail');
  });

  it('closes on Escape', () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
