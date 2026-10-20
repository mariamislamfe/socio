-- Media buyer: ad campaigns planned with the owner (final ad approved by them), launched and monitored on Meta.
-- Additive only.

create table public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  platform text not null default 'meta' check (platform in ('meta')),
  status text not null default 'draft' check (status in ('draft','awaiting_approval','created','activating','active','paused','completed','failed')),
  brief jsonb not null,        -- what the owner asked for: budget, days, country, dialect, goal, link
  plan jsonb not null,         -- affordability, product, max cost per order, expected results, targeting (handled by the co-pilot)
  creative jsonb not null,     -- what people will see: primary text, headline, call to action, image (approved by the owner)
  external jsonb not null default '{}'::jsonb, -- Meta ids (campaign, ad set, creative, ad)
  metrics jsonb,               -- last monitoring snapshot
  last_checked_at timestamptz,
  error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);
create index ad_campaigns_biz_idx on public.ad_campaigns(business_id, created_at desc);

-- The owner's own edits to ad copy, used as style examples so future ads sound like them.
create table public.ad_copy_examples (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  dialect text not null,
  text text not null,
  created_at timestamptz not null default now()
);
create index ad_copy_examples_idx on public.ad_copy_examples(business_id, dialect, created_at desc);

alter table public.ad_campaigns enable row level security;
create policy ad_campaigns_sel on public.ad_campaigns for select to authenticated using (public.is_member(business_id));
alter table public.ad_copy_examples enable row level security;
create policy ad_copy_examples_sel on public.ad_copy_examples for select to authenticated using (public.is_member(business_id));
grant select on public.ad_campaigns, public.ad_copy_examples to authenticated;
revoke all on public.ad_campaigns, public.ad_copy_examples from anon;
