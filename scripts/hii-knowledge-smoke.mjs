#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-knowledge-'));
process.env.HII_DB_PATH = path.join(directory, 'hii.db');

const knowledge = await import('../lib/server/hii-knowledge.ts');

try {
  const atlas = knowledge.createKnowledgeNote({
    title: 'Atlas',
    folder: 'Projects/HII',
    content: '# Atlas\n\nThe system map for [[HII Knowledge]].\n\n#architecture #hii/core'
  });
  assert.equal(atlas.note.title, 'Atlas');
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
    ifMatch: atlas.note.updatedAt
  });
  assert.equal(updated.versions.length, 2);
  assert.throws(
    () => knowledge.updateKnowledgeNote(atlas.note.id, { content: 'stale write', ifMatch: atlas.note.updatedAt }),
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

  const exported = knowledge.exportKnowledgeWorkspace();
  assert.equal(exported.exportKind, 'hii.knowledge.workspace');
  assert.equal(exported.localOnly, true);
  assert.equal(exported.notes.length, 4);

  const workspaceState = knowledge.knowledgeWorkspace();
  assert.equal(workspaceState.stats.notes, 4);
  assert.ok(workspaceState.events.length >= 6);

  console.log('HII knowledge smoke');
  console.log('status:      ok');
  console.log('notes:       4');
  console.log('links:       resolved + backlinks verified');
  console.log('search:      FTS5 verified');
  console.log('history:     optimistic conflict + version restore verified');
  console.log('lifecycle:   create/save/trash/restore/daily/import/export verified');
} finally {
  knowledge.resetKnowledgeDbForTests();
  fs.rmSync(directory, { recursive: true, force: true });
}
