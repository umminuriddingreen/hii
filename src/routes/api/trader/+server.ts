import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  assertLiveTradingLocked,
  controlTrader,
  getTraderSnapshot,
  runTraderCycle,
  updateTradingProfile
} from '@/lib/server/hii-trader';

function denied() {
  return json({ error: 'Local HII access required.' }, { status: 401 });
}

export const GET: RequestHandler = async ({ request }) => {
  if (!localTerminalAllowed(request)) return denied();
  return json(getTraderSnapshot());
};

export const POST: RequestHandler = async ({ request }) => {
  if (!localTerminalAllowed(request)) return denied();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    if (action === 'start' || action === 'pause' || action === 'kill') {
      return json(controlTrader(action));
    }
    if (action === 'cycle') return json(await runTraderCycle({ force: true }));
    if (action === 'profile') return json(updateTradingProfile(body?.profile || {}));
    if (action === 'activate-live') assertLiveTradingLocked();
    return json({ error: 'Unknown trader action.' }, { status: 400 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Trader request failed.' }, { status: 400 });
  }
};
