-- 0381 — Built-in agents are stable, tenant-owned runtime definitions.
-- Additive and idempotent: existing agents remain user-owned and pinned.

alter table public.ai_agents
  add column if not exists origin text not null default 'user',
  add column if not exists builtin_key text,
  add column if not exists builtin_revision integer not null default 1,
  add column if not exists model_binding_mode text not null default 'pinned';

alter table public.ai_agents drop constraint if exists ai_agents_origin_check;
alter table public.ai_agents add constraint ai_agents_origin_check
  check (origin in ('user', 'builtin'));

alter table public.ai_agents drop constraint if exists ai_agents_model_binding_mode_check;
alter table public.ai_agents add constraint ai_agents_model_binding_mode_check
  check (model_binding_mode in ('organization_default', 'pinned'));

alter table public.ai_agents drop constraint if exists ai_agents_builtin_metadata_check;
alter table public.ai_agents add constraint ai_agents_builtin_metadata_check
  check (
    (origin = 'user' and builtin_key is null)
    or (origin = 'builtin' and builtin_key is not null and model_binding_mode = 'organization_default')
  );

create unique index if not exists ai_agents_organization_builtin_key_uidx
  on public.ai_agents (organization_id, builtin_key)
  where builtin_key is not null;

-- Built-ins are readable by tenant members but not writable through PostgREST.
-- Service-role provisioning remains the only writer; API routes add user-facing locks.
drop policy if exists tenant_isolation_ai_agents_write on public.ai_agents;
create policy tenant_isolation_ai_agents_write on public.ai_agents
  for all using (
    origin = 'user'
    and organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    origin = 'user'
    and organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

drop policy if exists tenant_isolation_ai_agent_versions_write on public.ai_agent_versions;
create policy tenant_isolation_ai_agent_versions_write on public.ai_agent_versions
  for all using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
    and exists (select 1 from public.ai_agents a where a.id = ai_agent_versions.agent_id and a.organization_id = ai_agent_versions.organization_id and a.origin = 'user')
  ) with check (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
    and exists (select 1 from public.ai_agents a where a.id = ai_agent_versions.agent_id and a.organization_id = ai_agent_versions.organization_id and a.origin = 'user')
  );

comment on column public.ai_agents.origin is 'Product ownership: user-authored or immutable built-in definition.';
comment on column public.ai_agents.builtin_key is 'Stable key from the TypeScript built-in registry; unique per organization.';
comment on column public.ai_agents.builtin_revision is 'Registry revision used to seed/update this built-in definition.';
comment on column public.ai_agents.model_binding_mode is 'Pinned model or the organization current default at execution time.';

create table if not exists public.ai_workbench_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  task text not null,
  mode text not null check (mode in ('inspect', 'act')),
  scope jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_confirmation', 'completed', 'partial', 'failed', 'cancelled')),
  runtime_state jsonb not null default '{}'::jsonb,
  final_text text,
  error_code text,
  error_summary text,
  budget jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_workbench_runs_org_created_idx
  on public.ai_workbench_runs (organization_id, created_at desc);
create index if not exists ai_workbench_runs_org_agent_idx
  on public.ai_workbench_runs (organization_id, agent_id, created_at desc);

alter table public.ai_workbench_runs enable row level security;
drop policy if exists tenant_isolation_ai_workbench_runs_all on public.ai_workbench_runs;
drop policy if exists tenant_isolation_ai_workbench_runs_select on public.ai_workbench_runs;
create policy tenant_isolation_ai_workbench_runs_select on public.ai_workbench_runs
  for select using (organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager'));
revoke all on public.ai_workbench_runs from public, anon, authenticated;
grant select on public.ai_workbench_runs to authenticated;
grant all on public.ai_workbench_runs to service_role;

create table if not exists public.ai_agent_run_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.ai_workbench_runs(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  event_type text not null check (event_type in (
    'run_started', 'context_loaded', 'model_decision', 'tool_proposed', 'policy_checked',
    'tool_started', 'tool_completed', 'crm_state_changed', 'human_confirmation_requested',
    'human_confirmation_received', 'run_resumed', 'run_completed', 'run_partial',
    'run_failed', 'run_cancelled', 'usage_reported'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_agent_run_events_run_sequence_unique unique (run_id, sequence)
);

create index if not exists ai_agent_run_events_org_run_sequence_idx
  on public.ai_agent_run_events (organization_id, run_id, sequence);

alter table public.ai_agent_run_events enable row level security;
drop policy if exists tenant_isolation_ai_agent_run_events_select on public.ai_agent_run_events;
create policy tenant_isolation_ai_agent_run_events_select on public.ai_agent_run_events
  for select using (organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager'));
revoke all on public.ai_agent_run_events from public, anon, authenticated, service_role;
grant select on public.ai_agent_run_events to authenticated;
grant select, insert on public.ai_agent_run_events to service_role;

create table if not exists public.ai_agent_action_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.ai_workbench_runs(id) on delete cascade,
  sequence integer not null,
  tool_name text not null,
  tool_args jsonb not null default '{}'::jsonb,
  compensation_args jsonb,
  preview jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled', 'undoing', 'undone', 'undo_failed')),
  decision_by uuid references auth.users(id) on delete set null,
  decision_reason text,
  decision_at timestamptz,
  result_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_action_proposals_run_sequence_unique unique (run_id, sequence)
);

-- The Pi continuation snapshot contains CRM context and tool results. It is
-- deliberately separated from manager-readable run metadata and service-only.
create table if not exists public.ai_agent_run_states (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid primary key references public.ai_workbench_runs(id) on delete cascade,
  state_revision integer not null default 1 check (state_revision > 0),
  messages jsonb not null check (jsonb_typeof(messages) = 'array'),
  observations jsonb not null default '[]'::jsonb check (jsonb_typeof(observations) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.ai_agent_run_states enable row level security;
revoke all on public.ai_agent_run_states from public, anon, authenticated;
grant all on public.ai_agent_run_states to service_role;

create index if not exists ai_agent_action_proposals_org_status_idx
  on public.ai_agent_action_proposals (organization_id, status, created_at desc);
alter table public.ai_agent_action_proposals enable row level security;
drop policy if exists tenant_isolation_ai_agent_action_proposals_select on public.ai_agent_action_proposals;
create policy tenant_isolation_ai_agent_action_proposals_select on public.ai_agent_action_proposals
  for select using (organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager'));
revoke all on public.ai_agent_action_proposals from anon, authenticated;
grant all on public.ai_agent_action_proposals to service_role;

drop trigger if exists trg_ai_workbench_runs_updated_at on public.ai_workbench_runs;
create trigger trg_ai_workbench_runs_updated_at before update on public.ai_workbench_runs
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_ai_agent_action_proposals_updated_at on public.ai_agent_action_proposals;
create trigger trg_ai_agent_action_proposals_updated_at before update on public.ai_agent_action_proposals
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_ai_agent_run_states_updated_at on public.ai_agent_run_states;
create trigger trg_ai_agent_run_states_updated_at before update on public.ai_agent_run_states
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
