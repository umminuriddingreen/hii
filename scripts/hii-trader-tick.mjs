import { getTraderSnapshot, runTraderCycle, traderCycleDue } from '../lib/server/hii-trader.ts';

if (!traderCycleDue()) {
  const snapshot = getTraderSnapshot();
  console.log(JSON.stringify({ ok: true, skipped: true, mode: snapshot.status.mode, lastCycleAt: snapshot.status.lastCycleAt }));
  process.exit(0);
}

const snapshot = await runTraderCycle();
console.log(JSON.stringify({
  ok: true,
  skipped: false,
  mode: snapshot.status.mode,
  equityUsd: snapshot.status.equityUsd,
  lastCycleAt: snapshot.status.lastCycleAt,
  positions: snapshot.positions.length
}));
