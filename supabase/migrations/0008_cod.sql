-- Cash on delivery: money collected by a courier (Bosta, Mylerz, J&T…) and not yet paid out to the business.
-- A COD batch is an ordinary receivable invoice with the courier's name, so the forecast, the calendar and
-- "coming up" count it without any special case. Additive only; existing RLS on invoices covers the new columns.
alter table public.invoices add column if not exists courier text check (courier is null or char_length(courier) between 1 and 40);
alter table public.invoices add column if not exists cod_orders integer check (cod_orders is null or cod_orders between 1 and 100000);
alter table public.invoices add column if not exists cod_fees bigint check (cod_fees is null or cod_fees >= 0);
create index if not exists invoices_courier_idx on public.invoices (business_id, courier) where courier is not null;
