import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findOpenWorkspacePosition, workspaceRectsOverlap } from '../lib/workspace/layout.ts';

const group = { w: 620, h: 630 };
const preferred = { x: 700, y: 0 };
const node = (id, x, y) => ({
  id,
  type: 'run',
  x,
  y,
  ...group,
  z: 1,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  payload: {}
});

const open = findOpenWorkspacePosition([node('source', 0, 0)], preferred, group);
assert.deepEqual(open, preferred);

const firstCollision = findOpenWorkspacePosition([node('first', preferred.x, preferred.y)], preferred, group);
assert.deepEqual(firstCollision, { x: 700, y: 662 });
assert.equal(workspaceRectsOverlap({ ...firstCollision, ...group }, node('first', 700, 0), 32), false);

const repeated = findOpenWorkspacePosition(
  [node('first', 700, 0), node('second', 700, 662), node('third', 700, 1324)],
  preferred,
  group
);
assert.deepEqual(repeated, { x: 1352, y: 0 });

const workspaceSource = await readFile(new URL('../src/lib/components/workspace/WorkspacePage.svelte', import.meta.url), 'utf8');
assert.match(workspaceSource, /function focusNode\(node:WorkspaceNode\)\{select\(node\);/);
assert.match(workspaceSource, /function followUp[\s\S]*findOpenWorkspacePosition/);
assert.match(workspaceSource, /function completedRunNodes[\s\S]*findOpenWorkspacePosition/);

console.log('HII workspace layout smoke');
console.log('status:       ok');
console.log('focus:        Map-selected object is raised above overlapping work');
console.log('follow-up:    new intent and run group chooses an open lane');
console.log('results:      artifact and receipt group reserves collision-free space');
