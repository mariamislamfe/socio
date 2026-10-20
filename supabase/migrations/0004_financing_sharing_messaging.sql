-- Financing offers, owner-approved share links for lender packs, and outbound message delivery log.
-- Additive only: no existing data is changed.

/* ───────── financing offers the owner received (or demo offers, clearly labelled) ───────── */
create table public.financing_offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  lender text not null,
  kind text not null check (kind in ('supplier_credit','invoice_financing','overdraft','term_loan','revenue_advance','owner_funds','other')),
  amount bigint not null check (amount > 0),
  upfront_fee bigint not null default 0 check (upfront_fee >= 0),
  rate_pct numeric(7,3) check (rate_pct is null or (rate_pct >= 0 and rate_pct <= 1000)),
  flat_fee bigint check (flat_fee is null or flat_fee >= 0),
  term_days int not null check (term_days between 1 and 3650),
  repayment text not null check (repayment in ('bullet','monthly','weekly','daily_sales')),
  revenue_share_pct numeric(5,2) check (revenue_share_pct is null or (revenue_share_pct > 0 and revenue_share_pct <= 100)),
  flags jsonb not null default '{}'::jsonb,
  notes text,
  source text not null default 'user' check (source in ('user','demo')),
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

/* ───────── share links: read-only, expiring, revocable, created only through an approved action ───────── */
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  token_hash text not null unique,          -- sha256 of the token; the token itself is never stored
  scope text not null check (scope in ('lender_pack')),
  payload jsonb not null,                    -- frozen copy of what is shared
  fingerprint text not null,                 -- sha256 of the payload, shown on the shared page
  recipient text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  views int not null default 0,
  last_viewed_at timestamptz,
  action_id uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index share_links_biz_idx on public.share_links(business_id, created_at desc);

/* ───────── outbound messages (daily briefing on WhatsApp, etc.) ───────── */
create table public.message_deliveries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null check (channel in ('whatsapp')),
  kind text not null,
  to_masked text not null,                   -- never the full number
  status text not null check (status in ('sent','failed','skipped')),
  provider_message_id text,
  error text,
  preview text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (business_id, dedupe_key)
);

/* ───────── RLS ───────── */
alter table public.financing_offers enable row level security;
create policy financing_offers_sel on public.financing_offers for select to authenticated using (public.is_member(business_id));
create policy financing_offers_ins on public.financing_offers for insert to authenticated with check (public.can_write(business_id));
create policy financing_offers_upd on public.financing_offers for update to authenticated using (public.can_write(business_id)) with check (public.can_write(business_id));
create policy financing_offers_del on public.financing_offers for delete to authenticated using (public.can_write(business_id));
grant select, insert, update, delete on public.financing_offers to authenticated;
revoke all on public.financing_offers from anon;

-- Share links and deliveries are written only by the server (after policy checks); members can see them.
alter table public.share_links enable row level security;
create policy share_links_sel on public.share_links for select to authenticated using (public.is_member(business_id));
alter table public.message_deliveries enable row level security;
create policy message_deliveries_sel on public.message_deliveries for select to authenticated using (public.is_member(business_id));
grant select on public.share_links, public.message_deliveries to authenticated;
revoke all on public.share_links, public.message_deliveries from anon;
