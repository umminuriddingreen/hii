-- Founder-beta intake. Service-role only: RLS is enabled with no public policies.
create table if not exists public.pilots (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  email           text not null,
  x_profile       text,
  project_summary text not null,
  agent_pref      text check (agent_pref in ('codex', 'claude-code', 'ollama', 'other')),
  pain            text,
  task_idea       text,
  timeline        text,
  apple_silicon   boolean,
  source          text,
  status          text not null default 'submitted'
                  check (status in ('invited', 'submitted', 'booked', 'accepted', 'paid', 'installed', 'activated')),
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.pilots enable row level security;
