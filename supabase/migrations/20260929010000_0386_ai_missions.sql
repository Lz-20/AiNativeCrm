-- 0386 — A delegated CRM outcome survives individual Pi runs.
-- A completed model run is evidence for a mission, not proof of the business outcome.

create unique index if not exists crm_leads_organization_id_id_for_missions_uidx
  on public.crm_leads (organization_id, id);

create table if not exists public.ai_missions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  goal text not null check (char_length(goal) between 1 and 8000),
  acceptance_criteria text not null check (char_length(acceptance_criteria) between 1 and 4000),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'waiting_approval', 'waiting_internal',
    'waiting_customer', 'needs_review', 'completed', 'cancelled'
  )),
  blocked_reason text,
  wake_on_customer_reply boolean not null default false,
  max_runs integer not null default 4 check (max_runs between 1 and 10),
  deadline_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_missions_lead_same_org_fkey foreign key (organization_id, lead_id)
    references public.crm_leads(organization_id, id) on delete restrict,
  constraint ai_missions_id_org_unique unique (id, organization_id)
);

create index if not exists ai_missions_org_lead_status_idx
  on public.ai_missions (organization_id, lead_id, status, created_at desc);
create unique index if not exists ai_missions_one_active_per_lead_uidx
  on public.ai_missions (organization_id, lead_id)
  where status not in ('completed', 'cancelled');
create index if not exists ai_missions_due_idx
  on public.ai_missions (deadline_at)
  where deadline_at is not null and status not in ('completed', 'cancelled');

alter table public.ai_missions enable row level security;
drop policy if exists tenant_isolation_ai_missions_select on public.ai_missions;
create policy tenant_isolation_ai_missions_select on public.ai_missions
  for select using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
revoke all on public.ai_missions from public, anon, authenticated;
grant select on public.ai_missions to authenticated;
grant all on public.ai_missions to service_role;

alter table public.ai_workbench_runs add column if not exists mission_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_workbench_runs'::regclass
      and conname = 'ai_workbench_runs_mission_same_org_fkey'
  ) then
    alter table public.ai_workbench_runs
      add constraint ai_workbench_runs_mission_same_org_fkey
      foreign key (mission_id, organization_id)
      references public.ai_missions(id, organization_id) on delete restrict;
  end if;
end $$;
alter table public.ai_workbench_runs
  drop constraint if exists ai_workbench_runs_mission_root_only_check;
alter table public.ai_workbench_runs
  add constraint ai_workbench_runs_mission_root_only_check
  check (mission_id is null or run_kind = 'root');
create index if not exists ai_workbench_runs_mission_history_idx
  on public.ai_workbench_runs (organization_id, mission_id, created_at desc)
  where mission_id is not null;

create table if not exists public.ai_mission_wakes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null,
  inbound_message_id uuid not null,
  run_id uuid not null,
  created_at timestamptz not null default now(),
  constraint ai_mission_wakes_mission_same_org_fkey foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade,
  constraint ai_mission_wakes_run_same_org_fkey foreign key (run_id, organization_id)
    references public.ai_workbench_runs(id, organization_id) on delete cascade,
  constraint ai_mission_wakes_source_unique unique (mission_id, inbound_message_id)
);
alter table public.ai_mission_wakes enable row level security;
revoke all on public.ai_mission_wakes from public, anon, authenticated;
grant all on public.ai_mission_wakes to service_role;

create or replace function public.fn_sync_ai_mission_from_run()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.mission_id is null or new.run_kind <> 'root' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status = new.status then return new; end if;
  end if;

  update public.ai_missions as m
  set status = case new.status
        when 'queued' then 'queued'
        when 'running' then 'running'
        when 'awaiting_confirmation' then 'waiting_approval'
        else 'needs_review'
      end,
      blocked_reason = case new.status
        when 'awaiting_confirmation' then 'action_approval_required'
        when 'partial' then coalesce(new.error_code, 'run_partial')
        when 'failed' then coalesce(new.error_code, 'run_failed')
        when 'cancelled' then 'run_cancelled'
        when 'completed' then 'business_outcome_unverified'
        else null
      end
  where m.id = new.mission_id
    and m.organization_id = new.organization_id
    and m.status not in ('completed', 'cancelled');
  return new;
end;
$$;
revoke all on function public.fn_sync_ai_mission_from_run() from public, anon, authenticated;
drop trigger if exists trg_sync_ai_mission_from_run on public.ai_workbench_runs;
create trigger trg_sync_ai_mission_from_run
  after insert or update of status on public.ai_workbench_runs
  for each row execute function public.fn_sync_ai_mission_from_run();

drop trigger if exists trg_ai_missions_updated_at on public.ai_missions;
create trigger trg_ai_missions_updated_at before update on public.ai_missions
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
