import { readFile } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const runtimeDir = process.env.HII_RUNTIME_DIR || path.join(process.env.HOME || '.', '.hii');
const assetsDir = path.join(runtimeDir, 'workspace', 'assets');

const mimeByExtension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', mp3: 'audio/mpeg', wav: 'audio/wav', aiff: 'audio/aiff',
  m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', pdf: 'application/pdf', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj',
  stl: 'model/stl', ply: 'application/octet-stream'
};

export async function GET(request: Request, { params }: { params: { name: string } }) {
  if (!localTerminalAllowed(request)) return new NextResponse('Local access required.', { status: 403 });
  const name = path.basename(params.name);
  if (!name || name !== params.name) return new NextResponse('Invalid asset.', { status: 400 });
  try {
    const body = await readFile(path.join(assetsDir, name));
    const extension = name.split('.').pop()?.toLowerCase() || '';
    return new NextResponse(body, {
      headers: {
        'content-type': mimeByExtension[extension] || 'application/octet-stream',
        'cache-control': 'private, max-age=31536000, immutable'
      }
    });
  } catch {
    return new NextResponse('Asset not found.', { status: 404 });
  }
}
