import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
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
  restoreKnowledgeNote,
  restoreKnowledgeVersion,
  searchKnowledge,
  trashKnowledgeNote,
  updateKnowledgeNote
} from '@/lib/server/hii-knowledge';

function denied() {
  return json({ error: 'Local HII access required.' }, { status: 401 });
}

export const GET: RequestHandler = async ({ request, url }) => {
  if (!localTerminalAllowed(request)) return denied();
  const mode = url.searchParams.get('mode') || 'workspace';
  try {
    if (mode === 'note') {
      const note = getKnowledgeNote(url.searchParams.get('id') || '');
      return note ? json(note) : json({ error: 'Note not found.' }, { status: 404 });
    }
    if (mode === 'search') return json({ results: searchKnowledge(url.searchParams.get('q') || '') });
    if (mode === 'graph') return json(knowledgeGraph());
    if (mode === 'trash') {
      return json({
        notes: listKnowledgeNotes({ includeDeleted: true }).filter((note) => note.deletedAt)
      });
    }
    if (mode === 'export-note') {
      const note = exportKnowledgeNote(url.searchParams.get('id') || '');
      if (!note) return json({ error: 'Note not found.' }, { status: 404 });
      return new Response(note.content, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${note.path.replace(/["\\/]/g, '-')}"`
        }
      });
    }
    if (mode === 'export') {
      return json(exportKnowledgeWorkspace(), {
        headers: { 'content-disposition': 'attachment; filename="hii-knowledge-export.json"' }
      });
    }
    return json(knowledgeWorkspace());
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Knowledge request failed.' },
      { status: 400 }
    );
  }
};

export const POST: RequestHandler = async ({ request }) => {
  if (!localTerminalAllowed(request)) return denied();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    if (action === 'create') {
      return json(createKnowledgeNote({ ...body, actor: 'api.knowledge' }), { status: 201 });
    }
    if (action === 'save') {
      return json(
        updateKnowledgeNote(String(body?.id || ''), { ...body, actor: 'api.knowledge' })
      );
    }
    if (action === 'trash') {
      return json({ note: trashKnowledgeNote(String(body?.id || ''), 'api.knowledge') });
    }
    if (action === 'restore') {
      return json(restoreKnowledgeNote(String(body?.id || ''), 'api.knowledge'));
    }
    if (action === 'restore-version') {
      return json(
        restoreKnowledgeVersion(
          String(body?.id || ''),
          Number(body?.version),
          body?.ifMatch,
          'api.knowledge'
        )
      );
    }
    if (action === 'daily') {
      return json(
        openDailyNote(
          String(body?.date || new Date().toISOString().slice(0, 10)),
          'api.knowledge'
        )
      );
    }
    if (action === 'import') {
      return json({ notes: importKnowledgeNotes(body?.files, 'api.knowledge') }, { status: 201 });
    }
    return json({ error: 'Unknown knowledge action.' }, { status: 400 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return json(
      { error: error instanceof Error ? error.message : 'Knowledge mutation failed.' },
      { status: code === 'CONFLICT' ? 409 : 400 }
    );
  }
};
