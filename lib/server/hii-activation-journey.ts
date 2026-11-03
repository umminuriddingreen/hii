import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const activationJourneyMilestones = [
  'agents_detected',
  'context_previewed',
  'context_approved',
  'run_started',
  'receipt_verified',
  'run_failed'
] as const;

export type ActivationJourneyMilestone = typeof activationJourneyMilestones[number];

export type ActivationJourneyMetadata = {
  installedAgents?: number;
  itemCount?: number;
  totalBytes?: number;
  sourceCount?: number;
  agent?: 'codex' | 'claude';
  runKind?: 'codex-exec' | 'claude-spawn';
};

export type ActivationJourneyEvent = {
  schemaVersion: 1;
  id: string;
  journeyId: string;
  activationId: string | null;
  milestone: ActivationJourneyMilestone;
  at: string;
  metadata: ActivationJourneyMetadata;
};

export type ActivationJourney = {
  journeyId: string;
  status: 'in-progress' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  milestones: ActivationJourneyEvent[];
};

export type ActivationFunnelSummary = {
  localOnly: true;
  journeys: number;
  agentsDetected: number;
  contextPreviewed: number;
  contextApproved: number;
  runsStarted: number;
  receiptsVerified: number;
  runsFailed: number;
  completionRate: number;
  medianSecondsToReceipt: number | null;
  lastEventAt: string | null;
};

let writeQueue: Promise<unknown> = Promise.resolve();

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function eventsPath() {
  return path.join(runtimeRoot(), 'activations', 'events.jsonl');
}

function validId(value: unknown, label: string) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function metadata(value: ActivationJourneyMetadata | undefined): ActivationJourneyMetadata {
  const bounded = (input: unknown) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(number)) : undefined;
  };
  return {
    ...(bounded(value?.installedAgents) !== undefined ? { installedAgents: bounded(value?.installedAgents) } : {}),
    ...(bounded(value?.itemCount) !== undefined ? { itemCount: bounded(value?.itemCount) } : {}),
    ...(bounded(value?.totalBytes) !== undefined ? { totalBytes: bounded(value?.totalBytes) } : {}),
    ...(bounded(value?.sourceCount) !== undefined ? { sourceCount: bounded(value?.sourceCount) } : {}),
    ...(value?.agent === 'codex' || value?.agent === 'claude' ? { agent: value.agent } : {}),
    ...(value?.runKind === 'codex-exec' || value?.runKind === 'claude-spawn' ? { runKind: value.runKind } : {})
  };
}

async function readEvents(): Promise<ActivationJourneyEvent[]> {
  try {
    return (await readFile(eventsPath(), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as ActivationJourneyEvent;
          return event?.schemaVersion === 1
            && activationJourneyMilestones.includes(event.milestone)
            && typeof event.journeyId === 'string'
            && Number.isFinite(new Date(event.at).getTime())
            ? [event]
            : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function journeyFromEvents(journeyId: string, events: ActivationJourneyEvent[]): ActivationJourney | null {
  const milestones = events
    .filter((event) => event.journeyId === journeyId)
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  if (!milestones.length) return null;
  const startedAt = milestones[0].at;
  const updatedAt = milestones.at(-1)?.at ?? startedAt;
  const elapsedSeconds = Math.max(0, Math.round(
    (new Date(updatedAt).getTime() - new Date(startedAt).getTime()) / 1000
  ));
  return {
    journeyId,
    status: milestones.some((event) => event.milestone === 'receipt_verified')
      ? 'completed'
      : milestones.some((event) => event.milestone === 'run_failed')
        ? 'failed'
        : 'in-progress',
    startedAt,
    updatedAt,
    elapsedSeconds,
    milestones
  };
}

export async function recordActivationJourneyMilestone(input: {
  journeyId: string;
  activationId?: string;
  milestone: ActivationJourneyMilestone;
  metadata?: ActivationJourneyMetadata;
  at?: string;
}) {
  const journeyId = validId(input.journeyId, 'Activation journey id');
  const activationId = input.activationId ? validId(input.activationId, 'Activation id') : null;
  if (!activationJourneyMilestones.includes(input.milestone)) throw new Error('Activation milestone is invalid.');
  const at = input.at && Number.isFinite(new Date(input.at).getTime()) ? new Date(input.at).toISOString() : new Date().toISOString();

  let result: ActivationJourneyEvent | null = null;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const existing = await readEvents();
    const terminal = existing.find((event) =>
      event.journeyId === journeyId
      && ['receipt_verified', 'run_failed'].includes(event.milestone)
    );
    const duplicate = existing.find((event) =>
      event.journeyId === journeyId && event.milestone === input.milestone
    );
    if (terminal || duplicate) {
      result = duplicate ?? terminal ?? null;
      return;
    }
    const event: ActivationJourneyEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      journeyId,
      activationId,
      milestone: input.milestone,
      at,
      metadata: metadata(input.metadata)
    };
    await mkdir(path.dirname(eventsPath()), { recursive: true });
    await appendFile(eventsPath(), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
    result = event;
  });
  await writeQueue;
  if (!result) throw new Error('Activation milestone could not be recorded.');
  return result;
}

export async function readActivationJourney(journeyId: string) {
  return journeyFromEvents(validId(journeyId, 'Activation journey id'), await readEvents());
}

export async function activationFunnelSummary(): Promise<ActivationFunnelSummary> {
  const events = await readEvents();
  const journeyIds = [...new Set(events.map((event) => event.journeyId))];
  const journeys = journeyIds
    .map((journeyId) => journeyFromEvents(journeyId, events))
    .filter((journey): journey is ActivationJourney => Boolean(journey));
  const count = (milestone: ActivationJourneyMilestone) =>
    journeys.filter((journey) => journey.milestones.some((event) => event.milestone === milestone)).length;
  const receiptTimes = journeys
    .filter((journey) => journey.status === 'completed')
    .map((journey) => journey.elapsedSeconds)
    .sort((left, right) => left - right);
  const middle = Math.floor(receiptTimes.length / 2);
  const medianSecondsToReceipt = receiptTimes.length === 0
    ? null
    : receiptTimes.length % 2
      ? receiptTimes[middle]
      : Math.round((receiptTimes[middle - 1] + receiptTimes[middle]) / 2);
  const receiptsVerified = count('receipt_verified');
  return {
    localOnly: true,
    journeys: journeys.length,
    agentsDetected: count('agents_detected'),
    contextPreviewed: count('context_previewed'),
    contextApproved: count('context_approved'),
    runsStarted: count('run_started'),
    receiptsVerified,
    runsFailed: count('run_failed'),
    completionRate: journeys.length ? Number((receiptsVerified / journeys.length).toFixed(4)) : 0,
    medianSecondsToReceipt,
    lastEventAt: events.sort((left, right) => right.at.localeCompare(left.at))[0]?.at ?? null
  };
}
