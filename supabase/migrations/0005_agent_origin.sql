-- Actions and audit entries proposed by the AI agent are recorded as such (same policy, same approvals).
alter table public.actions drop constraint if exists actions_origin_check;
alter table public.actions add constraint actions_origin_check check (origin in ('system','user','agent'));
alter table public.audit_log drop constraint if exists audit_log_actor_type_check;
alter table public.audit_log add constraint audit_log_actor_type_check check (actor_type in ('user','system','agent'));
