import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const workspace = readFileSync(resolve(root, 'src/lib/components/workspace/WorkspacePage.svelte'), 'utf8');

function followUpSource() {
  const start = workspace.indexOf('function followUp(node:WorkspaceNode,text:string){');
  expect(start).toBeGreaterThan(-1);
  const end = workspace.indexOf('function completedRunNodes(', start);
  expect(end).toBeGreaterThan(start);
  return workspace.slice(start, end);
}

describe('workspace follow-up contract', () => {
  const source = followUpSource();

  it('carries the follow-up text into both the intent and its prepared run', () => {
    expect(source).toContain('const followUpText=String(text??\'\').trim();');
    expect(source).toContain('text:followUpText');
    expect(source).toContain('prompt:followUpText');
  });

  it('keeps the source object as approved context for the follow-up', () => {
    expect(source).toContain('contextItemsForNode(node)');
    expect(source).toContain('context:approvedContext');
  });

  it('records the parent relationship for both new nodes', () => {
    // The intent continues the run it was spoken into; the run belongs to that intent.
    expect(source).toContain('parentId:node.id');
    expect(source).toContain('parentId:intentNode.id');
  });

  it('prepares the run without starting it', () => {
    expect(source).toContain('autoStart:false');
    expect(source).toContain("status:'waiting_approval'");
    expect(source).not.toContain("status:'running'");
  });

  it('does not create an empty follow-up', () => {
    expect(source).toContain('if(!followUpText)return;');
  });

  it('commits both nodes as one undoable change', () => {
    expect(source).toContain('nodes:[...doc.nodes,intentNode,runNode]');
    expect(source.match(/remember\(before\)/g)).toHaveLength(1);
  });
});
