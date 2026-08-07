export type WindowsPreservationMode = 'live' | 'fixture';

export type ArtifactVerificationStatus = 'verified' | 'partial' | 'dry-run' | 'claimed-missing' | 'metadata-only';

type CommandName = 'hii' | 'codex' | 'claude' | 'ollama';
type RawRecord = Record<string, unknown>;
type Mutable<T> = { [K in keyof T]: T[K] };

export interface WindowsPreservationBuildOptions {
  mode: WindowsPreservationMode;
  generatedAt?: string;
  alias?: string;
}

interface ProcessClaim {
  source: string;
  pid: number | null;
  expectedRunning: boolean;
  stale: boolean;
}

export interface WindowsPreservationManifest {
  schemaVersion: 1;
  kind: 'hii.windows-preservation/1';
  generatedAt: string;
  source: { mode: WindowsPreservationMode; alias: string };
  machine: { os: string; build: string };
  legacyRepo: { path: string; branch: string; head: string; dirty: { count: number; paths: string[] } };
  installedBinary: { path: string; version: string; sizeBytes: number; sha256: string };
  commands: Record<CommandName, { present: boolean; path: string | null; version: string }>;
  processEvidence: {
    stale: boolean;
    live: Array<{ name: string; pid: number | null; path: string | null; startTime: string | null }>;
    statusFileClaims: ProcessClaim[];
  };
  port3042: { route: string; status: 'open' | 'closed' | 'error' | 'unknown'; statusCode: number | null; body: string | null };
  inventory: {
    capabilities: { count: number; paths: string[]; metadata: string[] };
    skills: { count: number; paths: string[]; metadata: string[] };
    memories: { count: number; paths: string[]; metadata: string[] };
    artifacts: { count: number; paths: string[]; metadata: string[] };
  };
  artifactProof: {
    model3dm: {
      status: ArtifactVerificationStatus;
      claim: boolean;
      path: string;
      verified: boolean;
      reason: string;
      metadata: { sizeBytes: number | null; sha256: string | null; lastVerifiedAt: string | null };
    };
    ghLog: {
      status: ArtifactVerificationStatus;
      claim: boolean;
      path: string;
      verified: boolean;
      reason: string;
      metadata: { containsDryRun: boolean; lastSeenAt: string | null; sizeBytes: number | null };
    };
  };
  warnings: string[];
}

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /apikey/i,
  /private[_-]?key/i,
  /privatekey/i,
  /commandline/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential(s)?/i,
  /auth/i,
  /email/i,
  /bearer/i
];
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
  /\bBearer\s+[^\s"']+/gi,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s",']+/gi
];

export function normalizeUserProfilePath(value: string): string {
  return String(value)
    .replace(/[A-Za-z]:[\\/]+Users[\\/][^\\/\s]+/g, '%USERPROFILE%');
}

export function redactPreservationValue(value: unknown): unknown {
  const isSecretLikeKey = (key: string): boolean => SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
  const redactSecretString = (text: string): string => {
    let output = text;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      output = output.replace(pattern, '[redacted]');
    }
    return output;
  };
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecretString(value);
  if (Array.isArray(value)) return value.map((entry) => redactPreservationValue(entry));
  if (typeof value === 'object') {
    const raw = value as RawRecord;
    const out: RawRecord = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (isSecretLikeKey(key)) continue;
      out[key] = redactPreservationValue(entry);
    }
    return out;
  }
  return value;
}

const toInt = (value: unknown): number | null => {
  return Number.isFinite(value as number) ? Number(value) : null;
};

const uniqueSorted = (values?: unknown[]): string[] => {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()))].sort();
};

const normalizeCount = (record?: { count?: unknown; paths?: unknown[]; metadata?: unknown[] }) => ({
  count: toInt(record?.count) ?? (Array.isArray(record?.paths) ? record.paths.length : 0),
  paths: uniqueSorted(record?.paths),
  metadata: uniqueSorted(record?.metadata)
});

const normalizeCommand = (value: unknown): { present: boolean; path: string | null; version: string } => {
  if (!value || typeof value !== 'object') return { present: false, path: null, version: 'unknown' };
  const raw = value as RawRecord;
  return {
    present: Boolean(raw.present),
    path: typeof raw.path === 'string' ? normalizeUserProfilePath(raw.path) : null,
    version: typeof raw.version === 'string' ? raw.version : 'unknown'
  };
};

const normalizeProcessClaims = (value: unknown): Array<{ source: string; pid: number | null; expectedRunning: boolean }> => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') return { source: 'daemon', pid: null, expectedRunning: false };
    const raw = entry as RawRecord;
    const pid = toInt(raw.pid);
    const state = typeof raw.state === 'string' ? String(raw.state).toLowerCase() : '';
    const expectedRunning = raw.expectedRunning === true;
    return {
      source: String(raw.source ?? raw.name ?? 'daemon'),
      pid,
      expectedRunning: expectedRunning || state === 'running' || raw.running === true
    };
  });
};

const normalizeArtifactModel = (raw?: unknown): WindowsPreservationManifest['artifactProof']['model3dm'] => {
  const record = (raw as RawRecord) ?? {};
  const path = typeof record.path === 'string' ? normalizeUserProfilePath(record.path) : '';
  const claim = record.claim === true;
  const exists = record.exists === true;
  const sizeBytes = toInt(record.sizeBytes);
  const sha256 = typeof record.sha256 === 'string' ? record.sha256 : null;
  const status: ArtifactVerificationStatus = claim && !exists
    ? 'claimed-missing'
    : exists && sizeBytes != null && sizeBytes > 0 && !!sha256
      ? 'verified'
      : 'metadata-only';
  return {
    status,
    claim,
    path,
    verified: status === 'verified',
    reason: status === 'verified'
      ? 'artifact verified by size and digest'
      : claim && !exists
        ? 'artifact was claimed but not present'
        : 'artifact metadata-only',
    metadata: { sizeBytes, sha256, lastVerifiedAt: null }
  };
};

const normalizeArtifactLog = (raw?: unknown): WindowsPreservationManifest['artifactProof']['ghLog'] => {
  const record = (raw as RawRecord) ?? {};
  const path = typeof record.path === 'string' ? normalizeUserProfilePath(record.path) : '';
  const claim = record.claim === true;
  const exists = record.exists === true;
  const containsDryRun = record.containsDryRun === true;
  const sizeBytes = toInt(record.sizeBytes);
  const status: ArtifactVerificationStatus = containsDryRun
    ? 'dry-run'
    : claim && !exists
      ? 'claimed-missing'
      : exists ? 'metadata-only' : 'metadata-only';
  const isDryRun = containsDryRun === true;
  return {
    status,
    claim,
    path,
    verified: false,
    reason: isDryRun
      ? 'gh_log contains DRY_RUN marker'
      : claim && !exists
        ? 'artifact was claimed but not present'
        : 'artifact metadata-only',
    metadata: {
      containsDryRun,
      lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null,
      sizeBytes
    }
  };
};

export function buildWindowsPreservationManifest(raw: unknown, options: WindowsPreservationBuildOptions): WindowsPreservationManifest {
  const input = (redactPreservationValue(raw) as RawRecord) ?? {};
  const mode = options.mode;
  const alias = options.alias ?? 'hii-pc';
  const generatedAt = typeof options.generatedAt === 'string' && options.generatedAt.trim() ? options.generatedAt : new Date().toISOString();

  const probe = (input.processes as RawRecord) ?? {};
  const claimsInput = (input.statusClaims as unknown) ?? probe?.statusFileClaims;
  const live = Array.isArray(probe.live)
    ? (probe.live as RawRecord[]).map((entry) => {
      if (!entry || typeof entry !== 'object') return { name: 'unknown', pid: null, path: null, startTime: null };
      return {
        name: typeof entry.name === 'string' ? entry.name : 'unknown',
        pid: toInt(entry.pid),
        path: typeof entry.path === 'string' ? normalizeUserProfilePath(entry.path as string) : null,
        startTime: typeof entry.startTime === 'string' ? entry.startTime : null
      };
    })
    : [];

  const livePids = new Set(live.map((entry) => entry.pid).filter((pid): pid is number => pid != null));
  const statusFileClaims = normalizeProcessClaims(claimsInput).map((entry) => ({
    ...entry,
    stale: Boolean(entry.expectedRunning && entry.pid != null && !livePids.has(entry.pid))
  }));

  const stale = statusFileClaims.some((entry) => entry.stale) || probe.stale === true;
  const warnings = uniqueSorted(Array.isArray(input.warnings) ? input.warnings : []);
  const legacyRepoRecord = (input.legacyRepo as RawRecord) ?? {};
  const legacyRepoDirty = (legacyRepoRecord.dirty as RawRecord) ?? {};
  const legacyRepo = {
    path: typeof legacyRepoRecord.path === 'string'
      ? normalizeUserProfilePath(String(legacyRepoRecord.path))
      : '',
    branch: typeof legacyRepoRecord.branch === 'string'
      ? String(legacyRepoRecord.branch)
      : 'unknown',
    head: typeof legacyRepoRecord.head === 'string'
      ? String(legacyRepoRecord.head)
      : 'unknown',
    dirty: {
      count: toInt(legacyRepoDirty.count) ?? (Array.isArray(legacyRepoDirty.paths) ? (legacyRepoDirty.paths as unknown[]).length : 0),
      paths: uniqueSorted(Array.isArray(legacyRepoDirty.paths)
        ? (legacyRepoDirty.paths as unknown[]).map((entry) => normalizeUserProfilePath(String(entry)))
        : [])
    }
  };

  const installedBinary = (typeof input.installedBinary === 'object' && input.installedBinary !== null)
    ? (input.installedBinary as RawRecord)
    : {};
  const artifactSource = (input.artifacts as RawRecord) ?? {};
  const model3dm = normalizeArtifactModel(artifactSource.model3dm);
  const ghLog = normalizeArtifactLog(artifactSource.ghLog);

  if (stale) warnings.push('stale daemon state detected');
  if (input.legacyCliCollision === true) warnings.push('legacy CLI collision detected');
  if (input.epermAtomicRename === true) warnings.push('Windows EPERM atomic rename evidence present');
  if (model3dm.claim && model3dm.status !== 'verified') warnings.push('unverified claimed artifact: model.3dm');
  if (ghLog.claim && ghLog.status !== 'verified') warnings.push('unverified claimed artifact: gh_log');

  const manifest: WindowsPreservationManifest = {
    schemaVersion: 1,
    kind: 'hii.windows-preservation/1',
    generatedAt,
    source: { mode, alias },
    machine: {
      os: typeof input.machine === 'object' && input.machine !== null && typeof (input.machine as RawRecord).os === 'string'
        ? String((input.machine as RawRecord).os)
        : 'unknown',
      build: typeof input.machine === 'object' && input.machine !== null && typeof (input.machine as RawRecord).build === 'string'
        ? String((input.machine as RawRecord).build)
        : 'unknown'
    },
    legacyRepo,
    installedBinary: {
      path: typeof installedBinary.path === 'string' ? normalizeUserProfilePath(String(installedBinary.path)) : '',
      version: typeof installedBinary.version === 'string' ? String(installedBinary.version) : 'unknown',
      sizeBytes: toInt(installedBinary.sizeBytes) ?? 0,
      sha256: typeof installedBinary.sha256 === 'string' ? String(installedBinary.sha256) : ''
    },
    commands: {
      hii: normalizeCommand((input.commands as RawRecord | undefined)?.hii),
      codex: normalizeCommand((input.commands as RawRecord | undefined)?.codex),
      claude: normalizeCommand((input.commands as RawRecord | undefined)?.claude),
      ollama: normalizeCommand((input.commands as RawRecord | undefined)?.ollama)
    },
    processEvidence: {
      stale,
      live,
      statusFileClaims
    },
    port3042: {
      route: typeof (input.port3042 as RawRecord)?.route === 'string' ? String((input.port3042 as RawRecord).route) : '/api/daemon',
      status: ((input.port3042 as RawRecord)?.status as 'open' | 'closed' | 'error' | 'unknown') ?? 'unknown',
      statusCode:
        toInt((input.port3042 as RawRecord)?.statusCode),
      body: null
    },
    inventory: {
      capabilities: normalizeCount((input.inventory as RawRecord)?.capabilities as { count?: unknown; paths?: unknown[]; metadata?: unknown[] }),
      skills: normalizeCount((input.inventory as RawRecord)?.skills as { count?: unknown; paths?: unknown[]; metadata?: unknown[] }),
      memories: normalizeCount((input.inventory as RawRecord)?.memories as { count?: unknown; paths?: unknown[]; metadata?: unknown[] }),
      artifacts: normalizeCount((input.inventory as RawRecord)?.artifacts as { count?: unknown; paths?: unknown[]; metadata?: unknown[] })
    },
    artifactProof: {
      model3dm,
      ghLog
    },
    warnings
  };

  manifest.warnings = [...new Set(warnings)].sort();
  return manifest;
}
