import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const legacy = readFileSync(resolve(root, 'app/api/knowledge/route.ts'), 'utf8');
const svelte = readFileSync(resolve(root, 'src/routes/api/knowledge/+server.ts'), 'utf8');

function branchValues(source: string, name: 'mode' | 'action') {
  return [...source.matchAll(new RegExp(`${name} === '([^']+)'`, 'g'))]
    .map((match) => match[1])
    .sort();
}

function knowledgeExports(source: string) {
  const match = source.match(/import \{\n([\s\S]*?)\n\} from '@\/lib\/server\/hii-knowledge';/);
  return (match?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

describe('SvelteKit knowledge API parity', () => {
  it('wraps the same knowledge operations and route branches as the legacy handler', () => {
    expect(knowledgeExports(svelte)).toEqual(knowledgeExports(legacy));
    expect(branchValues(svelte, 'mode')).toEqual(branchValues(legacy, 'mode'));
    expect(branchValues(svelte, 'action')).toEqual(branchValues(legacy, 'action'));
    expect(svelte).toContain("const mode = url.searchParams.get('mode') || 'workspace'");
    expect(svelte).toContain("const action = typeof body?.action === 'string' ? body.action : ''");
  });

  it('keeps local-only access gating ahead of reads and mutations', () => {
    expect(svelte).toContain("import { localTerminalAllowed } from '@/lib/server/hii-terminal'");
    expect(svelte.match(/if \(!localTerminalAllowed\(request\)\) return denied\(\);/g)).toHaveLength(2);
    expect(svelte).toContain("json({ error: 'Local HII access required.' }, { status: 401 })");
    expect(svelte.indexOf('localTerminalAllowed(request)')).toBeLessThan(
      svelte.indexOf("url.searchParams.get('mode')")
    );
    expect(svelte.lastIndexOf('localTerminalAllowed(request)')).toBeLessThan(
      svelte.indexOf('request.json()')
    );
  });

  it('preserves response envelopes, statuses, downloads, and error mapping', () => {
    const contracts = [
      "json({ results: searchKnowledge(url.searchParams.get('q') || '') })",
      'notes: listKnowledgeNotes({ includeDeleted: true }).filter((note) => note.deletedAt)',
      "json({ error: 'Note not found.' }, { status: 404 })",
      "'content-type': 'text/markdown; charset=utf-8'",
      "'content-disposition': `attachment; filename=\"${note.path.replace(/[\"\\\\/]/g, '-')}\"`",
      "'content-disposition': 'attachment; filename=\"hii-knowledge-export.json\"'",
      "createKnowledgeNote({ ...body, actor: 'api.knowledge' }), { status: 201 }",
      "json({ note: trashKnowledgeNote(String(body?.id || ''), 'api.knowledge') })",
      "json({ notes: importKnowledgeNotes(body?.files, 'api.knowledge') }, { status: 201 })",
      "json({ error: 'Unknown knowledge action.' }, { status: 400 })",
      "{ status: code === 'CONFLICT' ? 409 : 400 }"
    ];

    for (const contract of contracts) expect(svelte).toContain(contract);
    expect(svelte).not.toContain("from '@/app/api/knowledge/route'");
    expect(svelte).not.toContain('NextResponse');
  });
});
