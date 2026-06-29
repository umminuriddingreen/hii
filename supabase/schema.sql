-- hii v1 schema
-- Identity = producer (Supabase auth.users)
-- Information = track (file in R2)
-- Exchange = license + purchase + download_event

-- TRACKS: one uploaded audio file offered for sale
create table if not exists public.tracks (
  id            uuid primary key default gen_random_uuid(),
  producer_id   uuid references auth.users(id) on delete cascade,
  title         text not null,
  price_cents   integer not null check (price_cents >= 0),
  currency      text not null default 'usd',
  license       text not null default 'non-exclusive',
  r2_key        text not null,                 -- object key in R2 bucket
  preview_key   text,                          -- optional clip key (later)
  content_type  text not null default 'audio/mpeg',
  created_at    timestamptz not null default now()
);

-- PURCHASES: a payment intent for a track
create table if not exists public.purchases (
  id                  uuid primary key default gen_random_uuid(),
  track_id            uuid not null references public.tracks(id) on delete cascade,
  buyer_email         text,
  amount_cents        integer not null,
  currency            text not null default 'usd',
  stripe_session_id   text unique,
  status              text not null default 'pending',  -- pending | paid | failed
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);

-- DOWNLOAD_EVENTS: one row each time a paid signed URL is minted
create table if not exists public.download_events (
  id           uuid primary key default gen_random_uuid(),
  track_id     uuid not null references public.tracks(id) on delete cascade,
  purchase_id  uuid references public.purchases(id) on delete set null,
  ip           text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_tracks_producer on public.tracks(producer_id);
create index if not exists idx_purchases_track on public.purchases(track_id);
create index if not exists idx_downloads_track on public.download_events(track_id);
