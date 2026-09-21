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

const workspaceSource = await readFile(new URL('../components/workspace/HiiRoot.tsx', import.meta.url), 'utf8');
assert.match(workspaceSource, /onSelect=\{\(event\) => \{[\s\S]*?workspace\.bringToFront\(node\.id\);/);
assert.match(workspaceSource, /const spawnSeeds = useCallback[\s\S]*workspace\.takeZ\(\)/);
assert.match(workspaceSource, /const spawnInformation = useCallback[\s\S]*column \* 430[\s\S]*row \* 300/);

console.log('HII workspace layout smoke');
console.log('status:       ok');
console.log('focus:        selected object is raised above overlapping work');
console.log('spawn:        direct objects receive monotonic z-order');
console.log('information:  result groups use deterministic rows and columns');
