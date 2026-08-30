import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeFrame } from '@/components/workspace/NodeFrame';
import type { WorkspaceNode } from '@/lib/workspace/types';

const terminalNode: WorkspaceNode = {
  id: 'terminal-1',
  type: 'terminal',
  x: 40,
  y: 60,
  w: 620,
  h: 320,
  z: 1,
  rotation: 0,
  payload: { title: 'terminal · hii' }
};

describe('terminal canvas frame', () => {
  it('renders persistent desktop close and resize controls', () => {
    const html = renderToStaticMarkup(
      <NodeFrame
        node={terminalNode}
        selected
        title="terminal · hii"
        getZoom={() => 1}
        onSelect={() => undefined}
        onOpenConversation={() => undefined}
        onCommit={() => undefined}
        onErase={() => undefined}
      >
        <div>terminal body</div>
      </NodeFrame>
    );

    expect(html).toContain('data-node-type="terminal"');
    expect(html).toContain('class="hii-terminal-close"');
    expect(html).toContain('aria-label="Close terminal · hii"');
    expect(html).toContain('class="hii-terminal-resize"');
    expect(html).toContain('aria-label="Resize terminal · hii"');
  });
});
