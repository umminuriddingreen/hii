import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { seedsFromFiles } = await import('../lib/workspace/ingest.ts');
const {
  contactSheetContextItems,
  contactSheetItemSeed,
  filterContactSheetItems,
  labelContactSheetItems
} = await import('../lib/workspace/contact-sheet.ts');

const stored = [];
globalThis.fetch = async (_input, init) => {
  const file = init.body.get('file');
  stored.push(file.name);
  return new Response(JSON.stringify({
    name: file.name,
    mime: file.type,
    size: file.size,
    path: `/tmp/hii-media-proof/${file.name}`,
    url: `/api/workspace/assets/${file.name}`,
    sha256: createHash('sha256').update(file.name).digest('hex')
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const seeds = await seedsFromFiles([
  new File(['same pixels'], 'reference-a.png', { type: 'image/png' }),
  new File(['same pixels'], 'reference-a-copy.png', { type: 'image/png' }),
  new File(['pixels-b'], 'reference-b.png', { type: 'image/png' }),
  new File(['pixels-c'], 'reference-c.png', { type: 'image/png' }),
  new File(['pixels-d'], 'reference-d.png', { type: 'image/png' }),
  new File(['notes'], 'brief.txt', { type: 'text/plain' })
]);

assert.equal(seeds.length, 2);
const sheet = seeds.find((seed) => seed.payload.adapter === 'contact-sheet');
const text = seeds.find((seed) => seed.type === 'text');
assert.ok(sheet);
assert.ok(text);
assert.equal(sheet.payload.uniqueCount, 4);
assert.equal(sheet.payload.duplicateCount, 1);
assert.deepEqual(sheet.payload.duplicateNames, ['reference-a-copy.png']);
assert.equal(sheet.payload.items.length, 4);
assert.equal(sheet.object.kind, 'asset');
assert.equal(sheet.object.status, 'ready');
assert.equal(sheet.object.proofRefs.length, 4);
assert.equal(stored.length, 4);
const selectedItems = [
  sheet.payload.items[1],
  sheet.payload.items[3]
];
const itemLabels = labelContactSheetItems({
  items: sheet.payload.items,
  labels: sheet.payload.itemLabels,
  selectedItems,
  label: 'material palette'
});
const contextItems = contactSheetContextItems({
  nodeId: 'proof-sheet',
  items: sheet.payload.items,
  selectedItems,
  itemLabels,
  proofRefs: sheet.object.proofRefs
});
assert.equal(contextItems.length, 2);
assert.equal(contextItems[0].title, 'material palette');
assert.equal(contextItems[0].source, sheet.payload.items[1].path);
assert.equal(contextItems[0].expectedSha256, sheet.payload.items[1].sha256);
assert.equal(filterContactSheetItems(sheet.payload.items, itemLabels, 'material').length, 2);
const promoted = contactSheetItemSeed(sheet.payload.items[1], 'proof-sheet', 'material palette');
assert.equal(promoted.object.parentId, 'proof-sheet');
assert.deepEqual(promoted.object.proofRefs, [`sha256:${sheet.payload.items[1].sha256}`]);
assert.equal(promoted.payload.adapter, 'contact-sheet-item');

console.log('HII workspace media smoke');
console.log('status:       ok');
console.log('organization: image batch -> bounded contact sheet verified');
console.log('dedupe:       exact SHA-256 duplicate omitted before storage');
console.log('proof:        unique source paths + hashes preserved');
console.log('focus:        exact labeled thumbnails -> separate hashed run context');
console.log('classification: selected references -> durable filterable batch label');
console.log('promotion:    sheet item -> provenance-linked region-focusable image');
console.log('mixed batch:  non-image artifact remains directly editable');
