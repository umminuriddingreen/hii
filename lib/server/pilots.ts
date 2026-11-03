import { supabaseAdmin } from './supabase';

export const PILOT_STATUSES = [
  'invited',
  'submitted',
  'booked',
  'accepted',
  'paid',
  'installed',
  'activated'
] as const;

export const PILOT_AGENT_PREFERENCES = ['codex', 'claude-code', 'ollama', 'other'] as const;

export type PilotStatus = (typeof PILOT_STATUSES)[number];
export type PilotAgentPreference = (typeof PILOT_AGENT_PREFERENCES)[number];

export type PilotSubmissionInput = {
  name: string;
  email: string;
  x_profile?: string | null;
  project_summary: string;
  agent_pref?: PilotAgentPreference | null;
  pain?: string | null;
  task_idea?: string | null;
  timeline?: string | null;
  apple_silicon?: boolean | null;
  source?: string | null;
  notes?: string | null;
};

export type Pilot = PilotSubmissionInput & {
  id: string;
  status: PilotStatus;
  created_at: string;
  updated_at: string;
};

function db() {
  const client = supabaseAdmin();
  if (!client) throw new Error('Supabase service role not configured');
  return client;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isPilotStatus(value: string): value is PilotStatus {
  return (PILOT_STATUSES as readonly string[]).includes(value);
}

function isAgentPreference(value: string): value is PilotAgentPreference {
  return (PILOT_AGENT_PREFERENCES as readonly string[]).includes(value);
}

export async function createPilotSubmission(input: PilotSubmissionInput): Promise<void> {
  const name = requiredText(input?.name, 'name');
  const email = requiredText(input?.email, 'email').toLowerCase();
  const projectSummary = requiredText(input?.project_summary, 'project_summary');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('email must be valid');
  }
  if (input.agent_pref != null && !isAgentPreference(input.agent_pref)) {
    throw new Error('invalid agent_pref');
  }
  if (input.apple_silicon != null && typeof input.apple_silicon !== 'boolean') {
    throw new Error('apple_silicon must be a boolean');
  }

  await db().from('pilots').insert({
    name,
    email,
    x_profile: optionalText(input.x_profile),
    project_summary: projectSummary,
    agent_pref: input.agent_pref ?? null,
    pain: optionalText(input.pain),
    task_idea: optionalText(input.task_idea),
    timeline: optionalText(input.timeline),
    apple_silicon: input.apple_silicon ?? null,
    source: optionalText(input.source),
    notes: optionalText(input.notes)
  });
}

export async function listPilots(): Promise<Pilot[]> {
  const { data, error } = await db()
    .from('pilots')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Pilot[];
}

export async function updatePilotStatus(
  id: string,
  status: PilotStatus,
  notes?: string | null
): Promise<void> {
  const pilotId = requiredText(id, 'id');
  if (!isPilotStatus(status)) throw new Error('invalid pilot status');

  const patch: { status: PilotStatus; updated_at: string; notes?: string | null } = {
    status,
    updated_at: new Date().toISOString()
  };
  if (notes !== undefined) patch.notes = optionalText(notes);

  const { error } = await db().from('pilots').update(patch).eq('id', pilotId);
  if (error) throw error;
}
