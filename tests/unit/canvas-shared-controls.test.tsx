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

  const openCommands = () => act(() => (container.querySelector('[aria-label="Open HII companion"]') as HTMLButtonElement).click());

  it('starts with compact canvas tools and runs a canvas command', () => {
    const props = renderToolbar();
    expect(container.querySelectorAll('[aria-label="Open HII companion"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Note"]')).toHaveLength(1);
    openCommands();
    expect(container.querySelector('[aria-label="Save to HII or search commands"]')).not.toBeNull();
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('Shape'))!.click());
    expect(props.onToolChange).toHaveBeenCalledWith('shape');
    expect(container.querySelector('[aria-label="Save to HII or search commands"]')).toBeNull();
  });

  it('routes desktop capabilities without suggesting unavailable remote control', () => {
    const terminal = vi.fn();
    renderToolbar({ capabilities: { scenes: true, export: true, nativeTerminal: true, search: true, activity: true }, onOpenTerminal: terminal });
    openCommands();
    expect(container.textContent).toContain('Terminal');
    expect(container.textContent).not.toContain('HII Remote');
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('Terminal'))!.click());
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('stages an unmatched work intent for review without running it', () => {
    const startWork = vi.fn();
    renderToolbar({ onStartWork: startWork });
    openCommands();
    const input = container.querySelector('[aria-label="Save to HII or search commands"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'organize my project research');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Use as a task');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(startWork).toHaveBeenCalledWith('organize my project research');
    expect(container.querySelector('[aria-label="Save to HII or search commands"]')).toBeNull();
  });

  it('saves pasted context locally before offering agent work', () => {
    const capture = vi.fn();
    const startWork = vi.fn();
    renderToolbar({ onCaptureText: capture, onStartWork: startWork });
    openCommands();
    const input = container.querySelector('[aria-label="Save to HII or search commands"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'A useful excerpt from my conversation');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]?.textContent).toContain('Save to HII');
    expect(container.textContent).toContain('Use as a task');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(capture).toHaveBeenCalledWith('A useful excerpt from my conversation');
    expect(startWork).not.toHaveBeenCalled();
  });

  it('shows selected context and submits free-form work from the same field', () => {
    const startWork = vi.fn();
    renderToolbar({ selectionLabels: ['Facade PDF', 'Section drawing'], onStartWork: startWork });
    openCommands();
    expect(container.querySelector('[aria-label="2 selected canvas objects"]')?.textContent).toContain('Facade PDF');
    const input = container.querySelector('[aria-label="Save to HII or search commands"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'compare these references');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(startWork).toHaveBeenCalledWith('compare these references');
  });

  it('saves a feature request through the supplied local board action', async () => {
    const request = vi.fn().mockResolvedValue('added 12345678  Better canvas');
    renderToolbar({ onRequestFeature: request });
    openCommands();
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('Request a feature'))!.click());
    const input = container.querySelector('#hii-feature-request') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Better canvas');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(request).toHaveBeenCalledWith('Better canvas');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('added 12345678');
  });

  it('shows only HII Remote for the web-specific capability', () => {
    renderToolbar({ capabilities: { remote: true }, onOpenRemote: vi.fn() });
    openCommands();
    expect(container.textContent).toContain('HII Remote');
    expect(container.textContent).not.toContain('Terminal');
  });

  it('dispatches contextual selection actions and hides at zero selection', () => {
    const onAction = vi.fn();
    act(() => root.render(<CanvasSelectionBar selectionCount={2} onAction={onAction} />));
    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('2 canvas objects selected');
    expect(container.textContent).not.toContain('Ask HII');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Inspect'))!.click());
    expect(onAction).toHaveBeenCalledWith('inspect');
    act(() => root.render(<CanvasSelectionBar selectionCount={0} onAction={onAction} />));
    expect(container.innerHTML).toBe('');
  });

  it('makes lock state inspectable and reversible', () => {
    const onLockedChange = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(<CanvasObjectInspector title="Site strategy" typeLabel="Sticky" locked fields={[{ label: 'Source', value: 'brief.pdf', detail: 'read only' }]} onLockedChange={onLockedChange} onClose={onClose} />));
    expect(container.textContent).toContain('Site strategy');
    expect(container.textContent).toContain('brief.pdf');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Unlock'))!.click());
    expect(onLockedChange).toHaveBeenCalledWith(false);
    act(() => (container.querySelector('[aria-label="Close inspector"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
