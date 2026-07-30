import assert from 'node:assert/strict';

const { assignNodesToFrame } = await import('../lib/workspace/frames.ts');
const { makeNode, seedFor } = await import('../lib/workspace/ingest.ts');
const {
  adjacentWorkspaceScene,
  workspaceSceneMembers,
  workspaceScenes,
  workspaceSceneTypeSummary
} = await import('../lib/workspace/scenes.ts');
const { emptyWorkspace, normalizeWorkspace } = await import('../lib/workspace/types.ts');
const { fitWorkspaceViewport } = await import('../lib/workspace/viewport.ts');
const {
  workspaceFlattenOutlineEntries,
  workspaceOutlineGroups
} = await import('../lib/workspace/outline.ts');

let z = 0;
const sceneOne = makeNode(seedFor('frame', { title: 'Inputs', sceneOrder: 1 }), 0, 0, ++z);
const sceneTwo = makeNode(seedFor('frame', { title: 'Verified output', sceneOrder: 2 }), 1800, 0, ++z);
sceneOne.w = 1000;
const reference = makeNode(seedFor('image', { title: 'Reference' }), 40, 70, ++z);
const intent = makeNode(seedFor('intent', { title: 'Elevation study' }), 430, 70, ++z);
const receipt = makeNode(seedFor('note', { title: 'Receipt' }), 1840, 70, ++z);

let document = {
  ...emptyWorkspace(),
  nextZ: z,
  nodes: [sceneTwo, receipt, sceneOne, reference, intent]
};
document = assignNodesToFrame(document, sceneOne.id);
document = assignNodesToFrame(document, sceneTwo.id);

const scenes = workspaceScenes(document.nodes);
assert.deepEqual(scenes.map((scene) => scene.payload.title), ['Inputs', 'Verified output']);
assert.equal(sceneOne.object?.kind, 'scene');
assert.deepEqual(
  workspaceSceneMembers(document.nodes, sceneOne.id).map((node) => node.payload.title),
  ['Reference', 'Elevation study']
);
assert.equal(workspaceSceneTypeSummary(workspaceSceneMembers(document.nodes, sceneOne.id)), '1 image · 1 intent');
assert.equal(adjacentWorkspaceScene(scenes, sceneOne.id, 1)?.id, sceneTwo.id);
assert.equal(adjacentWorkspaceScene(scenes, sceneTwo.id, 1)?.id, sceneOne.id);

const firstViewport = fitWorkspaceViewport(
  [sceneOne, ...workspaceSceneMembers(document.nodes, sceneOne.id)],
  { width: 1200, height: 760 },
  { maxZoom: 1.25 }
);
const secondViewport = fitWorkspaceViewport(
  [sceneTwo, ...workspaceSceneMembers(document.nodes, sceneTwo.id)],
  { width: 1200, height: 760 },
  { maxZoom: 1.25 }
);
assert.ok(firstViewport && secondViewport);
assert.notEqual(firstViewport.x, secondViewport.x);

const reloaded = normalizeWorkspace(JSON.parse(JSON.stringify(document)));
assert.equal(workspaceSceneMembers(reloaded.nodes, sceneOne.id).length, 2);
assert.equal(reloaded.nodes.find((node) => node.id === sceneOne.id)?.object?.kind, 'scene');
const outline = workspaceOutlineGroups(reloaded.nodes);
assert.deepEqual(outline.map((group) => group.title), ['Inputs', 'Verified output']);
assert.equal(outline[0].memberCount, 2);
assert.deepEqual(
  workspaceFlattenOutlineEntries(workspaceOutlineGroups(reloaded.nodes, 'elevation')[0].entries)
    .map((entry) => entry.node.payload.title),
  ['Elevation study']
);

console.log('HII workspace scenes smoke');
console.log('status:       ok');
console.log('sequence:     named ordered scenes + wrapping navigation verified');
console.log('membership:   explicit captured object membership + type summary verified');
console.log('orientation:  deterministic scene viewport framing verified');
console.log('outline:      searchable scene + object hierarchy verified');
console.log('persistence:  scene metadata + membership survive reload');
