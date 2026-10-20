-- MARGIN core schema. All money is stored as integer minor units (bigint).
-- Every tenant table carries business_id and is protected by Row Level Security.
set check_function_bodies = off;

-- ───────────────────────── helpers ─────────────────────────
create or replace function public.is_member(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.business_id = b and m.user_id = auth.uid());
$$;

create or replace function public.can_write(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m
    where m.business_id = b and m.user_id = auth.uid() and m.role in ('owner','admin','member'));
$$;

create or replace function public.is_admin(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m
    where m.business_id = b and m.user_id = auth.uid() and m.role in ('owner','admin'));
$$;

-- ───────────────────────── identity ─────────────────────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '',
  locale text not null default 'en',
  theme text not null default 'system' check (theme in ('light','dark','system')),
  created_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  business_type text not null default 'ecommerce',
  country text not null default 'EG',
  currency char(3) not null default 'EGP',
  stage text not null default 'early',
  channels text[] not null default '{}',
  has_history boolean not null default false,
  setup_mode text not null default 'manual' check (setup_mode in ('manual','csv','shopify','demo')),
  is_demo boolean not null default false,
  locale text not null default 'en',
  settings jsonb not null default '{}'::jsonb,
  onboarding jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);

-- ───────────────────────── ledger ─────────────────────────
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  type text not null default 'bank' check (type in ('bank','cash','wallet','card','other')),
  currency char(3) not null,
  opening_balance bigint not null default 0,
  archived boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('income','expense')),
  cost_type text check (cost_type in ('cogs','opex')),
  parent_id uuid,
  color text not null default '#6b7a72',
  essential boolean not null default false,
  role text check (role in ('ads','shipping','inventory','payroll','tax','software','rent')),
  is_system boolean not null default false,
  archived boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, parent_id) references public.categories(business_id, id) on delete set null (parent_id),
  check (kind = 'expense' or cost_type is null)
);

create table public.payees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null default 'supplier' check (kind in ('supplier','customer','contractor','employee','landlord','platform','other')),
  notes text,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  sku text,
  price bigint,
  unit_cost bigint,
  stock int,
  source text not null default 'manual',
  external_id text,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, source, external_id)
);

create table public.recurring (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  direction text not null check (direction in ('in','out')),
  kind text not null default 'other' check (kind in ('rent','utilities','salary','freelancer','subscription','supplier','shipping','tax','other')),
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  category_id uuid,
  account_id uuid,
  payee_id uuid,
  frequency text not null check (frequency in ('weekly','monthly','quarterly','yearly')),
  next_due date not null,
  end_date date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, category_id) references public.categories(business_id, id) on delete set null (category_id),
  foreign key (business_id, account_id) references public.accounts(business_id, id) on delete set null (account_id),
  foreign key (business_id, payee_id) references public.payees(business_id, id) on delete set null (payee_id)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  direction text not null check (direction in ('receivable','payable')),
  payee_id uuid,
  number text,
  description text not null default '',
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  issue_date date not null,
  due_date date not null,
  category_id uuid,
  status text not null default 'open' check (status in ('open','void')),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, category_id) references public.categories(business_id, id) on delete set null (category_id),
  foreign key (business_id, payee_id) references public.payees(business_id, id) on delete set null (payee_id)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  type text not null check (type in ('income','expense','transfer','refund','adjustment')),
  date date not null,
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  account_id uuid not null,
  to_account_id uuid,
  category_id uuid,
  payee_id uuid,
  description text not null default '',
  notes text,
  direction text check (direction in ('in','out')),
  source text not null default 'manual',
  external_id text,
  import_batch_id uuid,
  reconciled boolean not null default false,
  recurring_id uuid,
  invoice_id uuid,
  refund_of uuid,
  cogs_estimate bigint,
  cost_missing boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, account_id) references public.accounts(business_id, id) on delete restrict,
  foreign key (business_id, to_account_id) references public.accounts(business_id, id) on delete restrict,
  foreign key (business_id, category_id) references public.categories(business_id, id) on delete set null (category_id),
  foreign key (business_id, payee_id) references public.payees(business_id, id) on delete set null (payee_id),
  foreign key (business_id, recurring_id) references public.recurring(business_id, id) on delete set null (recurring_id),
  foreign key (business_id, invoice_id) references public.invoices(business_id, id) on delete set null (invoice_id),
  check ((type = 'transfer') = (to_account_id is not null)),
  check (type <> 'transfer' or to_account_id <> account_id),
  check ((type = 'adjustment') = (direction is not null))
);
create index transactions_biz_date_idx on public.transactions(business_id, date desc);
create index transactions_biz_cat_idx on public.transactions(business_id, category_id);
create unique index transactions_external_uidx on public.transactions(business_id, source, external_id) where external_id is not null;

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  invoice_id uuid not null,
  amount bigint not null check (amount > 0),
  paid_on date not null,
  account_id uuid,
  transaction_id uuid,
  created_at timestamptz not null default now(),
  foreign key (business_id, invoice_id) references public.invoices(business_id, id) on delete cascade,
  foreign key (business_id, account_id) references public.accounts(business_id, id) on delete set null (account_id),
  foreign key (business_id, transaction_id) references public.transactions(business_id, id) on delete set null (transaction_id)
);

-- ───────────────────────── planning ─────────────────────────
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category_id uuid not null,
  period text not null default 'monthly' check (period in ('monthly','quarterly','yearly')),
  amount bigint not null check (amount >= 0),
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (business_id, category_id, period),
  foreign key (business_id, category_id) references public.categories(business_id, id) on delete cascade
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  type text not null check (type in ('reserve','revenue','profit','inventory','cash')),
  name text not null,
  target bigint not null default 0 check (target >= 0),
  target_date date,
  mode text not null default 'manual' check (mode in ('manual','essentials')),
  coverage_months int check (coverage_months between 1 and 36),
  period text not null default 'monthly' check (period in ('monthly','quarterly','yearly')),
  position int not null default 0,
  achieved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  goal_id uuid not null,
  amount bigint not null check (amount <> 0),
  made_on date not null,
  note text,
  created_at timestamptz not null default now(),
  foreign key (business_id, goal_id) references public.goals(business_id, id) on delete cascade
);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  kind text not null,
  params jsonb not null,
  result jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.insight_dismissals (
  business_id uuid not null references public.businesses(id) on delete cascade,
  key text not null,
  dismissed_at timestamptz not null default now(),
  primary key (business_id, key)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  dedupe_key text not null,
  severity text not null check (severity in ('info','warning','critical','success')),
  title text not null,
  body text not null,
  href text,
  read_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, dedupe_key)
);

-- ───────────────────────── integrations ─────────────────────────
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('shopify','meta_ads','google_ads')),
  status text not null default 'connecting' check (status in ('connecting','connected','syncing','sync_failed','requires_reauth','disconnected')),
  external_account text,
  display_name text,
  scopes text,
  connected_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  last_error text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (business_id, provider),
  unique (business_id, id)
);

-- Tokens live in their own table. No policy grants clients access: only the server connection reads it.
create table public.integration_secrets (
  integration_id uuid primary key references public.integrations(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  integration_id uuid not null references public.integrations(id) on delete cascade,
  provider text not null,
  status text not null default 'running' check (status in ('running','success','failed')),
  trigger text not null default 'manual',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_imported int not null default 0,
  error text,
  stats jsonb not null default '{}'::jsonb
);

create table public.external_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null,
  kind text not null,
  external_id text not null,
  payload jsonb not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  unique (business_id, provider, kind, external_id)
);

create table public.ad_metrics (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null,
  account_id text,
  campaign_id text not null,
  campaign_name text not null default '',
  date date not null,
  spend bigint not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  conversions numeric not null default 0,
  attributed_revenue bigint not null default 0,
  currency char(3) not null,
  unique (business_id, provider, campaign_id, date)
);
create index ad_metrics_biz_date_idx on public.ad_metrics(business_id, date);

-- Server-only tables (no client policies)
create table public.oauth_states (
  state text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  topic text,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- ───────────────────────── Row Level Security ─────────────────────────
alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.memberships enable row level security;
alter table public.oauth_states enable row level security;
alter table public.webhook_events enable row level security;
alter table public.integration_secrets enable row level security;

create policy profiles_self on public.profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy businesses_select on public.businesses for select to authenticated using (public.is_member(id));
create policy businesses_update on public.businesses for update to authenticated
  using (public.is_admin(id)) with check (public.is_admin(id));
create policy businesses_delete on public.businesses for delete to authenticated
  using (exists (select 1 from public.memberships m where m.business_id = id and m.user_id = auth.uid() and m.role = 'owner'));

create policy memberships_select on public.memberships for select to authenticated using (user_id = auth.uid());

-- Tenant tables: members read; owner/admin/member write.
do $$
declare t text;
begin
  foreach t in array array[
    'accounts','categories','payees','products','recurring','invoices','transactions','invoice_payments',
    'budgets','goals','goal_contributions','scenarios','insight_dismissals','notifications',
    'integrations','sync_runs','external_records','ad_metrics'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(business_id))', t || '_sel', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_write(business_id))', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_write(business_id)) with check (public.can_write(business_id))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_write(business_id))', t || '_del', t);
  end loop;
end $$;

-- Integrations, sync history and raw records are written only by the server connection.
drop policy integrations_ins on public.integrations;
drop policy integrations_upd on public.integrations;
drop policy integrations_del on public.integrations;
drop policy sync_runs_ins on public.sync_runs;
drop policy sync_runs_upd on public.sync_runs;
drop policy sync_runs_del on public.sync_runs;
drop policy external_records_ins on public.external_records;
drop policy external_records_upd on public.external_records;
drop policy external_records_del on public.external_records;
drop policy ad_metrics_ins on public.ad_metrics;
drop policy ad_metrics_upd on public.ad_metrics;
drop policy ad_metrics_del on public.ad_metrics;

-- Grants (Supabase grants broadly by default; be explicit and tight).
revoke all on public.integration_secrets, public.oauth_states, public.webhook_events from anon, authenticated;
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on public.integration_secrets, public.oauth_states, public.webhook_events from authenticated;
revoke insert, update, delete on public.integrations, public.sync_runs, public.external_records, public.ad_metrics from authenticated;
revoke insert, delete on public.memberships from authenticated;
revoke update on public.memberships from authenticated;
