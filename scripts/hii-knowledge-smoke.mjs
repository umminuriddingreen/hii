#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-knowledge-'));
process.env.HII_DB_PATH = path.join(directory, 'hii.db');
process.env.HII_RUNTIME_DIR = path.join(directory, 'runtime');
process.env.HII_VAULT_PATH = path.join(directory, 'vault');

const knowledge = await import('../lib/server/hii-knowledge.ts');
const vault = await import('../lib/server/hii-vault.ts');
const systems = await import('../lib/server/hii-knowledge-systems.ts');

try {
  const atlas = knowledge.createKnowledgeNote({
    title: 'Atlas',
    folder: 'Projects/HII',
    content: '# Atlas\n\nThe system map for [[HII Knowledge]].\n\n#architecture #hii/core'
  });
  assert.equal(atlas.note.title, 'Atlas');
  assert.ok(atlas.note.revision);
  assert.ok(fs.readFileSync(path.join(process.env.HII_VAULT_PATH, atlas.note.path), 'utf8').includes(`hii_id: "${atlas.note.id}"`));
  assert.deepEqual(atlas.tags, ['architecture', 'hii/core']);
  assert.equal(atlas.outgoing[0].targetNoteId, null);

  const workspace = knowledge.createKnowledgeNote({
    title: 'HII Knowledge',
    folder: 'Projects/HII',
    content: '# HII Knowledge\n\nLinked from [[Atlas]].\n\n- [ ] ship local knowledge loop\n\n#hii/core'
  });
  const refreshedAtlas = knowledge.getKnowledgeNote(atlas.note.id);
  assert.equal(refreshedAtlas.outgoing[0].targetNoteId, workspace.note.id);
  assert.equal(knowledge.getKnowledgeNote(workspace.note.id).backlinks.length, 1);

  const search = knowledge.searchKnowledge('system map');
  assert.equal(search[0].id, atlas.note.id);

  const graph = knowledge.knowledgeGraph();
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 2);

  const updated = knowledge.updateKnowledgeNote(atlas.note.id, {
    content: `${atlas.note.content}\n\n## Proof\n\nVerified locally.`,
    ifMatch: atlas.note.revision
  });
  assert.equal(updated.versions.length, 2);
  assert.throws(
    () => knowledge.updateKnowledgeNote(atlas.note.id, { content: 'stale write', ifMatch: atlas.note.revision }),
    /changed after it was opened/
  );
  const restoredVersion = knowledge.restoreKnowledgeVersion(atlas.note.id, 1, updated.note.updatedAt);
  assert.equal(restoredVersion.note.content, atlas.note.content);
  assert.equal(restoredVersion.versions.length, 3);

  knowledge.trashKnowledgeNote(workspace.note.id);
  assert.equal(knowledge.knowledgeWorkspace().trashCount, 1);
  knowledge.restoreKnowledgeNote(workspace.note.id);
  assert.equal(knowledge.knowledgeWorkspace().trashCount, 0);

  const daily = knowledge.openDailyNote('2026-07-14');
  assert.equal(daily.note.path, 'Daily/2026-07-14.md');
  assert.equal(knowledge.openDailyNote('2026-07-14').note.id, daily.note.id);

  const imported = knowledge.importKnowledgeNotes([
    { path: '../Imports/Reference.md', content: '# Reference\n\nImported safely.' }
  ]);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].note.path.includes('..'), false);

  const assetSource = path.join(directory, 'linked.txt');
  fs.writeFileSync(assetSource, 'linked asset');
  const linkedAsset = vault.registerKnowledgeAsset({ projectId: 'HII', name: 'linked.txt', mode: 'link', sourcePath: assetSource, mime: 'text/plain' });
  const copiedAsset = vault.registerKnowledgeAsset({ projectId: 'HII', name: 'copied.txt', mode: 'copy', contentBase64: Buffer.from('copied asset').toString('base64'), mime: 'text/plain' });
  assert.equal(vault.listKnowledgeAssets().length, 2);
  assert.equal(vault.readKnowledgeAsset(linkedAsset.id).content.toString(), 'linked asset');
  assert.equal(vault.readKnowledgeAsset(copiedAsset.id).content.toString(), 'copied asset');
  fs.unlinkSync(assetSource);
  assert.equal(vault.listKnowledgeAssets().find((asset) => asset.id === linkedAsset.id).available, false);

  const outsideNote = path.join(directory, 'outside.md');
  const escapedNote = path.join(process.env.HII_VAULT_PATH, 'Inbox', 'Escape.md');
  fs.writeFileSync(outsideNote, '# Escape\n\nThis must never enter the vault index.');
  fs.symlinkSync(outsideNote, escapedNote);
  knowledge.rebuildKnowledgeIndex();
  assert.equal(knowledge.listKnowledgeNotes().some((note) => note.title === 'Escape'), false);

  const proposal = systems.proposeSystemFromNote(knowledge.getKnowledgeNote(atlas.note.id).note);
  assert.ok(proposal.objects.some((object) => object.kind === 'intent'));
  const accepted = systems.updateKnowledgeObject(proposal.objects[0].id, { status: 'accepted', ifRevision: 1 });
  assert.equal(accepted.status, 'accepted');
  assert.ok(systems.knowledgeSystemSnapshot(proposal.projectId).views.some((view) => view.kind === 'system-map'));

  const atlasFile = path.join(process.env.HII_VAULT_PATH, atlas.note.path);
  fs.appendFileSync(atlasFile, '\nExternal edit.\n');
  assert.ok(knowledge.getKnowledgeNote(atlas.note.id).note.content.includes('External edit.'));
  assert.throws(() => knowledge.updateKnowledgeNote(atlas.note.id, { content: 'overwrite', ifMatch: restoredVersion.note.revision }), /changed after it was opened/);

  const exported = knowledge.exportKnowledgeWorkspace();
  assert.equal(exported.exportKind, 'hii.knowledge.workspace');
  assert.equal(exported.localOnly, true);
  assert.equal(exported.authority, 'markdown-vault');
  assert.equal(exported.assets.length, 2);
  assert.equal(exported.notes.length, 4);

  const workspaceState = knowledge.knowledgeWorkspace();
  assert.equal(workspaceState.stats.notes, 4);
  assert.ok(workspaceState.events.length >= 6);
  assert.ok(workspaceState.projects.some((project) => project.id === 'HII'));

  knowledge.resetKnowledgeDbForTests();
  const restoredWorkspace = knowledge.knowledgeWorkspace();
  assert.equal(restoredWorkspace.stats.notes, 4);
  assert.equal(restoredWorkspace.authority, 'markdown-vault');

  console.log('HII knowledge smoke');
  console.log('status:      ok');
  console.log('notes:       4');
  console.log('links:       resolved + backlinks verified');
  console.log('search:      FTS5 verified');
  console.log('history:     optimistic conflict + version restore verified');
  console.log('vault:       Markdown authority + external edit indexing verified');
  console.log('assets:      copied + linked + missing-source state verified');
  console.log('systems:     proposal + review + saved map verified');
  console.log('security:    traversal sanitization + symlink escape verified');
  console.log('lifecycle:   create/save/trash/restore/daily/import/export/restart verified');
} finally {
  knowledge.resetKnowledgeDbForTests();
  fs.rmSync(directory, { recursive: true, force: true });
}
