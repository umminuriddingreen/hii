import { NextResponse } from 'next/server';
import { createLinkPostFromInput, listLinkPostsWithCache } from '@/lib/server/link-stream';

export const dynamic = 'force-dynamic';

export async function GET() {
  const posts = await listLinkPostsWithCache(80);
  return NextResponse.json({ posts });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  try {
    const post = await createLinkPostFromInput({
      url: String(body?.url ?? ''),
      title: String(body?.title ?? ''),
      note: String(body?.note ?? ''),
      source: String(body?.source ?? 'extension'),
      tags: Array.isArray(body?.tags) ? body.tags.map(String) : String(body?.tags ?? '')
    });
    return NextResponse.json({ post }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not save this link.' },
      { status: 400 }
    );
  }
}
