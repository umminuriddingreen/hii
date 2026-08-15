import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const runtimeDir = process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii');
const assetsDir = path.join(runtimeDir, 'workspace', 'assets');
const maxAssetBytes = 250 * 1024 * 1024;

function safeName(value: string) {
  const clean = path.basename(value || 'pasted-media').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120);
  return clean || 'pasted-media';
}

function contentAddressedName(name: string, sha256: string) {
  const extension = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16);
  return `${sha256}${extension}`;
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII workspace is local-only' }, { status: 403 });
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });
  if (file.size > maxAssetBytes) {
    return NextResponse.json({ error: 'media exceeds the 250 MB local workspace limit' }, { status: 413 });
  }

  await mkdir(assetsDir, { recursive: true });
  const body = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(body).digest('hex');
  const name = safeName(file.name);
  const storedName = contentAddressedName(name, sha256);
  const storedPath = path.join(assetsDir, storedName);
  let deduplicated = false;
  try {
    await writeFile(storedPath, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const existing = await readFile(storedPath);
    const existingHash = createHash('sha256').update(existing).digest('hex');
    if (existingHash !== sha256) {
      return NextResponse.json({ error: 'stored asset failed its content-address integrity check' }, { status: 500 });
    }
    deduplicated = true;
  }
  return NextResponse.json({
    name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    path: storedPath,
    url: `/api/workspace/assets/${encodeURIComponent(storedName)}`,
    sha256,
    storage: 'hii-content-addressed',
    deduplicated
  });
}
