-- 0384 — Bounded multi-Agent collaboration and reproducible run evaluation.
--
-- A specialist is a first-class workbench run so it inherits the existing
-- durable state/event model. Specialists are read-only by schema; only the root
-- run may enter the CRM proposal/write path.

alter table public.ai_workbench_runs
  add column if not exists run_kind text not null default 'root',
  add column if not exists parent_run_id uuid,
  add column if not exists specialist_key text,
  add column if not exists collaboration_key text;

alter table public.ai_workbench_runs drop constraint if exists ai_workbench_runs_run_kind_check;
alter table public.ai_workbench_runs add constraint ai_workbench_runs_run_kind_check
  check (run_kind in ('root', 'specialist'));

alter table public.ai_workbench_runs drop constraint if exists ai_workbench_runs_collaboration_shape_check;
alter table public.ai_workbench_runs add constraint ai_workbench_runs_collaboration_shape_check
  check (
    (run_kind = 'root' and parent_run_id is null and specialist_key is null)
    or
    (run_kind = 'specialist' and parent_run_id is not null and specialist_key is not null
      and collaboration_key is not null and mode = 'inspect')
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_workbench_runs'::regclass
      and conname = 'ai_workbench_runs_id_organization_unique'
  ) then
    alter table public.ai_workbench_runs
      add constraint ai_workbench_runs_id_organization_unique unique (id, organization_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_workbench_runs'::regclass
      and conname = 'ai_workbench_runs_parent_same_org_fkey'
  ) then
    alter table public.ai_workbench_runs
      add constraint ai_workbench_runs_parent_same_org_fkey
      foreign key (parent_run_id, organization_id)
      references public.ai_workbench_runs(id, organization_id) on delete cascade;
  end if;
end $$;

create unique index if not exists ai_workbench_runs_parent_specialist_uidx
  on public.ai_workbench_runs (parent_run_id, specialist_key)
  where run_kind = 'specialist';
create index if not exists ai_workbench_runs_root_history_idx
  on public.ai_workbench_runs (organization_id, created_at desc)
  where run_kind = 'root';
create index if not exists ai_workbench_runs_children_idx
  on public.ai_workbench_runs (organization_id, parent_run_id, created_at)
  where run_kind = 'specialist';

alter table public.ai_agent_run_events drop constraint if exists ai_agent_run_events_event_type_check;
alter table public.ai_agent_run_events add constraint ai_agent_run_events_event_type_check
  check (event_type in (
    'run_started', 'context_loaded', 'model_decision', 'tool_proposed', 'policy_checked',
    'tool_started', 'tool_completed', 'crm_state_changed', 'human_confirmation_requested',
    'human_confirmation_received', 'run_resumed', 'run_completed', 'run_partial',
    'run_failed', 'run_cancelled', 'usage_reported',
    'collaboration_started', 'specialist_started', 'specialist_completed',
    'specialist_failed', 'collaboration_conflict', 'collaboration_completed'
  ));

alter table public.llm_calls add column if not exists workbench_run_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.llm_calls'::regclass
      and conname = 'llm_calls_workbench_run_same_org_fkey'
  ) then
    alter table public.llm_calls
      add constraint llm_calls_workbench_run_same_org_fkey
      foreign key (workbench_run_id, organization_id)
      references public.ai_workbench_runs(id, organization_id) on delete set null;
  end if;
end $$;
create index if not exists llm_calls_workbench_run_created_idx
  on public.llm_calls (organization_id, workbench_run_id, created_at);

create table if not exists public.ai_agent_eval_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  profile_key text not null,
  profile_revision integer not null check (profile_revision > 0),
  input_fingerprint text not null check (length(input_fingerprint) = 64),
  verdict text not null check (verdict in ('pass', 'fail', 'needs_review', 'not_run')),
  score integer check (score between 0 and 100),
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  created_at timestamptz not null default now(),
  constraint ai_agent_eval_reports_run_same_org_fkey
    foreign key (run_id, organization_id)
    references public.ai_workbench_runs(id, organization_id) on delete cascade,
  constraint ai_agent_eval_reports_reproducible_unique
    unique (run_id, profile_key, profile_revision, input_fingerprint)
);

create index if not exists ai_agent_eval_reports_org_run_created_idx
  on public.ai_agent_eval_reports (organization_id, run_id, created_at desc);
alter table public.ai_agent_eval_reports enable row level security;
drop policy if exists tenant_isolation_ai_agent_eval_reports_select on public.ai_agent_eval_reports;
create policy tenant_isolation_ai_agent_eval_reports_select on public.ai_agent_eval_reports
  for select using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );
revoke all on public.ai_agent_eval_reports from public, anon, authenticated;
grant select on public.ai_agent_eval_reports to authenticated;
grant all on public.ai_agent_eval_reports to service_role;

comment on column public.ai_workbench_runs.run_kind is
  'Root user run or read-only specialist child run.';
comment on column public.ai_workbench_runs.parent_run_id is
  'Root workbench run that owns this bounded specialist execution.';
comment on table public.ai_agent_eval_reports is
  'Versioned deterministic/semantic evaluation snapshots keyed by an input fingerprint.';

notify pgrst, 'reload schema';
