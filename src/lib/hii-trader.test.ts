import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertLiveTradingLocked,
  closeTraderDatabaseForTests,
  controlTrader,
  evaluateRisk,
  getTraderSnapshot,
  runTraderCycle,
  traderCycleDue,
  updateTradingProfile,
  validateProposalAgainstAsset,
  type MarketAsset,
  type TradeProposal
} from '../../lib/server/hii-trader';

let directory = '';

function asset(overrides: Partial<MarketAsset> = {}): MarketAsset {
  return {
    symbol: 'BTC',
    name: 'Bitcoin',
    assetClass: 'core',
    venue: 'fixture',
    priceUsd: 100,
    change24hPct: 4,
    volume24hUsd: 50_000_000,
    liquidityUsd: null,
    spreadPct: 0.1,
    pairAgeHours: null,
    socialLinks: 0,
    observedAt: '2026-07-29T00:00:00.000Z',
    eligible: true,
    ineligibleReasons: [],
    sourceRefs: ['fixture://market'],
    ...overrides
  };
}

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: 'BTC',
    action: 'buy',
    confidence: 0.8,
    thesis: 'Positive price evidence.',
    invalidation: 'Momentum turns negative.',
    featureRefs: ['BTC.change24hPct'],
    model: 'fixture-model',
    ...overrides
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-trader-'));
  process.env.HII_DB_PATH = path.join(directory, 'hii.db');
  process.env.HII_RUNTIME_DIR = directory;
});

afterEach(() => {
  closeTraderDatabaseForTests();
  delete process.env.HII_DB_PATH;
  delete process.env.HII_RUNTIME_DIR;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('HII trader risk and execution', () => {
  it('keeps the trader paused and live trading locked by default', () => {
    const snapshot = getTraderSnapshot();
    expect(snapshot.status.mode).toBe('paused');
    expect(snapshot.status.liveUnlocked).toBe(false);
    expect(snapshot.promotion.liveLocked).toBe(true);
    expect(() => assertLiveTradingLocked()).toThrow(/90-day, 200-trade/);
  });

  it('runs an approved paper cycle and records a modeled fill', async () => {
    controlTrader('start');
    const result = await runTraderCycle({
      force: true,
      at: '2026-07-29T00:00:00.000Z',
      marketProvider: async () => [
        asset(),
        asset({
          symbol: 'RUG',
          assetClass: 'meme-dex',
          eligible: false,
          ineligibleReasons: ['on-chain safety unavailable']
        })
      ],
      intelligenceProvider: async () => [proposal()]
    });

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe('BTC');
    expect(result.status.cashUsd).toBeLessThan(10_000);
    expect(result.decisions.some((decision) => decision.fill?.side === 'buy')).toBe(true);
    expect(result.decisions.find((decision) => decision.asset.symbol === 'RUG')?.risk.approved).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'receipts', 'trader.jsonl'), 'utf8')).toContain('trader.cycle');
  });

  it('enforces confidence and loss limits deterministically', () => {
    const profile = updateTradingProfile({ memeAllocationPct: 30 }).profile;
    const decision = evaluateRisk({
      profile,
      state: {
        mode: 'paper',
        cashUsd: 5_000,
        equityUsd: 10_000,
        highWaterUsd: 10_000,
        dayStartEquityUsd: 10_500,
        day: '2026-07-29',
        rollingSevenDayStartUsd: 10_000,
        startedAt: null,
        lastCycleAt: null,
        cycleStartedAt: null,
        killReason: null,
        liveUnlocked: false
      },
      positions: [],
      asset: asset({ symbol: 'DOGE', assetClass: 'meme-cex' }),
      proposal: proposal({ symbol: 'DOGE', confidence: 0.4 })
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('daily loss circuit breaker active');
    expect(decision.reasons).toContain('model confidence below 0.55');
  });

  it('rejects model prose that introduces unsupported numeric claims', () => {
    const validated = validateProposalAgainstAsset({
      ...proposal(),
      thesis: 'BTC spread widened to 9.9%.',
      featureRefs: ['BTC.spreadPct']
    }, asset({ spreadPct: 0.1 }), 'fixture-model');
    expect(validated.action).toBe('hold');
    expect(validated.confidence).toBe(0);
    expect(validated.thesis).toMatch(/unsupported numeric claims/);
  });

  it('latches the operator kill switch and prevents restart', () => {
    controlTrader('start');
    controlTrader('kill');
    expect(getTraderSnapshot().status.mode).toBe('killed');
    expect(() => controlTrader('start')).toThrow(/latched/);
    expect(traderCycleDue()).toBe(false);
  });
});
