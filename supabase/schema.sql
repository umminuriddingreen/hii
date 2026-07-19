-- HII exchange spine
-- The primitive: exchange a digital file for value.
--   WHO      → identity   (auth.users + profiles)
--   WHAT     → asset      (file in R2)
--   TERMS    → license    (reusable agreement)
--   VALUE    → exchange_link (asset + terms + price, shareable as /x/[id])
--   TRANSFER → order      (a paid exchange) → signed download
--   PROOF    → download_event (receipt / access record)

-- WHO ----------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email        text,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end; $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- TERMS --------------------------------------------------------------------
create table if not exists public.licenses (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  terms       text not null default '',
  exclusivity text not null default 'non-exclusive', -- non-exclusive | exclusive | lease
  created_at  timestamptz not null default now()
);

-- WHAT ---------------------------------------------------------------------
create table if not exists public.assets (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  description  text,
  r2_key       text not null,
  preview_key  text,
  content_type text not null default 'application/octet-stream',
  file_size    bigint,
  created_at   timestamptz not null default now()
);

-- VALUE (the primitive) ----------------------------------------------------
create table if not exists public.exchange_links (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references auth.users(id) on delete cascade,
  asset_id    uuid not null references public.assets(id) on delete cascade,
  license_id  uuid references public.licenses(id) on delete set null,
  price_cents integer not null check (price_cents >= 0),
  currency    text not null default 'usd',
  active      boolean not null default true,
  views       integer not null default 0,
  created_at  timestamptz not null default now()
);

-- TRANSFER -----------------------------------------------------------------
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  exchange_link_id  uuid references public.exchange_links(id) on delete set null,
  asset_id          uuid not null references public.assets(id) on delete cascade,
  seller_id         uuid not null references auth.users(id) on delete cascade,
  license_id        uuid references public.licenses(id) on delete set null,
  buyer_email       text,
  amount_cents      integer not null,
  currency          text not null default 'usd',
  stripe_session_id text unique,
  status            text not null default 'pending', -- pending | paid | failed
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);

-- PROOF --------------------------------------------------------------------
create table if not exists public.download_events (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid references public.orders(id) on delete set null,
  asset_id      uuid not null references public.assets(id) on delete cascade,
  buyer_email   text,
  ip_hash       text,
  user_agent    text,
  downloaded_at timestamptz not null default now()
);

create index if not exists idx_licenses_seller on public.licenses(seller_id);
create index if not exists idx_assets_seller on public.assets(seller_id);
create index if not exists idx_links_seller on public.exchange_links(seller_id);
create index if not exists idx_links_asset on public.exchange_links(asset_id);
create index if not exists idx_orders_seller on public.orders(seller_id);
create index if not exists idx_orders_link on public.orders(exchange_link_id);
create index if not exists idx_orders_session on public.orders(stripe_session_id);
create index if not exists idx_downloads_asset on public.download_events(asset_id);
create index if not exists idx_downloads_order on public.download_events(order_id);

-- Atomic view counter for exchange links (service-role only).
create or replace function public.increment_link_views(link_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.exchange_links set views = views + 1 where id = link_id;
$$;
revoke execute on function public.increment_link_views(uuid) from public, anon, authenticated;

-- RLS: deny by default. Sellers manage only their own rows.
-- All buyer-facing reads/writes happen server-side via the service-role key,
-- which bypasses RLS — so public exchange pages need no anon policies.
alter table public.profiles        enable row level security;
alter table public.licenses        enable row level security;
alter table public.assets          enable row level security;
alter table public.exchange_links  enable row level security;
alter table public.orders          enable row level security;
alter table public.download_events enable row level security;

drop policy if exists "profiles_select_all" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "licenses_select_own" on public.licenses;
drop policy if exists "licenses_insert_own" on public.licenses;
drop policy if exists "licenses_update_own" on public.licenses;
drop policy if exists "licenses_delete_own" on public.licenses;
drop policy if exists "assets_select_own" on public.assets;
drop policy if exists "assets_insert_own" on public.assets;
drop policy if exists "assets_update_own" on public.assets;
drop policy if exists "assets_delete_own" on public.assets;
drop policy if exists "links_select_own" on public.exchange_links;
drop policy if exists "links_insert_own" on public.exchange_links;
drop policy if exists "links_update_own" on public.exchange_links;
drop policy if exists "links_delete_own" on public.exchange_links;
drop policy if exists "orders_select_own" on public.orders;
drop policy if exists "downloads_select_own" on public.download_events;

create policy "profiles_select_all" on public.profiles for select to anon, authenticated using (true);
create policy "profiles_update_own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "licenses_select_own" on public.licenses for select to authenticated using ((select auth.uid()) = seller_id);
create policy "licenses_insert_own" on public.licenses for insert to authenticated with check ((select auth.uid()) = seller_id);
create policy "licenses_update_own" on public.licenses for update to authenticated using ((select auth.uid()) = seller_id) with check ((select auth.uid()) = seller_id);
create policy "licenses_delete_own" on public.licenses for delete to authenticated using ((select auth.uid()) = seller_id);

create policy "assets_select_own" on public.assets for select to authenticated using ((select auth.uid()) = seller_id);
create policy "assets_insert_own" on public.assets for insert to authenticated with check ((select auth.uid()) = seller_id);
create policy "assets_update_own" on public.assets for update to authenticated using ((select auth.uid()) = seller_id) with check ((select auth.uid()) = seller_id);
create policy "assets_delete_own" on public.assets for delete to authenticated using ((select auth.uid()) = seller_id);

create policy "links_select_own" on public.exchange_links for select to authenticated using ((select auth.uid()) = seller_id);
create policy "links_insert_own" on public.exchange_links for insert to authenticated with check ((select auth.uid()) = seller_id);
create policy "links_update_own" on public.exchange_links for update to authenticated using ((select auth.uid()) = seller_id) with check ((select auth.uid()) = seller_id);
create policy "links_delete_own" on public.exchange_links for delete to authenticated using ((select auth.uid()) = seller_id);

create policy "orders_select_own" on public.orders for select to authenticated using ((select auth.uid()) = seller_id);
create policy "downloads_select_own" on public.download_events for select to authenticated
  using (exists (select 1 from public.assets a where a.id = download_events.asset_id and a.seller_id = (select auth.uid())));

-- HII CREDITS / CAPABILITY JOBS --------------------------------------------
-- Account balances are scoped per user and currency. Credits are internal
-- prepaid balance, not transferable money.

create table if not exists public.credit_accounts (
  user_id        uuid not null references auth.users(id) on delete cascade,
  currency       text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'credits')),
  balance_cents  integer not null default 0 check (balance_cents >= 0),
  reserved_cents integer not null default 0 check (reserved_cents >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, currency),
  check (reserved_cents <= balance_cents)
);

create table if not exists public.capability_jobs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  user_email     text,
  capability_id  text not null,
  input_summary  text not null,
  status         text not null default 'queued'
                 check (status in ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  currency       text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'credits')),
  quote          jsonb,
  reserved_cents integer not null default 0 check (reserved_cents >= 0),
  budget         text,
  metadata       jsonb not null default '{}'::jsonb,
  runner_id      uuid,
  assigned_at    timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.capability_runners (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  status        text not null default 'offline' check (status in ('online', 'offline', 'draining')),
  capabilities  text[] not null default '{}'::text[],
  last_seen_at  timestamptz,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.capability_jobs
  add column if not exists runner_id uuid,
  add column if not exists assigned_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'capability_jobs_runner_id_fkey'
  ) then
    alter table public.capability_jobs
      add constraint capability_jobs_runner_id_fkey
      foreign key (runner_id) references public.capability_runners(id) on delete set null;
  end if;
end $$;

create table if not exists public.credit_ledger_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  job_id        uuid references public.capability_jobs(id) on delete set null,
  capability_id text,
  actor         text not null default 'hii'
                check (actor in ('hii', 'operator', 'agent', 'stripe', 'system')),
  type          text not null
                check (type in ('credit_topup', 'quote', 'reservation', 'approval', 'compute_cost', 'platform_fee', 'proof', 'refund')),
  amount_cents  integer,
  currency      text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'credits')),
  external_id   text unique,
  summary       text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.task_transcript_events (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.capability_jobs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  actor      text not null check (actor in ('user', 'hii', 'agent', 'ledger', 'operator', 'system')),
  text       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.proof_artifacts (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.capability_jobs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('log', 'screenshot', 'download', 'receipt', 'link', 'json')),
  label      text not null,
  href       text,
  path       text,
  summary    text,
  created_at timestamptz not null default now()
);

create index if not exists idx_credit_ledger_user on public.credit_ledger_entries(user_id, created_at desc);
create index if not exists idx_credit_ledger_job on public.credit_ledger_entries(job_id);
create index if not exists idx_capability_jobs_user on public.capability_jobs(user_id, created_at desc);
create index if not exists idx_capability_jobs_runner_queue on public.capability_jobs(status, runner_id, created_at asc);
create index if not exists idx_transcript_events_job on public.task_transcript_events(job_id, created_at asc);
create index if not exists idx_proof_artifacts_job on public.proof_artifacts(job_id, created_at asc);
create index if not exists idx_capability_runners_token_hash on public.capability_runners(token_hash);

alter table public.credit_accounts         enable row level security;
alter table public.credit_ledger_entries   enable row level security;
alter table public.capability_jobs         enable row level security;
alter table public.capability_runners      enable row level security;
alter table public.task_transcript_events  enable row level security;
alter table public.proof_artifacts         enable row level security;

grant select on public.credit_accounts to authenticated;
grant select on public.credit_ledger_entries to authenticated;
grant select, insert on public.capability_jobs to authenticated;
grant select, insert on public.task_transcript_events to authenticated;
grant select on public.proof_artifacts to authenticated;

drop policy if exists "credit_accounts_select_own" on public.credit_accounts;
drop policy if exists "credit_ledger_select_own" on public.credit_ledger_entries;
drop policy if exists "capability_jobs_select_own" on public.capability_jobs;
drop policy if exists "capability_jobs_insert_own" on public.capability_jobs;
drop policy if exists "task_transcript_events_select_own" on public.task_transcript_events;
drop policy if exists "task_transcript_events_insert_own" on public.task_transcript_events;
drop policy if exists "proof_artifacts_select_own" on public.proof_artifacts;

create policy "credit_accounts_select_own" on public.credit_accounts for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "credit_ledger_select_own" on public.credit_ledger_entries for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "capability_jobs_select_own" on public.capability_jobs for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "capability_jobs_insert_own" on public.capability_jobs for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "task_transcript_events_select_own" on public.task_transcript_events for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "task_transcript_events_insert_own" on public.task_transcript_events for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "proof_artifacts_select_own" on public.proof_artifacts for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.apply_credit_topup(
  target_user_id uuid,
  p_currency text,
  p_amount_cents integer,
  p_external_id text,
  p_summary text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  inserted_count integer;
begin
  if p_amount_cents <= 0 then
    raise exception 'credit top-up amount must be positive';
  end if;

  insert into public.credit_accounts (user_id, currency)
  values (target_user_id, p_currency)
  on conflict (user_id, currency) do nothing;

  insert into public.credit_ledger_entries (
    user_id, actor, type, amount_cents, currency, external_id, summary
  )
  values (
    target_user_id, 'stripe', 'credit_topup', p_amount_cents, p_currency, p_external_id, p_summary
  )
  on conflict (external_id) do nothing;

  get diagnostics inserted_count = row_count;

  if inserted_count > 0 then
    update public.credit_accounts
    set balance_cents = balance_cents + p_amount_cents,
        updated_at = now()
    where user_id = target_user_id and currency = p_currency;
  end if;
end;
$$;
revoke execute on function public.apply_credit_topup(uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.apply_credit_topup(uuid, text, integer, text, text) to service_role;

create or replace function public.reserve_capability_job(
  target_user_id uuid,
  p_user_email text,
  p_capability_id text,
  p_input_summary text,
  p_currency text,
  p_quote jsonb,
  p_reserved_cents integer,
  p_status text,
  p_budget text,
  p_metadata jsonb,
  p_transcript jsonb
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  account_balance integer;
  account_reserved integer;
  new_job_id uuid;
  transcript_event jsonb;
begin
  if p_reserved_cents <= 0 then
    raise exception 'reserved amount must be positive';
  end if;

  insert into public.credit_accounts (user_id, currency)
  values (target_user_id, p_currency)
  on conflict (user_id, currency) do nothing;

  select balance_cents, reserved_cents into account_balance, account_reserved
  from public.credit_accounts
  where user_id = target_user_id and currency = p_currency
  for update;

  if account_balance - account_reserved < p_reserved_cents then
    raise exception 'insufficient credit balance';
  end if;

  update public.credit_accounts
  set reserved_cents = reserved_cents + p_reserved_cents,
      updated_at = now()
  where user_id = target_user_id and currency = p_currency;

  insert into public.capability_jobs (
    user_id, user_email, capability_id, input_summary, status, currency, quote,
    reserved_cents, budget, metadata
  )
  values (
    target_user_id, p_user_email, p_capability_id, p_input_summary, p_status, p_currency, p_quote,
    p_reserved_cents, p_budget, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into new_job_id;

  insert into public.credit_ledger_entries (
    user_id, job_id, capability_id, actor, type, amount_cents, currency, summary
  )
  values
    (target_user_id, new_job_id, p_capability_id, 'hii', 'quote', null, p_currency, 'Created quoted HII capability job.'),
    (target_user_id, new_job_id, p_capability_id, 'hii', 'reservation', p_reserved_cents, p_currency, 'Reserved credits for approved task execution.');

  insert into public.proof_artifacts (job_id, user_id, kind, label, summary)
  values (
    new_job_id,
    target_user_id,
    'receipt',
    'Queued capability receipt',
    'HII reserved credits and created a durable capability job with ledger rows.'
  );

  if jsonb_typeof(p_transcript) = 'array' then
    for transcript_event in select * from jsonb_array_elements(p_transcript)
    loop
      insert into public.task_transcript_events (job_id, user_id, actor, text)
      values (
        new_job_id,
        target_user_id,
        coalesce(transcript_event->>'actor', 'hii'),
        coalesce(transcript_event->>'text', '')
      );
    end loop;
  end if;

  return new_job_id;
end;
$$;
revoke execute on function public.reserve_capability_job(uuid, text, text, text, text, jsonb, integer, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_capability_job(uuid, text, text, text, text, jsonb, integer, text, text, jsonb, jsonb) to service_role;

create or replace function public.register_capability_runner(
  p_name text,
  p_token_hash text,
  p_capabilities text[]
)
returns public.capability_runners language plpgsql security definer set search_path = public as $$
declare
  runner_record public.capability_runners%rowtype;
begin
  insert into public.capability_runners (name, status, capabilities, last_seen_at, token_hash)
  values (p_name, 'online', coalesce(p_capabilities, '{}'::text[]), now(), p_token_hash)
  returning * into runner_record;

  return runner_record;
end;
$$;
revoke execute on function public.register_capability_runner(text, text, text[]) from public, anon, authenticated;
grant execute on function public.register_capability_runner(text, text, text[]) to service_role;

create or replace function public.runner_heartbeat(
  p_token_hash text,
  p_capabilities text[]
)
returns public.capability_runners language plpgsql security definer set search_path = public as $$
declare
  runner_record public.capability_runners%rowtype;
begin
  update public.capability_runners
  set status = 'online',
      capabilities = coalesce(p_capabilities, capabilities),
      last_seen_at = now(),
      updated_at = now()
  where token_hash = p_token_hash
  returning * into runner_record;

  if not found then
    raise exception 'invalid runner token';
  end if;

  return runner_record;
end;
$$;
revoke execute on function public.runner_heartbeat(text, text[]) from public, anon, authenticated;
grant execute on function public.runner_heartbeat(text, text[]) to service_role;

create or replace function public.claim_next_runner_job(
  p_token_hash text,
  p_capabilities text[]
)
returns public.capability_jobs language plpgsql security definer set search_path = public as $$
declare
  runner_record public.capability_runners%rowtype;
  job_record public.capability_jobs%rowtype;
begin
  select * into runner_record
  from public.capability_runners
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'invalid runner token';
  end if;

  update public.capability_runners
  set status = 'online',
      capabilities = coalesce(p_capabilities, capabilities),
      last_seen_at = now(),
      updated_at = now()
  where id = runner_record.id
  returning * into runner_record;

  select * into job_record
  from public.capability_jobs
  where status = 'queued'
    and runner_id is null
    and capability_id = any(runner_record.capabilities)
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.capability_jobs
  set runner_id = runner_record.id,
      assigned_at = now(),
      updated_at = now(),
      metadata = metadata || jsonb_build_object('runnerName', runner_record.name)
  where id = job_record.id
  returning * into job_record;

  return job_record;
end;
$$;
revoke execute on function public.claim_next_runner_job(text, text[]) from public, anon, authenticated;
grant execute on function public.claim_next_runner_job(text, text[]) to service_role;

create or replace function public.append_runner_job_events(
  p_token_hash text,
  p_job_id uuid,
  p_events jsonb
)
returns public.capability_jobs language plpgsql security definer set search_path = public as $$
declare
  runner_record public.capability_runners%rowtype;
  job_record public.capability_jobs%rowtype;
  transcript_event jsonb;
begin
  select * into runner_record from public.capability_runners where token_hash = p_token_hash;
  if not found then
    raise exception 'invalid runner token';
  end if;

  select * into job_record
  from public.capability_jobs
  where id = p_job_id and runner_id = runner_record.id
  for update;

  if not found then
    raise exception 'runner cannot update this job';
  end if;

  update public.capability_jobs
  set status = 'running',
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = p_job_id
  returning * into job_record;

  if jsonb_typeof(p_events) = 'array' then
    for transcript_event in select * from jsonb_array_elements(p_events)
    loop
      insert into public.task_transcript_events (job_id, user_id, actor, text)
      values (
        p_job_id,
        job_record.user_id,
        coalesce(transcript_event->>'actor', 'agent'),
        coalesce(transcript_event->>'text', '')
      );
    end loop;
  end if;

  return job_record;
end;
$$;
revoke execute on function public.append_runner_job_events(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_runner_job_events(text, uuid, jsonb) to service_role;

create or replace function public.finalize_capability_job(
  target_user_id uuid,
  p_job_id uuid,
  p_status text,
  p_compute_cost_cents integer,
  p_platform_fee_cents integer,
  p_summary text,
  p_proof jsonb,
  p_transcript jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare
  job_record public.capability_jobs%rowtype;
  actual_cents integer;
  unused_cents integer;
  proof_event jsonb;
  transcript_event jsonb;
begin
  select * into job_record
  from public.capability_jobs
  where id = p_job_id and user_id = target_user_id
  for update;

  if not found then
    raise exception 'capability job not found';
  end if;

  if job_record.status in ('completed', 'failed', 'cancelled') then
    return;
  end if;

  actual_cents = greatest(coalesce(p_compute_cost_cents, 0), 0) + greatest(coalesce(p_platform_fee_cents, 0), 0);

  if actual_cents > job_record.reserved_cents then
    raise exception 'final cost exceeds reserved credits';
  end if;

  if job_record.runner_id is not null
     and p_status = 'completed'
     and coalesce(jsonb_array_length(p_proof), 0) < 1 then
    raise exception 'completed runner jobs require at least one proof artifact';
  end if;

  unused_cents = job_record.reserved_cents - actual_cents;

  update public.credit_accounts
  set balance_cents = balance_cents - actual_cents,
      reserved_cents = reserved_cents - job_record.reserved_cents,
      updated_at = now()
  where user_id = target_user_id and currency = job_record.currency;

  update public.capability_jobs
  set status = p_status,
      completed_at = case when p_status in ('completed', 'failed', 'cancelled') then now() else completed_at end,
      updated_at = now()
  where id = p_job_id;

  if p_compute_cost_cents > 0 then
    insert into public.credit_ledger_entries (
      user_id, job_id, capability_id, actor, type, amount_cents, currency, summary
    )
    values (
      target_user_id, p_job_id, job_record.capability_id, 'system', 'compute_cost',
      -p_compute_cost_cents, job_record.currency, 'Computer and model reimbursement.'
    );
  end if;

  if p_platform_fee_cents > 0 then
    insert into public.credit_ledger_entries (
      user_id, job_id, capability_id, actor, type, amount_cents, currency, summary
    )
    values (
      target_user_id, p_job_id, job_record.capability_id, 'hii', 'platform_fee',
      -p_platform_fee_cents, job_record.currency, 'HII coordination fee.'
    );
  end if;

  if unused_cents > 0 then
    insert into public.credit_ledger_entries (
      user_id, job_id, capability_id, actor, type, amount_cents, currency, summary
    )
    values (
      target_user_id, p_job_id, job_record.capability_id, 'hii', 'refund',
      unused_cents, job_record.currency, 'Released unused reserved credits.'
    );
  end if;

  insert into public.credit_ledger_entries (
    user_id, job_id, capability_id, actor, type, amount_cents, currency, summary
  )
  values (
    target_user_id, p_job_id, job_record.capability_id, 'hii', 'proof',
    null, job_record.currency, coalesce(p_summary, 'Capability job finalized with proof.')
  );

  if jsonb_typeof(p_proof) = 'array' then
    for proof_event in select * from jsonb_array_elements(p_proof)
    loop
      insert into public.proof_artifacts (job_id, user_id, kind, label, href, path, summary)
      values (
        p_job_id,
        target_user_id,
        coalesce(proof_event->>'kind', 'receipt'),
        coalesce(proof_event->>'label', 'Proof artifact'),
        proof_event->>'href',
        proof_event->>'path',
        proof_event->>'summary'
      );
    end loop;
  end if;

  if jsonb_typeof(p_transcript) = 'array' then
    for transcript_event in select * from jsonb_array_elements(p_transcript)
    loop
      insert into public.task_transcript_events (job_id, user_id, actor, text)
      values (
        p_job_id,
        target_user_id,
        coalesce(transcript_event->>'actor', 'hii'),
        coalesce(transcript_event->>'text', '')
      );
    end loop;
  end if;
end;
$$;
revoke execute on function public.finalize_capability_job(uuid, uuid, text, integer, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_capability_job(uuid, uuid, text, integer, integer, text, jsonb, jsonb) to service_role;

-- HII SOCIAL / MEDIA FEED --------------------------------------------------
-- The social layer sits on top of creator-owned assets and exchange links.
-- Boards can hold uploaded assets now and browser-saved media/source captures
-- later without changing the payment/download primitive.

alter table public.profiles
  add column if not exists handle text unique,
  add column if not exists bio text,
  add column if not exists avatar_url text;

create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  slug        text not null,
  description text,
  visibility  text not null default 'connected' check (visibility in ('connected', 'public', 'unlisted', 'private')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, slug)
);

create table if not exists public.board_items (
  id               uuid primary key default gen_random_uuid(),
  board_id         uuid not null references public.boards(id) on delete cascade,
  asset_id         uuid references public.assets(id) on delete cascade,
  exchange_link_id uuid references public.exchange_links(id) on delete set null,
  source_url       text,
  source_title     text,
  note             text,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  check (asset_id is not null or source_url is not null)
);

create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, profile_id),
  check (follower_id <> profile_id)
);

create table if not exists public.connections (
  requester_id uuid not null references auth.users(id) on delete cascade,
  receiver_id  uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (requester_id, receiver_id),
  check (requester_id <> receiver_id)
);

create table if not exists public.feed_reactions (
  user_id          uuid not null references auth.users(id) on delete cascade,
  exchange_link_id uuid not null references public.exchange_links(id) on delete cascade,
  kind             text not null default 'save' check (kind in ('save', 'like', 'repost')),
  created_at       timestamptz not null default now(),
  primary key (user_id, exchange_link_id, kind)
);

create index if not exists idx_boards_owner on public.boards(owner_id, created_at desc);
create index if not exists idx_boards_public on public.boards(visibility, created_at desc);
create index if not exists idx_board_items_board on public.board_items(board_id, position asc, created_at asc);
create index if not exists idx_board_items_asset on public.board_items(asset_id);
create index if not exists idx_follows_profile on public.follows(profile_id, created_at desc);
create index if not exists idx_connections_receiver on public.connections(receiver_id, status, created_at desc);
create index if not exists idx_feed_reactions_link on public.feed_reactions(exchange_link_id, kind);

alter table public.boards         enable row level security;
alter table public.board_items    enable row level security;
alter table public.follows        enable row level security;
alter table public.connections    enable row level security;
alter table public.feed_reactions enable row level security;

grant select on public.boards to anon, authenticated;
grant select on public.board_items to anon, authenticated;
grant select, insert, delete on public.follows to authenticated;
grant select, insert, update, delete on public.connections to authenticated;
grant select, insert, delete on public.feed_reactions to authenticated;
grant insert, update, delete on public.boards to authenticated;
grant insert, update, delete on public.board_items to authenticated;

drop policy if exists "boards_select_visible" on public.boards;
drop policy if exists "boards_insert_own" on public.boards;
drop policy if exists "boards_update_own" on public.boards;
drop policy if exists "boards_delete_own" on public.boards;
drop policy if exists "board_items_select_visible" on public.board_items;
drop policy if exists "board_items_insert_own_board" on public.board_items;
drop policy if exists "board_items_update_own_board" on public.board_items;
drop policy if exists "board_items_delete_own_board" on public.board_items;
drop policy if exists "follows_select_all" on public.follows;
drop policy if exists "follows_insert_own" on public.follows;
drop policy if exists "follows_delete_own" on public.follows;
drop policy if exists "connections_select_involved" on public.connections;
drop policy if exists "connections_insert_own_request" on public.connections;
drop policy if exists "connections_update_receiver_or_requester" on public.connections;
drop policy if exists "connections_delete_involved" on public.connections;
drop policy if exists "feed_reactions_select_all" on public.feed_reactions;
drop policy if exists "feed_reactions_insert_own" on public.feed_reactions;
drop policy if exists "feed_reactions_delete_own" on public.feed_reactions;

create policy "boards_select_visible" on public.boards for select to anon, authenticated
  using (
    visibility in ('public', 'unlisted')
    or (select auth.uid()) = owner_id
    or (
      visibility = 'connected'
      and exists (
        select 1 from public.connections c
        where c.status = 'accepted'
          and (
            (c.requester_id = (select auth.uid()) and c.receiver_id = boards.owner_id)
            or (c.receiver_id = (select auth.uid()) and c.requester_id = boards.owner_id)
          )
      )
    )
  );
create policy "boards_insert_own" on public.boards for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "boards_update_own" on public.boards for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "boards_delete_own" on public.boards for delete to authenticated
  using ((select auth.uid()) = owner_id);

create policy "board_items_select_visible" on public.board_items for select to anon, authenticated
  using (exists (
    select 1 from public.boards b
    where b.id = board_items.board_id
      and (
        b.visibility in ('public', 'unlisted')
        or b.owner_id = (select auth.uid())
        or (
          b.visibility = 'connected'
          and exists (
            select 1 from public.connections c
            where c.status = 'accepted'
              and (
                (c.requester_id = (select auth.uid()) and c.receiver_id = b.owner_id)
                or (c.receiver_id = (select auth.uid()) and c.requester_id = b.owner_id)
              )
          )
        )
      )
  ));
create policy "board_items_insert_own_board" on public.board_items for insert to authenticated
  with check (exists (
    select 1 from public.boards b
    where b.id = board_items.board_id and b.owner_id = (select auth.uid())
  ));
create policy "board_items_update_own_board" on public.board_items for update to authenticated
  using (exists (
    select 1 from public.boards b
    where b.id = board_items.board_id and b.owner_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.boards b
    where b.id = board_items.board_id and b.owner_id = (select auth.uid())
  ));
create policy "board_items_delete_own_board" on public.board_items for delete to authenticated
  using (exists (
    select 1 from public.boards b
    where b.id = board_items.board_id and b.owner_id = (select auth.uid())
  ));

create policy "follows_select_all" on public.follows for select to authenticated using (true);
create policy "follows_insert_own" on public.follows for insert to authenticated
  with check ((select auth.uid()) = follower_id);
create policy "follows_delete_own" on public.follows for delete to authenticated
  using ((select auth.uid()) = follower_id);

create policy "connections_select_involved" on public.connections for select to authenticated
  using ((select auth.uid()) in (requester_id, receiver_id));
create policy "connections_insert_own_request" on public.connections for insert to authenticated
  with check ((select auth.uid()) = requester_id);
create policy "connections_update_receiver_or_requester" on public.connections for update to authenticated
  using ((select auth.uid()) in (requester_id, receiver_id))
  with check ((select auth.uid()) in (requester_id, receiver_id));
create policy "connections_delete_involved" on public.connections for delete to authenticated
  using ((select auth.uid()) in (requester_id, receiver_id));

create policy "feed_reactions_select_all" on public.feed_reactions for select to authenticated using (true);
create policy "feed_reactions_insert_own" on public.feed_reactions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "feed_reactions_delete_own" on public.feed_reactions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Public link stream (published from the local HII link loop; read-only to the web)
create table if not exists public.link_posts (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  title text not null default '',
  note text not null default '',
  tags text[] not null default '{}',
  source text not null default 'manual',
  summary text,
  created_at timestamptz not null default now()
);

create index if not exists idx_link_posts_created on public.link_posts(created_at desc);

alter table public.link_posts enable row level security;

grant select on public.link_posts to anon, authenticated;

drop policy if exists "link_posts_select_all" on public.link_posts;
create policy "link_posts_select_all" on public.link_posts for select to anon, authenticated using (true);

-- FOUNDER-BETA PILOT INTAKE ------------------------------------------------
-- Service-role only: RLS is enabled with no anon or authenticated policies.
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
  status          text not null default 'submitted' check (status in ('invited', 'submitted', 'booked', 'accepted', 'paid', 'installed', 'activated')),
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.pilots enable row level security;
