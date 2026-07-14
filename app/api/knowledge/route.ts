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
  restoreKnowledgeNote,
  restoreKnowledgeVersion,
  searchKnowledge,
  trashKnowledgeNote,
  updateKnowledgeNote
} from '@/lib/server/hii-knowledge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function denied() {
  return NextResponse.json({ error: 'Local HII access required.' }, { status: 401 });
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
    if (action === 'save') return NextResponse.json(updateKnowledgeNote(String(body?.id || ''), { ...body, actor: 'api.knowledge' }));
    if (action === 'trash') return NextResponse.json({ note: trashKnowledgeNote(String(body?.id || ''), 'api.knowledge') });
    if (action === 'restore') return NextResponse.json(restoreKnowledgeNote(String(body?.id || ''), 'api.knowledge'));
    if (action === 'restore-version') return NextResponse.json(restoreKnowledgeVersion(String(body?.id || ''), Number(body?.version), body?.ifMatch, 'api.knowledge'));
    if (action === 'daily') return NextResponse.json(openDailyNote(String(body?.date || new Date().toISOString().slice(0, 10)), 'api.knowledge'));
    if (action === 'import') return NextResponse.json({ notes: importKnowledgeNotes(body?.files, 'api.knowledge') }, { status: 201 });
    return NextResponse.json({ error: 'Unknown knowledge action.' }, { status: 400 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Knowledge mutation failed.' },
      { status: code === 'CONFLICT' ? 409 : 400 }
    );
  }
}
