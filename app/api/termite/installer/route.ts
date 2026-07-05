import { NextResponse } from 'next/server';
import { askLocalInstallerModel } from '@/lib/server/local-llm';
import {
  getInstallerState,
  listInstallerActions,
  runInstallerAction
} from '@/lib/server/termite-installer';

export const dynamic = 'force-dynamic';

function localInstallerAllowed(request: Request) {
  if (process.env.HII_LOCAL_INSTALLER_ENABLED === '1') return true;
  const host = request.headers.get('host') ?? '';
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
}

function promptFor(state: Awaited<ReturnType<typeof getInstallerState>>, output?: string) {
  return [
    'Current Termite installer state:',
    JSON.stringify(state, null, 2),
    output ? `Latest command output:\n${output.slice(0, 3000)}` : '',
    'Give the next safest whitelisted action for a local Termite alpha install.'
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function GET(request: Request) {
  if (!localInstallerAllowed(request)) {
    return NextResponse.json({ error: 'Local installer is only available on localhost.' }, { status: 403 });
  }

  const state = await getInstallerState();
  const guidance = await askLocalInstallerModel(promptFor(state));
  return NextResponse.json({
    state,
    actions: listInstallerActions(),
    guidance
  });
}

export async function POST(request: Request) {
  if (!localInstallerAllowed(request)) {
    return NextResponse.json({ error: 'Local installer is only available on localhost.' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const actionId = String(body?.actionId ?? '').trim();
  if (!actionId) return NextResponse.json({ error: 'Missing actionId.' }, { status: 400 });

  const run = await runInstallerAction(actionId);
  const state = await getInstallerState();
  const guidance = await askLocalInstallerModel(promptFor(state, run.output));

  return NextResponse.json({ run, state, guidance });
}
