-- 0391 — An internal fact can wake one waiting Mission, but is not approval.
-- The free text lives in the manager-scoped Run task, not in this idempotency ledger
-- or the append-only product events. Keeping only a digest avoids another PII copy.
create unique index if not exists ai_workbench_runs_org_mission_run_uidx
  on public.ai_workbench_runs (organization_id, mission_id, id);
create table if not exists public.ai_mission_internal_inputs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null,
  request_key uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  run_id uuid not null,
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint ai_mission_internal_inputs_mission_same_org_fkey
    foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade,
  constraint ai_mission_internal_inputs_run_same_org_fkey
    foreign key (organization_id, mission_id, run_id)
    references public.ai_workbench_runs(organization_id, mission_id, id) on delete cascade,
  constraint ai_mission_internal_inputs_request_unique
    unique (organization_id, mission_id, request_key),
  constraint ai_mission_internal_inputs_run_unique unique (run_id)
);
alter table public.ai_mission_internal_inputs enable row level security;
revoke all on public.ai_mission_internal_inputs from public, anon, authenticated;
grant all on public.ai_mission_internal_inputs to service_role;

notify pgrst, 'reload schema';
