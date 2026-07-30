import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceRunContextSafe,
  sensitiveWorkspaceContextSource,
  workspaceRunBoundaryManifest
} from '../../lib/workspace/run-boundary';

describe('workspace run boundary manifest', () => {
  it('states that selected context guides a workspace-bounded read authority', () => {
    const manifest = workspaceRunBoundaryManifest({
      context: [
        { id: 'one', title: 'Reference', type: 'image', source: '/project/reference.png' },
        { id: 'two', title: 'Brief', type: 'note' }
      ],
      workspaceRoot: '/project'
    });

    expect(manifest.contextCount).toBe(2);
    expect(manifest.provenanceCount).toBe(1);
    expect(manifest.missingProvenanceCount).toBe(1);
    expect(manifest.readScope).toContain('guide the run');
    expect(manifest.readScope).toContain('other non-secret files inside /project');
    expect(manifest.secretPolicy).toContain('remain blocked');
    expect(manifest.blocked).toBe(false);
  });

  it('fails closed for secret files and credential-bearing URLs', () => {
    expect(sensitiveWorkspaceContextSource('/project/.env.local')).toBe(true);
    expect(sensitiveWorkspaceContextSource('/Users/ummi/.ssh/id_ed25519')).toBe(true);
    expect(sensitiveWorkspaceContextSource('https://example.com/?access_token=value')).toBe(true);
    expect(sensitiveWorkspaceContextSource('/project/reference.png')).toBe(false);
    expect(() =>
      assertWorkspaceRunContextSafe([
        { id: 'secret', title: 'Environment', type: 'text', source: '/project/.env' }
      ])
    ).toThrow('Secret-like files');
  });
});
