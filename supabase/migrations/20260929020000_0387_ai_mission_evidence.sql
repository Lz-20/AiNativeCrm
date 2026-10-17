-- 0387 — preserve human resolution evidence and append-only mission transitions.
-- A model run cannot prove a business outcome; a human attestation is explicit.
alter table public.ai_missions
  add column if not exists resolution_reason text,
  add column if not exists resolved_by_user_id uuid references auth.users(id) on delete set null;

create table if not exists public.ai_mission_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  mission_id uuid not null,
  event_type text not null check (event_type in ('created', 'state_changed')),
  from_status text,
  to_status text not null,
  created_at timestamptz not null default now(),
  constraint ai_mission_events_mission_same_org_fkey
    foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade
);
create index if not exists ai_mission_events_replay_idx
  on public.ai_mission_events (organization_id, mission_id, id);
create unique index if not exists ai_mission_events_one_creation_uidx
  on public.ai_mission_events (mission_id) where event_type='created';
alter table public.ai_mission_events enable row level security;
drop policy if exists tenant_isolation_ai_mission_events_select on public.ai_mission_events;
create policy tenant_isolation_ai_mission_events_select on public.ai_mission_events
  for select using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
revoke all on public.ai_mission_events from public, anon, authenticated;
grant select on public.ai_mission_events to authenticated;
grant all on public.ai_mission_events to service_role;

create or replace function public.fn_record_ai_mission_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = new.status then return new; end if;
  end if;
  insert into public.ai_mission_events
    (organization_id, mission_id, event_type, from_status, to_status)
  values (
    new.organization_id,
    new.id,
    case when tg_op = 'INSERT' then 'created' else 'state_changed' end,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status
  );
  return new;
end;
$$;
revoke all on function public.fn_record_ai_mission_transition() from public, anon, authenticated;
drop trigger if exists trg_record_ai_mission_transition on public.ai_missions;
create trigger trg_record_ai_mission_transition
  after insert or update of status on public.ai_missions
  for each row execute function public.fn_record_ai_mission_transition();

-- Organizations that created Missions after 0386 but before 0387 still need a
-- replay root. This stores only status, never the goal or acceptance text.
insert into public.ai_mission_events
  (organization_id, mission_id, event_type, from_status, to_status, created_at)
select m.organization_id, m.id, 'created', null, m.status, m.created_at
from public.ai_missions m
where not exists (
  select 1 from public.ai_mission_events e
  where e.mission_id=m.id and e.event_type='created'
)
on conflict do nothing;

notify pgrst, 'reload schema';
