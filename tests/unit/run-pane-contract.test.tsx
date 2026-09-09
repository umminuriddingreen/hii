// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunBody } from '@/components/workspace/RunBody';
import { makeNode } from '@/lib/workspace/ingest';
import type { WorkspaceNode } from '@/lib/workspace/types';

/**
 * What this pins is one regression, and it is the one that already happened:
 * the React rewrite left `run` without a render site, so every bounded run —
 * the one object type carrying approval, progress and a receipt — drew as a
 * monospace dump of its payload for months without anything failing.
 *
 * These assertions are deliberately about affordances a person acts on, not
 * markup. A run that reaches a person must show what it will read before it
 * asks for approval, must not offer approval it cannot honour, and must not
 * present a raw log where a result belongs.
 */

function runNode(payload: Record<string, unknown>): WorkspaceNode {
  return makeNode({ type: 'run', payload } as Parameters<typeof makeNode>[0], 0, 0, 1);
}

function render(node: WorkspaceNode) {
  return renderToStaticMarkup(<RunBody node={node} onApprove={() => {}} onStop={() => {}} />);
}

describe('run pane', () => {
  it('shows the manifest a person is being asked to approve', () => {
    const html = render(
      runNode({
        prompt: 'summarise the receipts directory',
        status: 'waiting_approval',
        workspaceRoot: '/Users/ummi/hii',
        contextFingerprint: 'sha256:abcdef0123456789abcdef0123456789',
        context: [
          {
            id: 'node-1',
            title: 'receipts/2026-09.json',
            type: 'document',
            access: 'read-only',
            provenance: 'authored',
            expectedSha256: '1111111111111111111111111111111111111111111111111111111111111111',
            source: '/Users/ummi/hii/receipts/2026-09.json'
          }
        ]
      })
    );

    expect(html).toContain('summarise the receipts directory');
    expect(html).toContain('receipts/2026-09.json');
    expect(html).toContain('read only');
    expect(html).toContain('sha256 1111111111111111');
    expect(html).toContain('Approve bounded run');
    // The boundary is part of the approval, not a detail behind a disclosure.
    expect(html).toContain('Read boundary');
    expect(html).toContain('Write boundary');
  });

  it('refuses approval when the boundary cannot be honoured', () => {
    const html = render(
      runNode({
        prompt: 'read my keys',
        status: 'waiting_approval',
        context: [{ id: 'node-1', title: '.env', type: 'file', source: '/Users/ummi/hii/.env' }]
      })
    );

    expect(html).toContain('Approve bounded run');
    expect(html).toContain('disabled');
    expect(html).toContain('credential-bearing');
  });

  it('reports a failure as a message, never as the raw log', () => {
    const html = render(
      runNode({
        prompt: 'build the app',
        status: 'failed',
        output: 'thread panicked at src/lib.rs:412: unwrap on None',
        job: { steps: [{ id: 'work', label: 'work', status: 'failed' }] }
      })
    );

    // The panic is reachable, but only inside the disclosure — never as the
    // pane's answer, where it reads as the result of the work.
    expect(html).toContain('Run failed');
    expect(html).toContain('Inspect evidence');
    expect(html).not.toContain('hii-run-answer');
    expect(html.indexOf('thread panicked')).toBeGreaterThan(html.indexOf('hii-run-evidence'));
  });

  it('lands a completed run on evidence rather than prose', () => {
    const html = render(
      runNode({
        prompt: 'run the suite',
        status: 'completed',
        receiptPath: '.hii/receipts/run-1.json',
        receipt: {
          summary: 'Suite passed.',
          artifacts: ['coverage/index.html'],
          verification: [{ command: 'npm test', ok: true }]
        }
      })
    );

    expect(html).toContain('Suite passed.');
    expect(html).toContain('1 passing check');
    expect(html).toContain('1 changed artifact');
    expect(html).toContain('.hii/receipts/run-1.json');
  });
});
