-- Owner's pay: money the owner takes for themselves. It reduces cash but is not a business cost, so profit excludes it.
-- Additive: adds the category to workspaces that do not have one yet; nothing existing is changed.
alter table public.categories drop constraint if exists categories_role_check;
alter table public.categories add constraint categories_role_check check (role in ('ads','shipping','inventory','payroll','tax','software','rent','owner_draw'));

insert into public.categories (business_id, name, kind, cost_type, role, essential, color, is_system, position)
select b.id, 'Owner''s pay', 'expense', null, 'owner_draw', false, '#2f5d7d', true, 999
from public.businesses b
where not exists (select 1 from public.categories c where c.business_id = b.id and c.role = 'owner_draw');
