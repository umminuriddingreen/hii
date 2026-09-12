import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasToolbar, type CanvasToolbarProps } from '@/components/workspace/CanvasToolbar';
import { CanvasSelectionBar } from '@/components/workspace/CanvasSelectionBar';
import { CanvasObjectInspector } from '@/components/workspace/CanvasObjectInspector';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('shared canvas controls', () => {
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

  const renderToolbar = (overrides: Partial<CanvasToolbarProps> = {}) => {
    const props: CanvasToolbarProps = { activeTool: 'select', onToolChange: vi.fn(), ...overrides };
    act(() => root.render(<CanvasToolbar {...props} />));
    return props;
  };

  it('offers the complete creation grammar and reports the active tool', () => {
    const props = renderToolbar();
    const labels = ['Select', 'Text', 'Sticky', 'Shape', 'Connector', 'Table', 'Draw', 'Media'];
    for (const label of labels) expect(container.querySelector(`[aria-label^="${label}"]`)).not.toBeNull();
    expect(container.querySelector('[aria-label^="Select"]')?.getAttribute('aria-pressed')).toBe('true');
    act(() => (container.querySelector('[aria-label^="Shape"]') as HTMLButtonElement).click());
    expect(props.onToolChange).toHaveBeenCalledWith('shape');
  });

  it('renders desktop capabilities without exposing Remote', () => {
    const terminal = vi.fn();
    renderToolbar({ capabilities: { scenes: true, export: true, nativeTerminal: true, search: true, activity: true }, onOpenTerminal: terminal });
    act(() => (container.querySelector('[aria-label="Canvas utilities"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain('Terminal');
    expect(container.textContent).toContain('Search');
    expect(container.textContent).toContain('Activity');
    expect(container.textContent).not.toContain('HII Remote');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Terminal'))!.click());
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Canvas utilities"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders only HII Remote for the web-specific capability', () => {
    renderToolbar({ capabilities: { remote: true }, onOpenRemote: vi.fn() });
    act(() => (container.querySelector('[aria-label="Canvas utilities"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain('HII Remote');
    expect(container.textContent).not.toContain('Terminal');
  });

  it('dispatches contextual selection actions and hides at zero selection', () => {
    const onAction = vi.fn();
    act(() => root.render(<CanvasSelectionBar selectionCount={2} onAction={onAction} />));
    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('2 canvas objects selected');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Ask HII'))!.click());
    expect(onAction).toHaveBeenCalledWith('ask-hii');
    act(() => root.render(<CanvasSelectionBar selectionCount={0} onAction={onAction} />));
    expect(container.innerHTML).toBe('');
  });

  it('makes lock state inspectable and reversible', () => {
    const onLockedChange = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(<CanvasObjectInspector title="Site strategy" typeLabel="Sticky" locked fields={[{ label: 'Source', value: 'brief.pdf', detail: 'read only' }]} onLockedChange={onLockedChange} onClose={onClose} />));
    expect(container.textContent).toContain('Site strategy');
    expect(container.textContent).toContain('brief.pdf');
    expect(container.textContent).toContain('read only');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Unlock'))!.click());
    expect(onLockedChange).toHaveBeenCalledWith(false);
    act(() => (container.querySelector('[aria-label="Close inspector"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
