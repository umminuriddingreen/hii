import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workspace direct manipulation contract', () => {
  const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
  const frame = readFileSync('components/workspace/NodeFrame.tsx', 'utf8');
  const css = readFileSync('app/globals.css', 'utf8');

  it('supports additive click selection and marquee selection', () => {
    expect(frame).toContain('onSelect(event)');
    expect(canvas).toContain('event.shiftKey');
    expect(canvas).toContain('nodesInMarquee(visibleNodes, rect)');
    expect(canvas).toContain('className="hii-selection-marquee"');
    expect(css).toContain('.hii-node[data-editable-content="true"]:not([data-content-active="true"]) .hii-node-body { pointer-events: none; }');
    expect(frame).toContain('if (editableContent)');
    expect(frame).toContain('onActivateContent?.()');
    expect(canvas).toContain('contentActive={activeDocumentId === node.id}');
  });

  it('nudges every selected object with arrow keys', () => {
    expect(canvas).toContain("if (selected.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))");
    expect(canvas).toContain('for (const id of selected)');
    expect(canvas).toContain('const step = event.shiftKey ? 10 : 1');
  });

  it('exposes direct resize, rotation, lock, and transform lifecycle controls', () => {
    expect(frame).toContain("(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const)");
    expect(frame).toContain('hii-node-rotation-handle');
    expect(frame).toContain('onTransformPreview?.(detail(current))');
    expect(frame).toContain('if (onTransformCommit) onTransformCommit(finalDetail)');
    expect(frame).toContain('data-locked={locked || undefined}');
    expect(frame).toContain('selected && locked');
    expect(frame).toContain('Math.hypot(current.clientX - startX, current.clientY - startY) < 4');
    expect(canvas).toContain('transformable={selected.length === 1 && selected[0] === node.id}');
    expect(canvas).toContain('return !additive');
  });
});
