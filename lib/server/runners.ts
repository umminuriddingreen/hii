import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { CapabilityJobStatus } from '@/lib/capabilities/types';
import { finalizeCapabilityJob, type CreditCurrency, type DurableCapabilityJob } from './credits';
import { supabaseAdmin } from './supabase';

export const defaultRunnerCapabilities = ['hii.rhino.managed_job'];

export type CapabilityRunner = {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'draining';
  capabilities: string[];
  last_seen_at: string | null;
  token_hash: string;
  created_at: string;
  updated_at: string;
};

export type RunnerProofArtifact = {
  kind?: 'log' | 'screenshot' | 'download' | 'receipt' | 'link' | 'json';
  label?: string;
  href?: string;
  path?: string;
  summary?: string;
};

export function createRunnerToken() {
  return `hii_runner_${randomBytes(32).toString('base64url')}`;
}

export function hashRunnerToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function parseRunnerToken(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function sanitizeRunnerCapabilities(value: unknown) {
  const raw = Array.isArray(value) ? value : defaultRunnerCapabilities;
  const capabilities = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => defaultRunnerCapabilities.includes(item));
  return capabilities.length > 0 ? Array.from(new Set(capabilities)) : defaultRunnerCapabilities;
}

function db() {
  const client = supabaseAdmin();
  if (!client) throw new Error('Supabase service role not configured');
  return client;
}

function tokenHashFromToken(token: string | null) {
  if (!token) {
    const error = new Error('Runner bearer token required');
    error.name = 'UnauthorizedRunner';
    throw error;
  }
  return hashRunnerToken(token);
}

export async function registerRunner(args: { name: string; token: string; capabilities?: string[] }) {
  const { data, error } = await db().rpc('register_capability_runner', {
    p_name: args.name,
    p_token_hash: hashRunnerToken(args.token),
    p_capabilities: sanitizeRunnerCapabilities(args.capabilities)
  });
  if (error) throw error;
  return data as CapabilityRunner;
}

export async function heartbeatRunner(args: { token: string | null; capabilities?: unknown }) {
  const { data, error } = await db().rpc('runner_heartbeat', {
    p_token_hash: tokenHashFromToken(args.token),
    p_capabilities: sanitizeRunnerCapabilities(args.capabilities)
  });
  if (error) throw error;
  return data as CapabilityRunner;
}

export async function claimNextRunnerJob(args: { token: string | null; capabilities?: unknown }) {
  const { data, error } = await db().rpc('claim_next_runner_job', {
    p_token_hash: tokenHashFromToken(args.token),
    p_capabilities: sanitizeRunnerCapabilities(args.capabilities)
  });
  if (error) throw error;
  return (data as DurableCapabilityJob | null) ?? null;
}

export async function appendRunnerJobEvents(args: {
  token: string | null;
  jobId: string;
  events: Array<{ actor?: string; text: string }>;
}) {
  const { data, error } = await db().rpc('append_runner_job_events', {
    p_token_hash: tokenHashFromToken(args.token),
    p_job_id: args.jobId,
    p_events: args.events
  });
  if (error) throw error;
  return data as DurableCapabilityJob;
}

export async function completeRunnerJob(args: {
  token: string | null;
  jobId: string;
  status: Extract<CapabilityJobStatus, 'completed' | 'failed'>;
  computeCostCents?: number;
  platformFeeCents?: number;
  summary: string;
  proof: RunnerProofArtifact[];
  transcript?: Array<{ actor?: string; text: string }>;
}) {
  const runnerJob = await appendRunnerJobEvents({
    token: args.token,
    jobId: args.jobId,
    events: args.transcript?.length
      ? args.transcript.map((event) => ({ actor: event.actor ?? 'agent', text: event.text }))
      : [{ actor: 'agent', text: args.summary }]
  });

  await finalizeCapabilityJob({
    userId: runnerJob.user_id,
    jobId: args.jobId,
    status: args.status,
    computeCostCents: Math.max(0, Math.round(args.computeCostCents ?? 0)),
    platformFeeCents: Math.max(0, Math.round(args.platformFeeCents ?? 0)),
    summary: args.summary,
    proof: args.proof,
    transcript: []
  });

  const { data, error } = await db().from('capability_jobs').select('*').eq('id', args.jobId).single();
  if (error) throw error;
  return data as DurableCapabilityJob & { currency: CreditCurrency };
}
