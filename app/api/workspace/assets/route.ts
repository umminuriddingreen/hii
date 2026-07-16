import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const runtimeDir = process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii');
const assetsDir = path.join(runtimeDir, 'workspace', 'assets');

function safeName(value: string) {
  const clean = path.basename(value || 'pasted-media').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120);
  return clean || 'pasted-media';
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII workspace is local-only' }, { status: 403 });
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  if (file.size > 250 * 1024 * 1024) {
    return NextResponse.json({ error: 'media exceeds the 250 MB local workspace limit' }, { status: 413 });
  }

  await mkdir(assetsDir, { recursive: true });
  const storedName = `${randomUUID()}-${safeName(file.name)}`;
  const storedPath = path.join(assetsDir, storedName);
  await writeFile(storedPath, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({
    name: safeName(file.name),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    path: storedPath,
    url: `/api/workspace/assets/${encodeURIComponent(storedName)}`
  });
}
