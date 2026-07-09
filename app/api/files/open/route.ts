import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const ALLOWED_ROOT = path.resolve(os.homedir());
const BROWSER_APP = process.env.HII_BROWSER_APP || 'Helium';

function isInside(target: string) {
  const resolved = path.resolve(target);
  return resolved === ALLOWED_ROOT || resolved.startsWith(`${ALLOWED_ROOT}${path.sep}`);
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'local-only' }, { status: 403 });
  }
  let body: { url?: string; path?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  try {
    if (typeof body.url === 'string' && /^https?:\/\//i.test(body.url)) {
      try {
        await execFileAsync('open', ['-a', BROWSER_APP, body.url], { timeout: 5000 });
        return NextResponse.json({ ok: true, opened: BROWSER_APP });
      } catch {
        await execFileAsync('open', [body.url], { timeout: 5000 });
        return NextResponse.json({ ok: true, opened: 'default browser' });
      }
    }
    if (typeof body.path === 'string' && isInside(body.path)) {
      await execFileAsync('open', [path.resolve(body.path)], { timeout: 5000 });
      return NextResponse.json({ ok: true, opened: 'finder' });
    }
  } catch {
    return NextResponse.json({ error: 'open failed' }, { status: 500 });
  }
  return NextResponse.json({ error: 'url or home-relative path required' }, { status: 400 });
}
