import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('canvas Runtime boundary', () => {
  const bridge = fs.readFileSync(path.join(process.cwd(), 'lib/client/hii-bridge.ts'), 'utf8');
  const hook = fs.readFileSync(path.join(process.cwd(), 'components/workspace/useWorkspace.ts'), 'utf8');
  const tauri = fs.readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
  const schema = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'protocol/runtime/v1/runtime.schema.json'), 'utf8')
  ) as { $defs: Record<string, unknown> };

  it('reads and writes the canvas through Runtime v1 commands', () => {
    expect(bridge).toContain("invoke<RuntimeSpaceSnapshotV1>('runtime_space_snapshot_v1')");
    expect(bridge).toContain("invoke<RuntimeSpaceSnapshotV1>('runtime_space_apply_v1'");
    expect(bridge).not.toContain("invoke('workspace_write'");
    expect(tauri).toContain('runtime_space_snapshot_v1');
    expect(tauri).toContain('runtime_space_apply_v1');
  });

  it('keeps optimistic UI edits on the last authoritative sequence', () => {
    expect(hook).toContain('Revision is the authoritative Runtime sequence');
    expect(hook).not.toContain('revision: before.revision + 1');
  });

  it('publishes all foundational protocol definitions', () => {
    for (const name of ['object', 'edge', 'event', 'identityRef', 'grant', 'capability', 'run', 'receipt']) {
      expect(schema.$defs[name]).toBeDefined();
    }
  });
});
