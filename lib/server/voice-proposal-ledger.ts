import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@/lib/server/atomic-write';
import { normalizeWorkspaceRunContext } from '@/lib/server/hii-workspace-run-context';
import type { VoiceProposal } from '@/lib/voice/types';

/**
 * `proposals.jsonl` is an append-only ledger of proposal transitions.
 *
 * A voice proposal is the record of what a human authorized, so its history is
 * audit-relevant: it must be possible to answer later what was approved, when,
 * by which transition, and from what prior state. Every other HII JSONL store
 * (`intents.jsonl`, `conversations.jsonl`, `events.jsonl`, `jobs.jsonl`) is
 * append-only, so this file follows the same contract rather than inventing a
 * second one.
 *
 * Consequences of that choice, all deliberate:
 *
 * - Prior lines are never rewritten, reordered or removed.
 * - Current state is folded from the transitions, latest valid one winning.
 * - Malformed lines stay in the file exactly as written and are reported as
 *   structured corruption rather than deleted. A record that cannot be parsed is
 *   evidence of something, and destroying it destroys the only copy.
 * - A retried transition carries the same event id and appends nothing twice.
 */

export const voiceProposalStatuses = new Set<VoiceProposal['status']>([
  'pending',
  'queued',
  'executed',
  'failed',
  'cancelled'
]);

export type VoiceProposalEventKind = 'proposal.created' | 'proposal.transitioned';

export interface VoiceProposalEvent {
  /** Stable across retries of the same logical transition, so replay is a no-op. */
  eventId: string;
  kind: VoiceProposalEventKind;
  proposalId: string;
  previousStatus: VoiceProposal['status'] | null;
  status: VoiceProposal['status'];
  at: string;
  /** Full snapshot, present on `proposal.created`. */
  proposal?: VoiceProposal;
  /** Field changes applied by a `proposal.transitioned` event. */
  patch?: Partial<VoiceProposal>;
}

export type VoiceProposalCorruptionReason =
  | 'unparseable-json'
  | 'unrecognized-record'
  | 'invalid-proposal'
  | 'invalid-transition'
  | 'transition-without-proposal';

export interface VoiceProposalCorruption {
  /** 1-based line number in the ledger file. The line itself is left in place. */
  line: number;
  reason: VoiceProposalCorruptionReason;
  /** The raw line, preserved verbatim for recovery (capped only for reporting). */
  raw: string;
  proposalId?: string;
}

export interface VoiceProposalLedger {
  /** Folded current state, in the order each proposal first appeared. */
  proposals: VoiceProposal[];
  events: VoiceProposalEvent[];
  corruption: VoiceProposalCorruption[];
  eventIds: Set<string>;
  /** Total non-empty lines read, including corrupt ones. */
  lineCount: number;
}

/**
 * Validates a persisted proposal snapshot.
 *
 * Proposals authorize bounded execution, so a snapshot missing the fields that
 * make it identifiable or executable is not treated as one. It is reported, not
 * repaired by guesswork and not erased.
 */
export function validateProposal(value: unknown): VoiceProposal | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id ?? '').trim();
  const status = String(raw.status ?? '') as VoiceProposal['status'];
  if (!id || !voiceProposalStatuses.has(status)) return null;
  if (typeof raw.capabilityId !== 'string' || !raw.capabilityId) return null;
  if (typeof raw.createdAt !== 'string' || !raw.createdAt) return null;
  const normalizedText = typeof raw.normalizedText === 'string' ? raw.normalizedText : '';
  if (!normalizedText) return null;
  return {
    ...(raw as unknown as VoiceProposal),
    id,
    status,
    normalizedText,
    inputs: raw.inputs && typeof raw.inputs === 'object' ? (raw.inputs as Record<string, unknown>) : {},
    context: normalizeWorkspaceRunContext(raw.context)
  };
}

function isLedgerEvent(raw: Record<string, unknown>) {
  return raw.kind === 'proposal.created' || raw.kind === 'proposal.transitioned';
}

function validateEvent(raw: Record<string, unknown>): VoiceProposalEvent | VoiceProposalCorruptionReason {
  const eventId = String(raw.eventId ?? '').trim();
  const proposalId = String(raw.proposalId ?? '').trim();
  const status = String(raw.status ?? '') as VoiceProposal['status'];
  const at = typeof raw.at === 'string' ? raw.at : '';
  if (!eventId || !proposalId || !at || !voiceProposalStatuses.has(status)) return 'invalid-transition';
  const previousStatus = raw.previousStatus === null || raw.previousStatus === undefined
    ? null
    : (String(raw.previousStatus) as VoiceProposal['status']);
  if (previousStatus !== null && !voiceProposalStatuses.has(previousStatus)) return 'invalid-transition';

  if (raw.kind === 'proposal.created') {
    const proposal = validateProposal(raw.proposal);
    if (!proposal || proposal.id !== proposalId) return 'invalid-proposal';
    return { eventId, kind: 'proposal.created', proposalId, previousStatus, status, at, proposal };
  }
  const patch = raw.patch && typeof raw.patch === 'object' ? (raw.patch as Partial<VoiceProposal>) : {};
  return { eventId, kind: 'proposal.transitioned', proposalId, previousStatus, status, at, patch };
}

/**
 * Reads a legacy pre-ledger line: a bare proposal snapshot with no event
 * envelope. Older runtimes wrote proposals this way, so those files stay
 * readable without being rewritten.
 */
function legacyCreatedEvent(raw: Record<string, unknown>, line: number): VoiceProposalEvent | null {
  const proposal = validateProposal(raw);
  if (!proposal) return null;
  return {
    eventId: `legacy:${proposal.id}:${line}`,
    kind: 'proposal.created',
    proposalId: proposal.id,
    previousStatus: null,
    status: proposal.status,
    at: proposal.updatedAt || proposal.createdAt,
    proposal
  };
}

/** Reads and folds the ledger. Never writes, never repairs the file. */
export async function readVoiceProposalLedger(filePath: string): Promise<VoiceProposalLedger> {
  let contents = '';
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    return { proposals: [], events: [], corruption: [], eventIds: new Set(), lineCount: 0 };
  }

  const events: VoiceProposalEvent[] = [];
  const corruption: VoiceProposalCorruption[] = [];
  const eventIds = new Set<string>();
  let lineCount = 0;

  contents.split('\n').forEach((rawLine, index) => {
    const line = index + 1;
    if (!rawLine.trim()) return;
    lineCount += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      corruption.push({ line, reason: 'unparseable-json', raw: rawLine.slice(0, 2000) });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      corruption.push({ line, reason: 'unrecognized-record', raw: rawLine.slice(0, 2000) });
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (isLedgerEvent(record)) {
      const result = validateEvent(record);
      if (typeof result === 'string') {
        corruption.push({
          line,
          reason: result,
          raw: rawLine.slice(0, 2000),
          proposalId: String(record.proposalId ?? '') || undefined
        });
        return;
      }
      if (eventIds.has(result.eventId)) return; // A replayed transition is not a second one.
      eventIds.add(result.eventId);
      events.push(result);
      return;
    }

    const legacy = legacyCreatedEvent(record, line);
    if (!legacy) {
      corruption.push({
        line,
        reason: 'invalid-proposal',
        raw: rawLine.slice(0, 2000),
        proposalId: String(record.id ?? '') || undefined
      });
      return;
    }
    eventIds.add(legacy.eventId);
    events.push(legacy);
  });

  const byId = new Map<string, VoiceProposal>();
  for (const event of events) {
    if (event.kind === 'proposal.created') {
      const existing = byId.get(event.proposalId);
      // A real ledger creates once; legacy files may hold successive snapshots
      // of the same proposal, so the later one wins without losing the earlier
      // line from the file.
      byId.set(event.proposalId, existing ? { ...existing, ...event.proposal! } : event.proposal!);
      continue;
    }
    const current = byId.get(event.proposalId);
    if (!current) {
      corruption.push({
        line: 0,
        reason: 'transition-without-proposal',
        raw: JSON.stringify(event).slice(0, 2000),
        proposalId: event.proposalId
      });
      continue;
    }
    byId.set(event.proposalId, {
      ...current,
      ...(event.patch ?? {}),
      status: event.status,
      updatedAt: event.at
    });
  }

  return { proposals: [...byId.values()], events, corruption, eventIds, lineCount };
}

async function appendEvent(filePath: string, event: VoiceProposalEvent) {
  await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

/**
 * Records the creation of a proposal.
 *
 * Idempotent by proposal id: re-recording an existing proposal appends nothing
 * and returns the state already on file.
 */
export async function recordProposalCreated(filePath: string, proposal: VoiceProposal) {
  await mkdir(path.dirname(filePath), { recursive: true });
  return withFileLock(filePath, async () => {
    const ledger = await readVoiceProposalLedger(filePath);
    const existing = ledger.proposals.find((entry) => entry.id === proposal.id);
    if (existing) return existing;
    const event: VoiceProposalEvent = {
      eventId: `${proposal.id}:created`,
      kind: 'proposal.created',
      proposalId: proposal.id,
      previousStatus: null,
      status: proposal.status,
      at: proposal.createdAt,
      proposal
    };
    await appendEvent(filePath, event);
    return proposal;
  });
}

/**
 * Appends one immutable status transition.
 *
 * `transitionKey` makes retries idempotent: the same logical transition, fired
 * twice, produces one event. Distinct transitions fired concurrently each get
 * their own line, so none is lost.
 *
 * Returns `undefined` when the proposal is not on file — a transition is never
 * allowed to invent the thing it transitions.
 */
export async function recordProposalTransition(
  filePath: string,
  input: {
    proposalId: string;
    status: VoiceProposal['status'];
    patch?: Partial<VoiceProposal>;
    transitionKey?: string;
  }
) {
  if (!voiceProposalStatuses.has(input.status)) {
    throw new Error(`Unsupported proposal status: ${input.status}`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  return withFileLock(filePath, async () => {
    const ledger = await readVoiceProposalLedger(filePath);
    const current = ledger.proposals.find((entry) => entry.id === input.proposalId);
    if (!current) return undefined;

    const eventId = `${input.proposalId}:${input.transitionKey || input.status}`;
    if (ledger.eventIds.has(eventId)) return current;

    const at = new Date().toISOString();
    const event: VoiceProposalEvent = {
      eventId,
      kind: 'proposal.transitioned',
      proposalId: input.proposalId,
      previousStatus: current.status,
      status: input.status,
      at,
      patch: input.patch ?? {}
    };
    await appendEvent(filePath, event);
    return { ...current, ...(input.patch ?? {}), status: input.status, updatedAt: at };
  });
}
