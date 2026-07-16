import { NextResponse } from 'next/server';
import { readHiiConfig } from '@/lib/server/hii-config';
import { controlHiiDaemon } from '@/lib/server/hii-daemon';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-only surface config (capability hii.config.read). Writes happen only
// through AII: `hiid config set <dot.path> <value>`.
export async function GET() {
  return NextResponse.json({ config: readHiiConfig() });
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII configuration is local-only.' }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    surface?: unknown;
    enabled?: unknown;
  } | null;
  const action = body?.action;
  const surface = typeof body?.surface === 'string' ? body.surface.trim() : '';
  const config = readHiiConfig();
  if (!surface || !Object.hasOwn(config.surfaces, surface)) {
    return NextResponse.json({ error: `Unknown HII surface: ${surface || 'missing'}` }, { status: 400 });
  }

  try {
    if (action === 'toggle' && typeof body?.enabled === 'boolean') {
      await controlHiiDaemon('config.set', {
        path: `surfaces.${surface}.enabled`,
        value: body.enabled
      });
    } else if (action === 'home') {
      await controlHiiDaemon('config.set', { path: 'defaults.homepage', value: surface });
    } else {
      return NextResponse.json({ error: 'Use toggle or home for a known HII surface.' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, config: readHiiConfig() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not update HII configuration.' },
      { status: 400 }
    );
  }
}
