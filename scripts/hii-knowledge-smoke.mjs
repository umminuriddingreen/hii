#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-knowledge-'));
process.env.HII_DB_PATH = path.join(directory, 'hii.db');
process.env.HII_RUNTIME_DIR = path.join(directory, 'runtime');

const knowledge = await import('../lib/server/hii-knowledge.ts');
const vault = await import('../lib/server/hii-vault.ts');
const systems = await import('../lib/server/hii-knowledge-systems.ts');
const migration = await import('../lib/server/hii-knowledge-import.ts');

try {
  const atlas = knowledge.createKnowledgeNote({
    title: 'Atlas',
    folder: 'Projects/HII',
    content: '# Atlas\n\nThe system map for [[HII Knowledge]].\n\n#architecture #hii/core'
  });
  assert.equal(atlas.note.title, 'Atlas');
  assert.ok(atlas.note.revision);
  assert.equal(knowledge.knowledgeWorkspace().authority, 'hii-database');
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

  knowledge.rebuildKnowledgeIndex();

  const proposal = systems.proposeSystemFromNote(knowledge.getKnowledgeNote(atlas.note.id).note);
  assert.ok(proposal.objects.some((object) => object.kind === 'intent'));
  const accepted = systems.updateKnowledgeObject(proposal.objects[0].id, { status: 'accepted', ifRevision: 1 });
  assert.equal(accepted.status, 'accepted');
  assert.ok(systems.knowledgeSystemSnapshot(proposal.projectId).views.some((view) => view.kind === 'system-map'));

  const sourceRoot = path.join(directory, 'obsidian');
  fs.mkdirSync(path.join(sourceRoot, 'System'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'System', 'Index.md'), '---\nid: stable-system-index\naliases:\n  - System Home\ntags: [hii, system]\n---\n# System Index\n\nConnect [[Atlas]].\n');
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'name,status\nHII,active\n');
  fs.writeFileSync(path.join(sourceRoot, 'view.base'), 'filters:\n  and:\n    - status == "active"\n');
  fs.symlinkSync(path.join(sourceRoot, 'System', 'Index.md'), path.join(sourceRoot, 'linked.md'));
  const secretStore = path.join(process.env.HII_RUNTIME_DIR, 'vault.json');
  fs.mkdirSync(path.dirname(secretStore), { recursive: true });
  fs.writeFileSync(secretStore, '{"encrypted":"preserve-me"}\n');
  const secretHash = migration.assertSecretsVaultUntouched('').currentHash;
  const plan = migration.planKnowledgeImport(sourceRoot);
  assert.equal(plan.manifest.totals.files, 3);
  assert.ok(plan.manifest.excluded.some((item) => item.reason === 'symbolic-link'));
  const merged = migration.executeKnowledgeImport(plan.batchId, plan.planHash, plan.approvalToken);
  assert.equal(merged.ok, true);
  assert.equal(knowledge.getKnowledgeNote('stable-system-index').note.title, 'Index');
  assert.equal(migration.planKnowledgeImport(sourceRoot).status, 'completed');
  assert.equal(migration.assertSecretsVaultUntouched(secretHash).unchanged, true);

  const rollbackRoot = path.join(directory, 'rollback-source');
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const rollbackSource = '# Temporary import\n\nRollback must preserve this source.\n';
  fs.writeFileSync(path.join(rollbackRoot, 'Temporary.md'), rollbackSource);
  const rollbackPlan = migration.planKnowledgeImport(rollbackRoot);
  const rollbackMerge = migration.executeKnowledgeImport(rollbackPlan.batchId, rollbackPlan.planHash, rollbackPlan.approvalToken);
  const rollbackNoteId = rollbackPlan.manifest.files[0].noteId;
  assert.equal(rollbackMerge.ok, true);
  assert.ok(systems.knowledgeSystemSnapshot().objects.some((object) => object.externalRef === `note:${rollbackNoteId}`));
  const rolledBack = migration.rollbackKnowledgeImport(rollbackPlan.batchId);
  assert.equal(rolledBack.removed, 1);
  assert.equal(rolledBack.systems.removedObjects, 1);
  assert.equal(knowledge.getKnowledgeNote(rollbackNoteId), null);
  assert.equal(systems.knowledgeSystemSnapshot().objects.some((object) => object.externalRef === `note:${rollbackNoteId}`), false);
  assert.equal(fs.readFileSync(path.join(rollbackRoot, 'Temporary.md'), 'utf8'), rollbackSource);

  const portable = path.join(directory, 'portable');
  const portableReceipt = migration.exportKnowledgeVault(portable);
  assert.ok(portableReceipt.notes >= 5);
  assert.equal(fs.readFileSync(path.join(portable, 'data.csv'), 'utf8'), 'name,status\nHII,active\n');

  const exported = knowledge.exportKnowledgeWorkspace();
  assert.equal(exported.exportKind, 'hii.knowledge.workspace');
  assert.equal(exported.localOnly, true);
  assert.equal(exported.authority, 'hii-database');
  assert.equal(exported.assets.length, 2);
  assert.ok(exported.notes.length >= 5);

  const workspaceState = knowledge.knowledgeWorkspace();
  assert.ok(workspaceState.stats.notes >= 7);
  assert.ok(workspaceState.events.length >= 6);
  assert.ok(workspaceState.projects.some((project) => project.id === 'HII'));

  knowledge.resetKnowledgeDbForTests();
  const restoredWorkspace = knowledge.knowledgeWorkspace();
  assert.ok(restoredWorkspace.stats.notes >= 5);
  assert.equal(restoredWorkspace.authority, 'hii-database');

  console.log('HII knowledge smoke');
  console.log('status:      ok');
  console.log(`notes:       ${restoredWorkspace.stats.notes}`);
  console.log('links:       resolved + backlinks verified');
  console.log('search:      FTS5 verified');
  console.log('history:     optimistic conflict + version restore verified');
  console.log('authority:   canonical HII database + immutable source import verified');
  console.log('assets:      copied + linked + missing-source state verified');
  console.log('systems:     proposal + review + saved map verified');
  console.log('security:    secrets-vault isolation + symlink exclusion verified');
  console.log('lifecycle:   create/save/trash/restore/daily/import/verify/rollback/export/restart verified');
} finally {
  knowledge.resetKnowledgeDbForTests();
  fs.rmSync(directory, { recursive: true, force: true });
}
