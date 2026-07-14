import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function frameableFromHeaders(headers: Headers): boolean {
  const xfo = (headers.get('x-frame-options') ?? '').toUpperCase();
  if (xfo.includes('DENY') || xfo.includes('SAMEORIGIN')) return false;
  const csp = headers.get('content-security-policy') ?? '';
  const match = csp.match(/frame-ancestors\s+([^;]+)/i);
  if (match) {
    const sources = match[1].trim().toLowerCase();
    if (!sources.includes('*')) return false;
  }
  return true;
}

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'local-only' }, { status: 403 });
  }
  const url = new URL(request.url).searchParams.get('url');
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'url required' }, { status: 400 });
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': 'Mozilla/5.0 (HII local frame probe)' }
    });
    res.body?.cancel();
    return NextResponse.json({ frameable: frameableFromHeaders(res.headers), finalUrl: res.url, status: res.status });
  } catch {
    return NextResponse.json({ frameable: false, finalUrl: url, status: 0 });
  }
}
