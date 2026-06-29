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
