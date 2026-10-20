-- Business operating system: timezones, cash semantics, normalized orders, durable events/jobs,
-- recommendations, policy-governed actions, audit trail, predictions vs outcomes, daily briefings.
-- Additive only: no existing data is modified or removed.

alter table public.businesses add column if not exists timezone text not null default 'Africa/Cairo';
-- Accounts that hold money you can actually spend. A Shopify balance awaiting payout is NOT cash yet.
alter table public.accounts add column if not exists counts_as_cash boolean not null default true;

/* ───────── normalized commerce orders (separate from the ledger) ───────── */
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null default 'shopify',
  external_id text not null,
  name text not null default '',
  placed_at timestamptz not null,
  local_date date not null,
  updated_at_provider timestamptz,
  cancelled_at timestamptz,
  financial_status text,
  fulfillment_status text,
  currency char(3) not null,
  subtotal bigint not null default 0,
  discounts bigint not null default 0,
  shipping bigint not null default 0,
  tax bigint not null default 0,
  total bigint not null default 0,
  refunded bigint not null default 0,
  is_test boolean not null default false,
  source text not null default 'shopify',
  created_at timestamptz not null default now(),
  unique (business_id, provider, external_id),
  unique (business_id, id)
);
create index orders_biz_date_idx on public.orders(business_id, local_date desc);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id uuid not null,
  external_id text not null,
  variant_external_id text,
  title text not null default '',
  sku text,
  quantity int not null default 0,
  current_quantity int not null default 0,
  unit_price bigint not null default 0,
  discounted_total bigint not null default 0,
  unit_cost bigint,
  foreign key (business_id, order_id) references public.orders(business_id, id) on delete cascade,
  unique (business_id, order_id, external_id)
);
create index order_lines_variant_idx on public.order_lines(business_id, variant_external_id);

/* ───────── durable events and jobs ───────── */
create table public.events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  source text not null,
  type text not null,
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  schema_version int not null default 1,
  entity_id text,
  correlation_id uuid not null default gen_random_uuid(),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  unique (idempotency_key)
);
create index events_biz_time_idx on public.events(business_id, received_at desc);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','succeeded','dead','cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  idempotency_key text,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index jobs_idem_uidx on public.jobs(idempotency_key) where idempotency_key is not null;
create index jobs_due_idx on public.jobs(status, run_after);
create index jobs_biz_idx on public.jobs(business_id, created_at desc);

/* ───────── brain: recommendations, actions, audit, predictions, briefings ───────── */
create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  severity text not null default 'warning' check (severity in ('info','warning','critical')),
  title text not null,
  summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  options jsonb not null default '[]'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (business_id, dedupe_key),
  unique (business_id, id)
);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  recommendation_id uuid,
  tool text not null,
  params jsonb not null,
  params_hash text not null,
  risk_level int not null check (risk_level between 1 and 3),
  summary text not null,
  status text not null check (status in ('awaiting_approval','approved','executing','succeeded','failed','rejected','cancelled')),
  requires_approval boolean not null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approved_hash text,
  executed_at timestamptz,
  result jsonb,
  verification jsonb,
  error text,
  origin text not null default 'system' check (origin in ('system','user')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (idempotency_key),
  foreign key (business_id, recommendation_id) references public.recommendations(business_id, id) on delete set null (recommendation_id)
);
create index actions_biz_idx on public.actions(business_id, created_at desc);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','system')),
  actor_id uuid,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_biz_idx on public.audit_log(business_id, created_at desc);

create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  recommendation_id uuid,
  action_id uuid,
  metric text not null,
  made_on date not null,
  target_date date not null,
  predicted bigint not null,
  actual bigint,
  measured_at timestamptz,
  data_quality text,
  note text,
  created_at timestamptz not null default now(),
  unique (business_id, metric, made_on, target_date)
);

create table public.briefings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  local_date date not null,
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (business_id, local_date)
);

create table public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  to_name text not null default '',
  to_email text,
  subject text not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft','sent','discarded')),
  provider_message_id text,
  action_id uuid,
  created_at timestamptz not null default now()
);

/* ───────── RLS: members can read; only the server writes system-owned tables ───────── */
do $$
declare t text;
begin
  foreach t in array array['orders','order_lines','recommendations','actions','audit_log','predictions','briefings','email_drafts','jobs','events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (business_id is not null and public.is_member(business_id))', t || '_sel', t);
  end loop;
end $$;

-- Drafts can be edited/discarded by members who can write.
create policy email_drafts_upd on public.email_drafts for update to authenticated using (public.can_write(business_id)) with check (public.can_write(business_id));

grant select on public.orders, public.order_lines, public.recommendations, public.actions, public.audit_log,
  public.predictions, public.briefings, public.email_drafts, public.jobs, public.events to authenticated;
grant update on public.email_drafts to authenticated;
revoke all on public.orders, public.order_lines, public.recommendations, public.actions, public.audit_log,
  public.predictions, public.briefings, public.email_drafts, public.jobs, public.events from anon;

-- Existing Shopify ledger accounts hold a balance awaiting payout, not spendable cash.
update public.accounts set counts_as_cash = false where name like 'Shopify sales%' and type in ('wallet','other');

-- Optional contact email for suppliers/customers (used only for reminders the owner allows).
alter table public.payees add column if not exists email text;
