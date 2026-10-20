-- Monthly health, to-dos, assets, investments tracking and the boardroom.

create table public.todos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  source text not null default 'manual' check (source in ('compliance','boardroom','manual','system')),
  catalog_key text,
  period text not null default '' ,
  title text not null check (char_length(title) between 1 and 200),
  detail text,
  due_date date,
  status text not null default 'todo' check (status in ('todo','done','skipped')),
  actual_cost bigint check (actual_cost is null or actual_cost >= 0),
  notes text,
  session_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (business_id, id)
);
-- A catalogue requirement appears once per business per period.
create unique index todos_catalog_uidx on public.todos(business_id, catalog_key, period) where catalog_key is not null;
create index todos_biz_due_idx on public.todos(business_id, status, due_date);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  cost bigint not null check (cost > 0),
  purchase_date date not null,
  useful_life_months int not null check (useful_life_months between 1 and 600),
  salvage_value bigint not null default 0 check (salvage_value >= 0),
  fair_value bigint check (fair_value is null or fair_value >= 0),
  disposed_on date,
  created_at timestamptz not null default now(),
  check (salvage_value <= cost)
);

create table public.investments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null default 'other' check (kind in ('savings','deposit','certificate','gold','stocks','fund','real_estate','business','other')),
  invested bigint not null check (invested > 0),
  started_on date not null,
  closed_on date,
  note text,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.investment_marks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  investment_id uuid not null,
  value bigint not null check (value >= 0),
  marked_on date not null,
  created_at timestamptz not null default now(),
  foreign key (business_id, investment_id) references public.investments(business_id, id) on delete cascade
);

create table public.valuation_snapshots (
  business_id uuid not null references public.businesses(id) on delete cascade,
  period text not null,
  low bigint not null,
  mid bigint not null,
  high bigint not null,
  basis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (business_id, period)
);

create table public.boardroom_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  topic text not null check (char_length(topic) between 3 and 600),
  status text not null default 'open' check (status in ('open','running','decided','failed')),
  facts jsonb,
  decision jsonb,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.boardroom_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  session_id uuid not null,
  seq int not null,
  agent text not null,
  kind text not null default 'message' check (kind in ('message','user','system')),
  stance text,
  content text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (business_id, session_id) references public.boardroom_sessions(business_id, id) on delete cascade
);
create index boardroom_messages_session_idx on public.boardroom_messages(session_id, seq);

do $$
declare t text;
begin
  foreach t in array array['todos','assets','investments','investment_marks','valuation_snapshots','boardroom_sessions','boardroom_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(business_id))', t || '_sel', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_write(business_id))', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_write(business_id)) with check (public.can_write(business_id))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_write(business_id))', t || '_del', t);
  end loop;
end $$;

grant select, insert, update, delete on public.todos, public.assets, public.investments, public.investment_marks,
  public.valuation_snapshots, public.boardroom_sessions, public.boardroom_messages to authenticated;
revoke all on public.todos, public.assets, public.investments, public.investment_marks,
  public.valuation_snapshots, public.boardroom_sessions, public.boardroom_messages from anon;
