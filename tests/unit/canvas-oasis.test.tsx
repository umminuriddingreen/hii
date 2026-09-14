import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasOasis } from '@/components/workspace/CanvasOasis';
import { commandShortcutFromEvent, commandShortcutLabel, matchesCommandShortcut } from '@/lib/workspace/command-shortcut';
import { semanticZoomLevel } from '@/components/workspace/useCamera';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('canvas oasis', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('starts with direct capture and adds a validated web object', () => {
    const onLink = vi.fn();
    const onNote = vi.fn();
    act(() => root.render(<CanvasOasis empty recent={[]} spaces={[]} onCommand={vi.fn()} onNote={onNote} onFile={vi.fn()} onLink={onLink} onFocus={vi.fn()} onFit={vi.fn()} />));
    expect(container.textContent).toContain('What are you working on?');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Note')!.click());
    expect(onNote).toHaveBeenCalledOnce();
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Link')!.click());
    const input = container.querySelector('input[type="url"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'https://example.com/study');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onLink).toHaveBeenCalledWith('https://example.com/study');
  });

  it('keeps recent objects and spaces as navigation into the same canvas', () => {
    const onFocus = vi.fn();
    act(() => root.render(<CanvasOasis empty={false} recent={[{ id: 'a', title: 'Facade PDF' }]} spaces={[{ id: 's', title: 'School', count: 4 }]} onCommand={vi.fn()} onNote={vi.fn()} onFile={vi.fn()} onLink={vi.fn()} onFocus={onFocus} onFit={vi.fn()} />));
    expect(container.textContent).toBe('Overview');
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Facade PDF')!.click());
    expect(onFocus).toHaveBeenCalledWith('a');
  });
});

describe('canvas zoom and shortcut boundaries', () => {
  it('changes detail at stable camera bands', () => {
    expect([0.1, 0.3, 0.6, 1].map(semanticZoomLevel)).toEqual(['territory', 'space', 'objects', 'detail']);
  });

  it('records only modified shortcuts and matches the saved combination', () => {
    const event = { code: 'KeyJ', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true };
    const shortcut = commandShortcutFromEvent(event)!;
    expect(commandShortcutLabel(shortcut)).toBe('⌥⇧J');
    expect(matchesCommandShortcut(event, shortcut)).toBe(true);
    expect(commandShortcutFromEvent({ ...event, altKey: false, shiftKey: false })).toBeNull();
  });
});
