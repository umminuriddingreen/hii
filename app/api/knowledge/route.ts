import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  createKnowledgeNote,
  exportKnowledgeNote,
  exportKnowledgeWorkspace,
  getKnowledgeNote,
  importKnowledgeNotes,
  knowledgeGraph,
  knowledgeWorkspace,
  listKnowledgeNotes,
  openDailyNote,
  rebuildKnowledgeIndex,
  restoreKnowledgeNote,
  restoreKnowledgeVersion,
  searchKnowledge,
  trashKnowledgeNote,
  updateKnowledgeNote
} from '@/lib/server/hii-knowledge';
import { listKnowledgeAssets, readKnowledgeAsset, registerKnowledgeAsset } from '@/lib/server/hii-vault';
import {
  attachRuntimeObject,
  createKnowledgeObject,
  createKnowledgeRelation,
  ensureSystemMap,
  knowledgeSystemSnapshot,
  proposeSystemFromNote,
  saveKnowledgeView,
  updateKnowledgeObject,
  updateKnowledgeRelation
} from '@/lib/server/hii-knowledge-systems';
import { createBoardTask } from '@/lib/server/hii-board';
import { readWorkspace, writeWorkspace } from '@/lib/server/workspace-store';
import type { SpatialObjectKind, WorkspaceNode } from '@/lib/workspace/types';
import {
  executeKnowledgeImport,
  exportKnowledgeVault,
  knowledgeImportStatus,
  planKnowledgeImport,
  rollbackKnowledgeImport,
  verifyKnowledgeImport
} from '@/lib/server/hii-knowledge-import';
import { approveKnowledgeRun, prepareKnowledgeRun, syncKnowledgeRun } from '@/lib/server/hii-knowledge-runs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function denied() {
  return NextResponse.json({ error: 'Local HII access required.' }, { status: 401 });
}

async function migrateWorkspaceRefs() {
  const workspace = await readWorkspace();
  const snapshot = knowledgeSystemSnapshot();
  let changed = 0;
  workspace.nodes = workspace.nodes.map((node) => {
    if (node.objectRef) return node;
    const explicitId = typeof node.payload.knowledgeObjectId === 'string' ? node.payload.knowledgeObjectId : '';
    const noteId = typeof node.payload.knowledgeNoteId === 'string' ? node.payload.knowledgeNoteId : '';
    const sourcePath = typeof node.payload.path === 'string' ? node.payload.path : '';
    const object = snapshot.objects.find((candidate) => candidate.id === explicitId || candidate.externalRef === `note:${noteId}` || (node.type === 'note' && sourcePath && candidate.provenance?.path === sourcePath));
    if (!object) return node;
    changed += 1;
    return {
      ...node,
      objectRef: { authority: 'hii-knowledge' as const, id: object.id, projectId: object.projectId, kind: object.kind },
      object: node.object || { kind: object.kind as SpatialObjectKind, owner: object.owner, status: object.status === 'accepted' ? 'approved' as const : 'unknown' as const, source: object.provenance?.path, memoryRefs: [object.id] }
    };
  });
  if (changed) await writeWorkspace(workspace, workspace.revision);
  return { changed, total: workspace.nodes.length };
}

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) return denied();
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'workspace';
  try {
    if (mode === 'note') {
      const note = getKnowledgeNote(url.searchParams.get('id') || '');
      return note ? NextResponse.json(note) : NextResponse.json({ error: 'Note not found.' }, { status: 404 });
    }
    if (mode === 'search') return NextResponse.json({ results: searchKnowledge(url.searchParams.get('q') || '') });
    if (mode === 'graph') return NextResponse.json(knowledgeGraph());
    if (mode === 'assets') return NextResponse.json({ assets: listKnowledgeAssets() });
    if (mode === 'systems') return NextResponse.json(knowledgeSystemSnapshot(url.searchParams.get('project') || undefined));
    if (mode === 'imports') return NextResponse.json({ imports: knowledgeImportStatus(url.searchParams.get('batch') || undefined) });
    if (mode === 'asset-file') {
      const result = readKnowledgeAsset(url.searchParams.get('id') || '');
      if (!result) return NextResponse.json({ error: 'Asset not found.' }, { status: 404 });
      if (!result.content) return NextResponse.json({ error: 'Linked asset is currently unavailable.', asset: result.asset }, { status: 410 });
      return new NextResponse(new Uint8Array(result.content), {
        headers: {
          'content-type': result.asset.mime,
          'content-length': String(result.content.byteLength),
          'content-disposition': `inline; filename="${result.asset.name.replace(/["\\]/g, '-')}"`,
          'cache-control': 'private, no-store'
        }
      });
    }
    if (mode === 'trash') return NextResponse.json({ notes: listKnowledgeNotes({ includeDeleted: true }).filter((note) => note.deletedAt) });
    if (mode === 'export-note') {
      const note = exportKnowledgeNote(url.searchParams.get('id') || '');
      if (!note) return NextResponse.json({ error: 'Note not found.' }, { status: 404 });
      return new NextResponse(note.content, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${note.path.replace(/["\\/]/g, '-')}"`
        }
      });
    }
    if (mode === 'export') {
      return NextResponse.json(exportKnowledgeWorkspace(), {
        headers: { 'content-disposition': 'attachment; filename="hii-knowledge-export.json"' }
      });
    }
    return NextResponse.json(knowledgeWorkspace());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Knowledge request failed.' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) return denied();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    if (action === 'create') return NextResponse.json(createKnowledgeNote({ ...body, actor: 'api.knowledge' }), { status: 201 });
    if (action === 'create-project') {
      const name = String(body?.name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 80);
      if (!name || name === '.' || name === '..') return NextResponse.json({ error: 'Choose a project name.' }, { status: 400 });
      const note = createKnowledgeNote({
        title: `${name} Home`,
        folder: `Projects/${name}`,
        projectId: name,
        kind: 'note',
        content: `# ${name}\n\n## Intent\n\nWhat should this project make true?\n\n## Sources\n\n- \n\n## Decisions\n\n- \n`,
        actor: 'api.knowledge.project'
      });
      ensureSystemMap(name);
      return NextResponse.json({ project: { id: name, name }, note }, { status: 201 });
    }
    if (action === 'save') return NextResponse.json(updateKnowledgeNote(String(body?.id || ''), { ...body, actor: 'api.knowledge' }));
    if (action === 'trash') return NextResponse.json({ note: trashKnowledgeNote(String(body?.id || ''), 'api.knowledge') });
    if (action === 'restore') return NextResponse.json(restoreKnowledgeNote(String(body?.id || ''), 'api.knowledge'));
    if (action === 'restore-version') return NextResponse.json(restoreKnowledgeVersion(String(body?.id || ''), Number(body?.version), body?.ifMatch, 'api.knowledge'));
    if (action === 'daily') return NextResponse.json(openDailyNote(String(body?.date || new Date().toISOString().slice(0, 10)), 'api.knowledge'));
    if (action === 'import') return NextResponse.json({ notes: importKnowledgeNotes(body?.files, 'api.knowledge') }, { status: 201 });
    if (action === 'plan-import') return NextResponse.json(planKnowledgeImport(body?.sourceRoot), { status: 201 });
    if (action === 'execute-import') return NextResponse.json(executeKnowledgeImport(body?.batchId, body?.planHash, body?.approvalToken));
    if (action === 'verify-import') return NextResponse.json(verifyKnowledgeImport(body?.batchId));
    if (action === 'rollback-import') return NextResponse.json(rollbackKnowledgeImport(body?.batchId));
    if (action === 'export-vault') return NextResponse.json(exportKnowledgeVault(body?.destination), { status: 201 });
    if (action === 'rebuild-index') return NextResponse.json({ workspace: rebuildKnowledgeIndex() });
    if (action === 'migrate-workspace-refs') return NextResponse.json(await migrateWorkspaceRefs());
    if (action === 'asset-copy' || action === 'asset-link') {
      const asset = registerKnowledgeAsset({ ...body, mode: action === 'asset-link' ? 'link' : 'copy' });
      return NextResponse.json({ asset }, { status: 201 });
    }
    if (action === 'object-create') {
      const object = createKnowledgeObject(body ?? {});
      ensureSystemMap(object.projectId);
      return NextResponse.json({ object }, { status: 201 });
    }
    if (action === 'object-update') return NextResponse.json({ object: updateKnowledgeObject(String(body?.id || ''), body ?? {}) });
    if (action === 'relation-create') return NextResponse.json({ relation: createKnowledgeRelation(body ?? {}) }, { status: 201 });
    if (action === 'relation-update') return NextResponse.json({ relation: updateKnowledgeRelation(String(body?.id || ''), body?.status) });
    if (action === 'view-save') return NextResponse.json({ view: saveKnowledgeView(body ?? {}) });
    if (action === 'explore-system') {
      const detail = getKnowledgeNote(String(body?.noteId || ''));
      if (!detail) return NextResponse.json({ error: 'Source note not found.' }, { status: 404 });
      return NextResponse.json(proposeSystemFromNote(detail.note), { status: 201 });
    }
    if (action === 'object-to-task') {
      const snapshot = knowledgeSystemSnapshot(String(body?.projectId || '') || undefined);
      const decision = snapshot.objects.find((object) => object.id === String(body?.id || ''));
      if (!decision || decision.kind !== 'decision' || !['accepted', 'active'].includes(decision.status)) {
        return NextResponse.json({ error: 'Only an accepted decision can become a task.' }, { status: 409 });
      }
      const task = await createBoardTask({
        title: decision.title,
        lane: 'next',
        priority: 'normal',
        owner: 'main agent',
        coordinate: decision.provenance?.path || '/Users/ummi/hii',
        notes: `${decision.summary}\n\nKnowledge decision: ${decision.id}`,
        tags: ['knowledge', decision.projectId, 'decision'],
        source: 'hii.knowledge.system-map'
      });
      const object = createKnowledgeObject({
        projectId: decision.projectId,
        kind: 'task',
        title: task.title,
        summary: task.notes,
        status: 'active',
        owner: task.owner,
        externalRef: `board:${task.id}`,
        provenance: decision.provenance
      });
      createKnowledgeRelation({ projectId: decision.projectId, fromId: decision.id, toId: object.id, kind: 'implements', status: 'accepted' });
      ensureSystemMap(decision.projectId);
      return NextResponse.json({ task, object }, { status: 201 });
    }
    if (action === 'prepare-run') {
      return NextResponse.json(prepareKnowledgeRun(body ?? {}), { status: 201 });
    }
    if (action === 'approve-run') return NextResponse.json(await approveKnowledgeRun(body ?? {}), { status: 202 });
    if (action === 'sync-run') return NextResponse.json(await syncKnowledgeRun(body ?? {}));
    if (action === 'attach-runtime') return NextResponse.json({ object: attachRuntimeObject(body ?? {}) }, { status: 201 });
    if (action === 'pin-object') {
      const snapshot = knowledgeSystemSnapshot(String(body?.projectId || '') || undefined);
      const object = snapshot.objects.find((candidate) => candidate.id === String(body?.id || ''));
      if (!object) return NextResponse.json({ error: 'Knowledge object not found.' }, { status: 404 });
      const workspace = await readWorkspace();
      const existing = workspace.nodes.find((node) => node.payload.knowledgeObjectId === object.id);
      if (existing) return NextResponse.json({ node: existing, alreadyPinned: true });
      const kindMap: Partial<Record<string, SpatialObjectKind>> = { task: 'task', run: 'agent', receipt: 'receipt', proof: 'proof', source: 'source', asset: 'memory' };
      const now = new Date().toISOString();
      const node: WorkspaceNode = {
        id: crypto.randomUUID(), type: 'note', x: 120 + workspace.nodes.length * 24, y: 120 + workspace.nodes.length * 24,
        w: 320, h: 220, z: workspace.nextZ + 1, createdAt: now, updatedAt: now,
        object: { kind: kindMap[object.kind] || object.kind as SpatialObjectKind, owner: object.owner, status: object.status === 'accepted' ? 'approved' : object.status === 'active' ? 'running' : object.status as any, source: object.provenance?.path, memoryRefs: [object.id] },
        objectRef: { authority: 'hii-knowledge', id: object.id, projectId: object.projectId, kind: object.kind },
        payload: { title: object.title, content: object.summary, knowledgeObjectId: object.id, projectId: object.projectId, canonical: 'hii-database' }
      };
      workspace.nodes.push(node); workspace.nextZ = node.z;
      await writeWorkspace(workspace, workspace.revision);
      return NextResponse.json({ node }, { status: 201 });
    }
    return NextResponse.json({ error: 'Unknown knowledge action.' }, { status: 400 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Knowledge mutation failed.' },
      { status: code === 'CONFLICT' ? 409 : 400 }
    );
  }
}
