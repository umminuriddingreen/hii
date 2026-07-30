import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TraderMode = 'paused' | 'paper' | 'killed';
export type TradeAction = 'buy' | 'sell' | 'hold';
export type AssetClass = 'core' | 'meme-cex' | 'meme-dex';

export type TradingProfile = {
  id: string;
  name: string;
  objective: 'risk-adjusted-compounding';
  startingCapitalUsd: number;
  maximumDrawdownPct: number;
  dailyLossPct: number;
  rollingSevenDayLossPct: number;
  memeAllocationPct: number;
  attentionBudget: 'low' | 'medium' | 'high';
  quietHours: { start: string; end: string };
  excludedSymbols: string[];
  version: number;
  updatedAt: string;
};

export type MarketAsset = {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  venue: string;
  priceUsd: number;
  change24hPct: number;
  volume24hUsd: number;
  liquidityUsd: number | null;
  spreadPct: number | null;
  pairAgeHours: number | null;
  socialLinks: number;
  observedAt: string;
  eligible: boolean;
  ineligibleReasons: string[];
  sourceRefs: string[];
};

export type TradeProposal = {
  symbol: string;
  action: TradeAction;
  confidence: number;
  thesis: string;
  invalidation: string;
  featureRefs: string[];
  model: string;
};

export type RiskDecision = {
  approved: boolean;
  symbol: string;
  action: TradeAction;
  notionalUsd: number;
  reasons: string[];
  limits: {
    portfolioMemePct: number;
    assetCapPct: number;
    dailyLossPct: number;
    drawdownPct: number;
  };
};

type TraderState = {
  mode: TraderMode;
  cashUsd: number;
  equityUsd: number;
  highWaterUsd: number;
  dayStartEquityUsd: number;
  day: string;
  rollingSevenDayStartUsd: number;
  startedAt: string | null;
  lastCycleAt: string | null;
  cycleStartedAt: string | null;
  killReason: string | null;
  liveUnlocked: false;
};

type Position = {
  symbol: string;
  assetClass: AssetClass;
  quantity: number;
  averagePriceUsd: number;
  markPriceUsd: number;
  marketValueUsd: number;
  unrealizedPnlUsd: number;
  updatedAt: string;
};

type DecisionRecord = {
  id: string;
  createdAt: string;
  asset: MarketAsset;
  proposal: TradeProposal;
  risk: RiskDecision;
  fill?: {
    id: string;
    side: 'buy' | 'sell';
    quantity: number;
    priceUsd: number;
    notionalUsd: number;
    feeUsd: number;
    slippagePct: number;
  };
};

export type TraderSnapshot = {
  status: TraderState & {
    drawdownPct: number;
    dailyPnlPct: number;
    rollingSevenDayPnlPct: number;
  };
  profile: TradingProfile;
  positions: Position[];
  decisions: DecisionRecord[];
  market: MarketAsset[];
  metrics: {
    realizedPnlUsd: number;
    totalFeesUsd: number;
    closedTrades: number;
    winRatePct: number;
    paperDays: number;
  };
  promotion: {
    liveLocked: true;
    eligible: false;
    requiredDays: 90;
    requiredClosedTrades: 200;
    completedDays: number;
    completedClosedTrades: number;
    blockers: string[];
  };
  dataCoverage: {
    market: 'kraken-public-api';
    dex: 'dex-screener-watch-only';
    onChainSecurity: 'not-configured';
    social: 'dex-metadata-only';
    intelligence: 'ollama-local';
  };
  receiptPath: string;
};

type IntelligenceProvider = (assets: MarketAsset[]) => Promise<TradeProposal[]>;
type MarketProvider = () => Promise<MarketAsset[]>;

const databases = new Map<string, DatabaseSync>();
const MODEL_PREFERENCES = ['qwen3.6:35b-mlx', 'qwen3.6:27b-mlx', 'gemma4:e2b-mlx'];
const PAPER_FEE_PCT = 0.26;
const PAPER_SLIPPAGE_PCT = 0.15;
const CYCLE_MINUTES = 5;
const CYCLE_LEASE_MS = 2 * 60_000;
const FAVORABLE_CHANGE_24H_PCT = 2;
const FAVORABLE_SPREAD_PCT = 0.25;

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

export function traderStorePath() {
  return process.env.HII_DB_PATH || path.join(runtimeRoot(), 'hii.db');
}

function receiptPath() {
  return path.join(runtimeRoot(), 'receipts', 'trader.jsonl');
}

function database() {
  const file = traderStorePath();
  const existing = databases.get(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const opened = new DatabaseSync(file);
  opened.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(opened);
  databases.set(file, opened);
  return opened;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hii_trader_profiles (
      id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_state (
      id TEXT PRIMARY KEY CHECK (id = 'paper'),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_positions (
      symbol TEXT PRIMARY KEY,
      position_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_market (
      symbol TEXT PRIMARY KEY,
      asset_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_decisions (
      id TEXT PRIMARY KEY,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hii_trader_decisions_created
      ON hii_trader_decisions(created_at DESC);
    CREATE TABLE IF NOT EXISTS hii_trader_metrics (
      id TEXT PRIMARY KEY CHECK (id = 'paper'),
      metrics_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_daily_equity (
      day TEXT PRIMARY KEY,
      equity_usd REAL NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_receipts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hii_trader_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO hii_trader_migrations(version, applied_at)
      VALUES ('hii-trader-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function today(iso = nowIso()) {
  return iso.slice(0, 10);
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cleanText(value: unknown, max = 600) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/((?:api[_-]?key|token|secret|password)=)([^\s]+)/gi, '$1[redacted]')
    .trim()
    .slice(0, max);
}

function defaultProfile(at = nowIso()): TradingProfile {
  return {
    id: 'ummi',
    name: 'Ummi',
    objective: 'risk-adjusted-compounding',
    startingCapitalUsd: 10_000,
    maximumDrawdownPct: 35,
    dailyLossPct: 3,
    rollingSevenDayLossPct: 8,
    memeAllocationPct: 30,
    attentionBudget: 'high',
    quietHours: { start: '23:00', end: '07:00' },
    excludedSymbols: [],
    version: 1,
    updatedAt: at
  };
}

function initialState(profile: TradingProfile, at = nowIso()): TraderState {
  return {
    mode: 'paused',
    cashUsd: profile.startingCapitalUsd,
    equityUsd: profile.startingCapitalUsd,
    highWaterUsd: profile.startingCapitalUsd,
    dayStartEquityUsd: profile.startingCapitalUsd,
    day: today(at),
    rollingSevenDayStartUsd: profile.startingCapitalUsd,
    startedAt: null,
    lastCycleAt: null,
    cycleStartedAt: null,
    killReason: null,
    liveUnlocked: false
  };
}

function defaultMetrics() {
  return {
    realizedPnlUsd: 0,
    totalFeesUsd: 0,
    closedTrades: 0,
    winningTrades: 0,
    firstPaperAt: null as string | null
  };
}

function readJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getProfile(db = database()) {
  const row = db.prepare('SELECT profile_json FROM hii_trader_profiles WHERE id = ?').get('ummi') as
    | { profile_json: string }
    | undefined;
  if (row) return readJson(row.profile_json, defaultProfile());
  const profile = defaultProfile();
  db.prepare('INSERT INTO hii_trader_profiles(id, profile_json, version, updated_at) VALUES (?, ?, ?, ?)')
    .run(profile.id, JSON.stringify(profile), profile.version, profile.updatedAt);
  return profile;
}

function getState(db = database()) {
  const profile = getProfile(db);
  const row = db.prepare('SELECT state_json FROM hii_trader_state WHERE id = ?').get('paper') as
    | { state_json: string }
    | undefined;
  if (row) return readJson(row.state_json, initialState(profile));
  const state = initialState(profile);
  db.prepare('INSERT INTO hii_trader_state(id, state_json, updated_at) VALUES (?, ?, ?)')
    .run('paper', JSON.stringify(state), nowIso());
  return state;
}

function saveState(state: TraderState, db = database()) {
  db.prepare(`
    INSERT INTO hii_trader_state(id, state_json, updated_at) VALUES ('paper', ?, ?)
    ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(state), nowIso());
}

function getMetrics(db = database()) {
  const row = db.prepare('SELECT metrics_json FROM hii_trader_metrics WHERE id = ?').get('paper') as
    | { metrics_json: string }
    | undefined;
  if (row) return readJson(row.metrics_json, defaultMetrics());
  const metrics = defaultMetrics();
  db.prepare('INSERT INTO hii_trader_metrics(id, metrics_json, updated_at) VALUES (?, ?, ?)')
    .run('paper', JSON.stringify(metrics), nowIso());
  return metrics;
}

function saveMetrics(metrics: ReturnType<typeof defaultMetrics>, db = database()) {
  db.prepare(`
    INSERT INTO hii_trader_metrics(id, metrics_json, updated_at) VALUES ('paper', ?, ?)
    ON CONFLICT(id) DO UPDATE SET metrics_json = excluded.metrics_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(metrics), nowIso());
}

function listPositions(db = database()): Position[] {
  return (db.prepare('SELECT position_json FROM hii_trader_positions ORDER BY symbol').all() as { position_json: string }[])
    .map((row) => readJson<Position | null>(row.position_json, null))
    .filter((row): row is Position => row !== null);
}

function savePosition(position: Position | null, symbol: string, db = database()) {
  if (!position || position.quantity <= 0.00000001) {
    db.prepare('DELETE FROM hii_trader_positions WHERE symbol = ?').run(symbol);
    return;
  }
  db.prepare(`
    INSERT INTO hii_trader_positions(symbol, position_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET position_json = excluded.position_json, updated_at = excluded.updated_at
  `).run(symbol, JSON.stringify(position), position.updatedAt);
}

function storeReceipt(kind: string, summary: string, payload: Record<string, unknown>, db = database()) {
  const createdAt = nowIso();
  const receipt = { id: randomUUID(), kind, summary: cleanText(summary, 800), payload, createdAt };
  db.prepare('INSERT INTO hii_trader_receipts(id, kind, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(receipt.id, kind, receipt.summary, JSON.stringify(payload), createdAt);
  const file = receiptPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

function stateStats(state: TraderState) {
  const drawdownPct = state.highWaterUsd > 0 ? ((state.highWaterUsd - state.equityUsd) / state.highWaterUsd) * 100 : 0;
  const dailyPnlPct = state.dayStartEquityUsd > 0 ? ((state.equityUsd - state.dayStartEquityUsd) / state.dayStartEquityUsd) * 100 : 0;
  const rollingSevenDayPnlPct = state.rollingSevenDayStartUsd > 0
    ? ((state.equityUsd - state.rollingSevenDayStartUsd) / state.rollingSevenDayStartUsd) * 100
    : 0;
  return { drawdownPct, dailyPnlPct, rollingSevenDayPnlPct };
}

function assetCapPct(assetClass: AssetClass) {
  if (assetClass === 'meme-dex') return 0.5;
  if (assetClass === 'meme-cex') return 3;
  return 15;
}

export function evaluateRisk(input: {
  profile: TradingProfile;
  state: TraderState;
  positions: Position[];
  asset: MarketAsset;
  proposal: TradeProposal;
}): RiskDecision {
  const { profile, state, positions, asset, proposal } = input;
  const stats = stateStats(state);
  const reasons: string[] = [];
  const capPct = assetCapPct(asset.assetClass);
  const memeValue = positions
    .filter((position) => position.assetClass !== 'core')
    .reduce((sum, position) => sum + position.marketValueUsd, 0);
  const memePct = state.equityUsd > 0 ? (memeValue / state.equityUsd) * 100 : 0;
  if (state.mode !== 'paper') reasons.push(`trader mode is ${state.mode}`);
  if (!asset.eligible) reasons.push(...asset.ineligibleReasons);
  if (profile.excludedSymbols.includes(asset.symbol)) reasons.push('symbol excluded by trading profile');
  if (stats.dailyPnlPct <= -profile.dailyLossPct) reasons.push('daily loss circuit breaker active');
  if (stats.rollingSevenDayPnlPct <= -profile.rollingSevenDayLossPct) reasons.push('seven-day loss circuit breaker active');
  if (stats.drawdownPct >= profile.maximumDrawdownPct) reasons.push('maximum drawdown circuit breaker active');
  if (proposal.action === 'buy' && asset.assetClass !== 'core' && memePct >= profile.memeAllocationPct) {
    reasons.push('meme allocation cap reached');
  }
  if (proposal.confidence < 0.55) reasons.push('model confidence below 0.55');
  if (proposal.action === 'hold') reasons.push('proposal is hold');

  const current = positions.find((position) => position.symbol === asset.symbol)?.marketValueUsd ?? 0;
  const target = state.equityUsd * (capPct / 100) * clamp(proposal.confidence, 0, 0, 1);
  let notionalUsd = proposal.action === 'buy' ? Math.max(0, target - current) : current;
  if (proposal.action === 'buy') notionalUsd = Math.min(notionalUsd, state.cashUsd * 0.95);
  if (notionalUsd < 25) reasons.push('order notional below $25');
  if (proposal.action === 'buy' && asset.assetClass !== 'core') {
    const remainingMeme = Math.max(0, state.equityUsd * (profile.memeAllocationPct / 100) - memeValue);
    notionalUsd = Math.min(notionalUsd, remainingMeme);
  }

  return {
    approved: reasons.length === 0,
    symbol: asset.symbol,
    action: proposal.action,
    notionalUsd: Math.round(notionalUsd * 100) / 100,
    reasons,
    limits: {
      portfolioMemePct: Math.round(memePct * 100) / 100,
      assetCapPct: capPct,
      dailyLossPct: Math.round(stats.dailyPnlPct * 100) / 100,
      drawdownPct: Math.round(stats.drawdownPct * 100) / 100
    }
  };
}

function unsupportedNumericClaims(text: string, asset: MarketAsset) {
  const allowed = [
    asset.priceUsd,
    asset.change24hPct,
    asset.volume24hUsd,
    asset.liquidityUsd,
    asset.spreadPct
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const values: number[] = [];
  const pattern = /[-+]?\d+(?:,\d{3})*(?:\.\d+)?%?/g;
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (/[a-z]/i.test(text[end] || '') || text.slice(end).toLowerCase().startsWith('-hour')) continue;
    values.push(Number(match[0].replace(/[,%]/g, '')));
  }
  return values.filter((claim) => !allowed.some((value) => {
    const tolerance = Math.max(0.02, Math.abs(value) * 0.02);
    return Math.abs(claim - value) <= tolerance;
  }));
}

export function validateProposalAgainstAsset(value: unknown, asset: MarketAsset, model = 'test-model'): TradeProposal {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const action = ['buy', 'sell', 'hold'].includes(String(raw.action)) ? String(raw.action) as TradeAction : 'hold';
  const refs = Array.isArray(raw.featureRefs) ? raw.featureRefs.map((item) => cleanText(item, 80)).slice(0, 8) : [];
  const validRefs = new Set([
    `${asset.symbol}.priceUsd`,
    `${asset.symbol}.change24hPct`,
    `${asset.symbol}.volume24hUsd`,
    `${asset.symbol}.liquidityUsd`,
    `${asset.symbol}.spreadPct`
  ]);
  const invalidReference = refs.some((ref) => !validRefs.has(ref));
  const thesis = cleanText(raw.thesis, 320);
  const invalidation = cleanText(raw.invalidation, 240) || 'Market evidence no longer supports the thesis.';
  const unsupported = unsupportedNumericClaims(`${thesis} ${invalidation}`, asset);
  const invalidEvidence = invalidReference || unsupported.length > 0;
  return {
    symbol: asset.symbol,
    action: invalidEvidence ? 'hold' : action,
    confidence: invalidEvidence ? 0 : clamp(raw.confidence, 0, 0, 1),
    thesis: invalidReference
      ? 'Rejected: proposal cited an unknown feature.'
      : unsupported.length
        ? `Rejected: proposal introduced unsupported numeric claims (${unsupported.slice(0, 4).join(', ')}).`
        : thesis,
    invalidation,
    featureRefs: refs.filter((ref) => validRefs.has(ref)),
    model
  };
}

function parseIntelligencePayload(content: unknown) {
  const text = String(content || '{}').trim();
  const json = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(json) as { proposals?: unknown[] };
}

function ensureNonDegenerateProposals(assets: MarketAsset[], proposals: TradeProposal[]) {
  if (proposals.some((proposal) => proposal.action !== 'hold')) return proposals;
  const candidate = assets
    .filter((asset) =>
      asset.eligible
      && asset.assetClass === 'core'
      && asset.change24hPct >= FAVORABLE_CHANGE_24H_PCT
      && asset.volume24hUsd >= 5_000_000
      && asset.spreadPct !== null
      && asset.spreadPct <= FAVORABLE_SPREAD_PCT
    )
    .sort((left, right) => right.change24hPct - left.change24hPct)[0];
  if (!candidate) return proposals;

  const fallback: TradeProposal = {
    symbol: candidate.symbol,
    action: 'buy',
    confidence: 0.6,
    thesis: 'Eligible core market evidence shows favorable momentum, verified volume, and an executable spread.',
    invalidation: 'Momentum, volume, or spread evidence no longer satisfies the deterministic paper policy.',
    featureRefs: [
      `${candidate.symbol}.change24hPct`,
      `${candidate.symbol}.volume24hUsd`,
      `${candidate.symbol}.spreadPct`
    ],
    model: 'deterministic-paper-evidence-v1'
  };
  const remaining = proposals.filter((proposal) => proposal.symbol !== candidate.symbol);
  return [fallback, ...remaining];
}

async function resolveOllamaModel(host: string) {
  const requested = process.env.HII_TRADER_MODEL;
  const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Ollama model inventory returned HTTP ${response.status}`);
  const payload = await response.json() as { models?: Array<{ name?: string }> };
  const available = new Set((payload.models || []).map((model) => String(model.name || '')).filter(Boolean));
  if (requested) {
    if (!available.has(requested)) throw new Error(`Configured Ollama model ${requested} is not installed.`);
    return requested;
  }
  const selected = MODEL_PREFERENCES.find((model) => available.has(model));
  if (!selected) throw new Error('No supported local trader model is installed.');
  return selected;
}

async function ollamaIntelligence(assets: MarketAsset[]): Promise<TradeProposal[]> {
  const eligible = assets.filter((asset) => asset.eligible);
  if (!eligible.length) return [];
  const host = process.env.HII_MODEL_URL || 'http://127.0.0.1:11434';
  const model = await resolveOllamaModel(host);
  const featureRows = eligible.map((asset) => ({
    symbol: asset.symbol,
    assetClass: asset.assetClass,
    priceUsd: asset.priceUsd,
    change24hPct: asset.change24hPct,
    volume24hUsd: asset.volume24hUsd,
    liquidityUsd: asset.liquidityUsd,
    spreadPct: asset.spreadPct
  }));
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [
        {
          role: 'system',
          content: [
            'You are the thesis desk inside a paper-only crypto trading experiment.',
            'Return JSON: {"proposals":[{"symbol","action":"buy|sell|hold","confidence":0..1,"thesis","invalidation","featureRefs":[]}]}',
            'Use only supplied numeric features. Cite featureRefs as SYMBOL.field. Prefer hold when evidence is weak.',
            'Do not invent numeric targets, thresholds, support levels, time windows, or percentages.',
            'Never claim guaranteed profit. Do not calculate position size or issue execution instructions.'
          ].join('\n')
        },
        { role: 'user', content: JSON.stringify({ objective: 'risk-adjusted-compounding', assets: featureRows }) }
      ]
    }),
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  const parsed = parseIntelligencePayload(payload.message?.content);
  const bySymbol = new Map(
    (Array.isArray(parsed.proposals) ? parsed.proposals : [])
      .map((proposal) => [cleanText((proposal as Record<string, unknown>)?.symbol, 24).toUpperCase(), proposal])
  );
  return eligible.map((asset) => validateProposalAgainstAsset(bySymbol.get(asset.symbol), asset, model));
}

function fallbackIntelligence(assets: MarketAsset[], reason: string): TradeProposal[] {
  return assets.filter((asset) => asset.eligible).map((asset) => ({
    symbol: asset.symbol,
    action: 'hold',
    confidence: 0,
    thesis: `Local intelligence unavailable: ${cleanText(reason, 180)}`,
    invalidation: 'A verified local-model response is required.',
    featureRefs: [],
    model: process.env.HII_TRADER_MODEL || 'ollama-auto'
  }));
}

function krakenAsset(
  symbol: string,
  name: string,
  assetClass: AssetClass,
  ticker: Record<string, unknown>,
  observedAt: string
): MarketAsset {
  const last = Number((ticker.c as unknown[])?.[0]);
  const open = Number(ticker.o);
  const volume = Number((ticker.v as unknown[])?.[1]);
  const bid = Number((ticker.b as unknown[])?.[0]);
  const ask = Number((ticker.a as unknown[])?.[0]);
  const priceUsd = Number.isFinite(last) ? last : 0;
  const change24hPct = open > 0 ? ((last - open) / open) * 100 : 0;
  const spreadPct = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
  const volume24hUsd = Number.isFinite(volume * last) ? volume * last : 0;
  const reasons: string[] = [];
  if (priceUsd <= 0) reasons.push('invalid market price');
  if (volume24hUsd < 5_000_000) reasons.push('24-hour dollar volume below $5m');
  if (spreadPct === null || spreadPct > 0.75) reasons.push('spread above 0.75% or unavailable');
  return {
    symbol,
    name,
    assetClass,
    venue: 'Kraken',
    priceUsd,
    change24hPct,
    volume24hUsd,
    liquidityUsd: null,
    spreadPct,
    pairAgeHours: null,
    socialLinks: 0,
    observedAt,
    eligible: reasons.length === 0,
    ineligibleReasons: reasons,
    sourceRefs: ['https://api.kraken.com/0/public/Ticker']
  };
}

function tickerFor(result: Record<string, Record<string, unknown>>, hints: string[]) {
  const key = Object.keys(result).find((candidate) => hints.some((hint) => candidate.toUpperCase().includes(hint)));
  return key ? result[key] : {};
}

async function fetchKrakenMarket(): Promise<MarketAsset[]> {
  const observedAt = nowIso();
  const response = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,DOGEUSD', {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Kraken returned HTTP ${response.status}`);
  const payload = await response.json() as { error?: string[]; result?: Record<string, Record<string, unknown>> };
  if (payload.error?.length) throw new Error(`Kraken: ${payload.error.join(', ')}`);
  const result = payload.result || {};
  return [
    krakenAsset('BTC', 'Bitcoin', 'core', tickerFor(result, ['XBT']), observedAt),
    krakenAsset('ETH', 'Ethereum', 'core', tickerFor(result, ['ETH']), observedAt),
    krakenAsset('SOL', 'Solana', 'core', tickerFor(result, ['SOL']), observedAt),
    krakenAsset('DOGE', 'Dogecoin', 'meme-cex', tickerFor(result, ['XDG', 'DOGE']), observedAt)
  ];
}

async function fetchDexWatchlist(): Promise<MarketAsset[]> {
  try {
    const profilesResponse = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      signal: AbortSignal.timeout(10_000)
    });
    if (!profilesResponse.ok) return [];
    const profiles = await profilesResponse.json() as Array<Record<string, unknown>>;
    const solana = profiles.filter((item) => item.chainId === 'solana' && typeof item.tokenAddress === 'string').slice(0, 4);
    const assets: MarketAsset[] = [];
    for (const profile of solana) {
      const address = String(profile.tokenAddress);
      const pairResponse = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(address)}`, {
        signal: AbortSignal.timeout(10_000)
      });
      if (!pairResponse.ok) continue;
      const pairs = await pairResponse.json() as Array<Record<string, unknown>>;
      const pair = pairs.sort((a, b) => Number((b.liquidity as Record<string, unknown>)?.usd) - Number((a.liquidity as Record<string, unknown>)?.usd))[0];
      if (!pair) continue;
      const base = pair.baseToken as Record<string, unknown> | undefined;
      const info = pair.info as Record<string, unknown> | undefined;
      const liquidityUsd = Number((pair.liquidity as Record<string, unknown>)?.usd) || 0;
      const volume24hUsd = Number((pair.volume as Record<string, unknown>)?.h24) || 0;
      const pairCreatedAt = Number(pair.pairCreatedAt);
      const pairAgeHours = pairCreatedAt > 0 ? (Date.now() - pairCreatedAt) / 3_600_000 : null;
      const socialLinks = Array.isArray(info?.socials) ? info.socials.length : 0;
      const reasons = ['on-chain mint, holder, and contract safety verification unavailable'];
      if (liquidityUsd < 250_000) reasons.push('liquidity below $250k');
      if (volume24hUsd < 500_000) reasons.push('24-hour volume below $500k');
      if (pairAgeHours === null || pairAgeHours < 24) reasons.push('pair age below 24 hours or unavailable');
      assets.push({
        symbol: cleanText(base?.symbol, 20).toUpperCase() || address.slice(0, 6),
        name: cleanText(base?.name, 80) || 'Solana token',
        assetClass: 'meme-dex',
        venue: cleanText(pair.dexId, 40) || 'Solana DEX',
        priceUsd: Number(pair.priceUsd) || 0,
        change24hPct: Number((pair.priceChange as Record<string, unknown>)?.h24) || 0,
        volume24hUsd,
        liquidityUsd,
        spreadPct: null,
        pairAgeHours,
        socialLinks,
        observedAt: nowIso(),
        eligible: false,
        ineligibleReasons: reasons,
        sourceRefs: [`https://api.dexscreener.com/token-pairs/v1/solana/${address}`]
      });
    }
    return assets;
  } catch {
    return [];
  }
}

async function defaultMarketProvider() {
  const [kraken, dex] = await Promise.all([fetchKrakenMarket(), fetchDexWatchlist()]);
  return [...kraken, ...dex];
}

function markPositions(positions: Position[], assets: MarketAsset[], at: string) {
  const prices = new Map(assets.map((asset) => [asset.symbol, asset.priceUsd]));
  return positions.map((position) => {
    const markPriceUsd = prices.get(position.symbol) || position.markPriceUsd;
    return {
      ...position,
      markPriceUsd,
      marketValueUsd: position.quantity * markPriceUsd,
      unrealizedPnlUsd: position.quantity * (markPriceUsd - position.averagePriceUsd),
      updatedAt: at
    };
  });
}

function executePaperOrder(input: {
  state: TraderState;
  metrics: ReturnType<typeof defaultMetrics>;
  positions: Position[];
  asset: MarketAsset;
  risk: RiskDecision;
  at: string;
}) {
  const { state, metrics, positions, asset, risk, at } = input;
  const side: 'buy' | 'sell' = risk.action === 'buy' ? 'buy' : 'sell';
  const slippageMultiplier = side === 'buy' ? 1 + PAPER_SLIPPAGE_PCT / 100 : 1 - PAPER_SLIPPAGE_PCT / 100;
  const priceUsd = asset.priceUsd * slippageMultiplier;
  const current = positions.find((position) => position.symbol === asset.symbol);
  const maximumNotional = side === 'buy' ? Math.min(risk.notionalUsd, state.cashUsd / (1 + PAPER_FEE_PCT / 100)) : current?.marketValueUsd ?? 0;
  const quantity = side === 'sell' && current
    ? current.quantity
    : maximumNotional / priceUsd;
  const notionalUsd = quantity * priceUsd;
  const feeUsd = notionalUsd * (PAPER_FEE_PCT / 100);
  if (quantity <= 0 || notionalUsd <= 0) return undefined;

  if (side === 'buy') {
    state.cashUsd -= notionalUsd + feeUsd;
    const existingQuantity = current?.quantity ?? 0;
    const totalQuantity = existingQuantity + quantity;
    const averagePriceUsd = totalQuantity > 0
      ? (((current?.averagePriceUsd ?? 0) * existingQuantity) + priceUsd * quantity) / totalQuantity
      : priceUsd;
    const updated: Position = {
      symbol: asset.symbol,
      assetClass: asset.assetClass,
      quantity: totalQuantity,
      averagePriceUsd,
      markPriceUsd: asset.priceUsd,
      marketValueUsd: totalQuantity * asset.priceUsd,
      unrealizedPnlUsd: totalQuantity * (asset.priceUsd - averagePriceUsd),
      updatedAt: at
    };
    savePosition(updated, asset.symbol);
  } else if (current) {
    state.cashUsd += notionalUsd - feeUsd;
    const pnl = quantity * (priceUsd - current.averagePriceUsd) - feeUsd;
    metrics.realizedPnlUsd += pnl;
    metrics.closedTrades += 1;
    if (pnl > 0) metrics.winningTrades += 1;
    savePosition(null, asset.symbol);
  }
  metrics.totalFeesUsd += feeUsd;
  return {
    id: randomUUID(),
    side,
    quantity,
    priceUsd,
    notionalUsd,
    feeUsd,
    slippagePct: PAPER_SLIPPAGE_PCT
  };
}

function resetDayAnchors(state: TraderState, at: string, db: DatabaseSync) {
  const day = today(at);
  if (state.day === day) return;
  db.prepare('INSERT OR REPLACE INTO hii_trader_daily_equity(day, equity_usd, recorded_at) VALUES (?, ?, ?)')
    .run(state.day, state.equityUsd, at);
  state.day = day;
  state.dayStartEquityUsd = state.equityUsd;
  const sevenDaysAgo = new Date(Date.parse(at) - 7 * 86_400_000).toISOString().slice(0, 10);
  const anchor = db.prepare('SELECT equity_usd FROM hii_trader_daily_equity WHERE day >= ? ORDER BY day ASC LIMIT 1')
    .get(sevenDaysAgo) as { equity_usd: number } | undefined;
  state.rollingSevenDayStartUsd = anchor?.equity_usd || state.equityUsd;
}

export async function runTraderCycle(options: {
  force?: boolean;
  marketProvider?: MarketProvider;
  intelligenceProvider?: IntelligenceProvider;
  at?: string;
} = {}) {
  const db = database();
  const at = options.at || nowIso();
  const profile = getProfile(db);
  const state = getState(db);
  resetDayAnchors(state, at, db);
  if (!options.force && state.mode !== 'paper') return getTraderSnapshot();
  if (state.mode === 'killed') throw new Error(`Trader is killed: ${state.killReason || 'operator kill switch'}`);
  if (state.cycleStartedAt && Date.parse(at) - Date.parse(state.cycleStartedAt) < CYCLE_LEASE_MS) {
    throw new Error('A trader cycle is already running.');
  }
  state.cycleStartedAt = at;
  saveState(state, db);

  try {
    const assets = await (options.marketProvider || defaultMarketProvider)();
    if (!assets.length) throw new Error('No verified market observations returned.');
    for (const asset of assets) {
      db.prepare(`
        INSERT INTO hii_trader_market(symbol, asset_json, observed_at) VALUES (?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET asset_json = excluded.asset_json, observed_at = excluded.observed_at
      `).run(asset.symbol, JSON.stringify(asset), asset.observedAt);
    }
    let proposals: TradeProposal[];
    try {
      proposals = await (options.intelligenceProvider || ollamaIntelligence)(assets);
    } catch (error) {
      proposals = fallbackIntelligence(assets, error instanceof Error ? error.message : String(error));
    }
    // Paper-only: this synthesizes a buy the model never proposed, so it must never
    // reach a live account even if the live lock is later opened.
    if (state.mode === 'paper') proposals = ensureNonDegenerateProposals(assets, proposals);
    const proposalMap = new Map(proposals.map((proposal) => [proposal.symbol, proposal]));
    let positions = markPositions(listPositions(db), assets, at);
    for (const position of positions) savePosition(position, position.symbol, db);
    const metrics = getMetrics(db);
    if (!metrics.firstPaperAt && state.mode === 'paper') metrics.firstPaperAt = at;
    const decisions: DecisionRecord[] = [];

    for (const asset of assets) {
      const proposal = proposalMap.get(asset.symbol) || {
        symbol: asset.symbol,
        action: 'hold' as const,
        confidence: 0,
        thesis: asset.eligible ? 'No verified model proposal.' : 'Asset failed deterministic eligibility.',
        invalidation: 'Wait for verified evidence.',
        featureRefs: [],
        model: process.env.HII_TRADER_MODEL || 'ollama-auto'
      };
      const risk = evaluateRisk({ profile, state, positions, asset, proposal });
      const decision: DecisionRecord = { id: randomUUID(), createdAt: at, asset, proposal, risk };
      if (risk.approved) {
        decision.fill = executePaperOrder({ state, metrics, positions, asset, risk, at });
        positions = markPositions(listPositions(db), assets, at);
      }
      db.prepare('INSERT INTO hii_trader_decisions(id, decision_json, created_at) VALUES (?, ?, ?)')
        .run(decision.id, JSON.stringify(decision), at);
      decisions.push(decision);
    }

    positions = markPositions(listPositions(db), assets, at);
    for (const position of positions) savePosition(position, position.symbol, db);
    state.equityUsd = state.cashUsd + positions.reduce((sum, position) => sum + position.marketValueUsd, 0);
    state.highWaterUsd = Math.max(state.highWaterUsd, state.equityUsd);
    state.lastCycleAt = at;
    state.cycleStartedAt = null;
    const stats = stateStats(state);
    if (stats.drawdownPct >= profile.maximumDrawdownPct) {
      state.mode = 'killed';
      state.killReason = `Maximum paper drawdown reached ${stats.drawdownPct.toFixed(2)}%.`;
    } else if (stats.dailyPnlPct <= -profile.dailyLossPct || stats.rollingSevenDayPnlPct <= -profile.rollingSevenDayLossPct) {
      state.mode = 'paused';
      state.killReason = 'Loss circuit breaker paused new trading.';
    }
    saveMetrics(metrics, db);
    saveState(state, db);
    storeReceipt('trader.cycle', `Paper cycle evaluated ${assets.length} assets and filled ${decisions.filter((item) => item.fill).length} orders.`, {
      mode: state.mode,
      equityUsd: state.equityUsd,
      assets: assets.length,
      model: decisions.find((item) => item.proposal.model !== 'ollama-auto')?.proposal.model || 'ollama-auto',
      filledOrders: decisions.filter((item) => item.fill).length,
      decisionIds: decisions.map((item) => item.id)
    }, db);
    return getTraderSnapshot();
  } catch (error) {
    state.cycleStartedAt = null;
    saveState(state, db);
    storeReceipt('trader.cycle.failed', cleanText(error instanceof Error ? error.message : String(error), 800), {
      mode: state.mode,
      failedAt: at
    }, db);
    throw error;
  }
}

export function updateTradingProfile(input: Partial<TradingProfile>) {
  const db = database();
  const current = getProfile(db);
  const updated: TradingProfile = {
    ...current,
    name: cleanText(input.name ?? current.name, 80) || current.name,
    startingCapitalUsd: current.startingCapitalUsd,
    maximumDrawdownPct: clamp(input.maximumDrawdownPct, current.maximumDrawdownPct, 5, 35),
    dailyLossPct: clamp(input.dailyLossPct, current.dailyLossPct, 0.5, 5),
    rollingSevenDayLossPct: clamp(input.rollingSevenDayLossPct, current.rollingSevenDayLossPct, 2, 15),
    memeAllocationPct: clamp(input.memeAllocationPct, current.memeAllocationPct, 0, 30),
    attentionBudget: ['low', 'medium', 'high'].includes(String(input.attentionBudget))
      ? input.attentionBudget as TradingProfile['attentionBudget']
      : current.attentionBudget,
    quietHours: {
      start: /^\d{2}:\d{2}$/.test(String(input.quietHours?.start)) ? String(input.quietHours?.start) : current.quietHours.start,
      end: /^\d{2}:\d{2}$/.test(String(input.quietHours?.end)) ? String(input.quietHours?.end) : current.quietHours.end
    },
    excludedSymbols: Array.isArray(input.excludedSymbols)
      ? input.excludedSymbols.map((value) => cleanText(value, 20).toUpperCase()).filter(Boolean).slice(0, 100)
      : current.excludedSymbols,
    version: current.version + 1,
    updatedAt: nowIso()
  };
  db.prepare(`
    INSERT INTO hii_trader_profiles(id, profile_json, version, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, version = excluded.version, updated_at = excluded.updated_at
  `).run(updated.id, JSON.stringify(updated), updated.version, updated.updatedAt);
  storeReceipt('trader.profile.updated', `Trading profile updated to version ${updated.version}.`, {
    profileVersion: updated.version,
    maximumDrawdownPct: updated.maximumDrawdownPct,
    memeAllocationPct: updated.memeAllocationPct
  }, db);
  return getTraderSnapshot();
}

export function controlTrader(action: 'start' | 'pause' | 'kill') {
  const db = database();
  const state = getState(db);
  if (action === 'start') {
    if (state.mode === 'killed') throw new Error('Kill switch is latched. Reset requires a reviewed recovery workflow.');
    state.mode = 'paper';
    state.startedAt ||= nowIso();
    state.killReason = null;
  } else if (action === 'pause') {
    state.mode = 'paused';
    state.killReason = null;
  } else {
    state.mode = 'killed';
    state.killReason = 'Operator emergency kill switch.';
  }
  saveState(state, db);
  storeReceipt(`trader.${action}`, `Trader ${action} requested by local operator.`, {
    mode: state.mode,
    liveUnlocked: false
  }, db);
  return getTraderSnapshot();
}

export function assertLiveTradingLocked(): never {
  storeReceipt('trader.live.denied', 'Live activation denied: fixed evidence gate has not passed.', {
    requiredPaperDays: 90,
    requiredClosedTrades: 200,
    liveUnlocked: false
  });
  throw new Error('Live trading is locked. The 90-day, 200-trade evidence gate and separate activation workflow are not complete.');
}

export function getTraderSnapshot(): TraderSnapshot {
  const db = database();
  const profile = getProfile(db);
  const state = getState(db);
  const stats = stateStats(state);
  const rawMetrics = getMetrics(db);
  const paperDays = rawMetrics.firstPaperAt
    ? Math.max(1, Math.floor((Date.now() - Date.parse(rawMetrics.firstPaperAt)) / 86_400_000) + 1)
    : 0;
  const decisions = (db.prepare('SELECT decision_json FROM hii_trader_decisions ORDER BY created_at DESC LIMIT 40').all() as
    { decision_json: string }[])
    .map((row) => readJson<DecisionRecord | null>(row.decision_json, null))
    .filter((row): row is DecisionRecord => row !== null);
  const market = (db.prepare('SELECT asset_json FROM hii_trader_market ORDER BY observed_at DESC LIMIT 40').all() as
    { asset_json: string }[])
    .map((row) => readJson<MarketAsset | null>(row.asset_json, null))
    .filter((row): row is MarketAsset => row !== null);
  const blockers = [
    ...(paperDays < 90 ? [`${90 - paperDays} more paper days required`] : []),
    ...(rawMetrics.closedTrades < 200 ? [`${200 - rawMetrics.closedTrades} more closed trades required`] : []),
    'walk-forward and baseline evidence not yet certified',
    'live credentials and isolated canary account not provisioned'
  ];
  return {
    status: { ...state, ...stats },
    profile,
    positions: listPositions(db),
    decisions,
    market,
    metrics: {
      realizedPnlUsd: rawMetrics.realizedPnlUsd,
      totalFeesUsd: rawMetrics.totalFeesUsd,
      closedTrades: rawMetrics.closedTrades,
      winRatePct: rawMetrics.closedTrades > 0 ? (rawMetrics.winningTrades / rawMetrics.closedTrades) * 100 : 0,
      paperDays
    },
    promotion: {
      liveLocked: true,
      eligible: false,
      requiredDays: 90,
      requiredClosedTrades: 200,
      completedDays: paperDays,
      completedClosedTrades: rawMetrics.closedTrades,
      blockers
    },
    dataCoverage: {
      market: 'kraken-public-api',
      dex: 'dex-screener-watch-only',
      onChainSecurity: 'not-configured',
      social: 'dex-metadata-only',
      intelligence: 'ollama-local'
    },
    receiptPath: receiptPath()
  };
}

export function traderCycleDue(at = Date.now()) {
  const state = getState();
  if (state.mode !== 'paper') return false;
  if (state.cycleStartedAt && at - Date.parse(state.cycleStartedAt) < CYCLE_LEASE_MS) return false;
  return !state.lastCycleAt || at - Date.parse(state.lastCycleAt) >= CYCLE_MINUTES * 60_000;
}

export function closeTraderDatabaseForTests() {
  for (const db of databases.values()) db.close();
  databases.clear();
}
