-- 0399 — acceptance is not consumption. Persist the model transcript and a
-- redacted direction-consumed acknowledgement in the same transaction.
alter table public.ai_missions
  add column if not exists direction_consumed_revision bigint not null default 0;
alter table public.ai_missions
  drop constraint if exists ai_missions_direction_consumed_revision_check;
alter table public.ai_missions
  add constraint ai_missions_direction_consumed_revision_check
  check (direction_consumed_revision >= 0 and
    direction_consumed_revision <= direction_revision);

alter table public.ai_mission_internal_inputs
  add column if not exists direction_revision bigint,
  add column if not exists consumed_at timestamptz;
update public.ai_mission_internal_inputs i
set direction_revision = (r.runtime_state->>'directionRevision')::bigint
from public.ai_workbench_runs r
where r.organization_id=i.organization_id and r.id=i.run_id
  and i.kind='manager_direction' and i.direction_revision is null
  and (r.runtime_state->>'directionRevision') ~ '^[0-9]+$';
alter table public.ai_mission_internal_inputs
  drop constraint if exists ai_mission_internal_inputs_direction_shape_check;
-- Historical manager rows can lack a recoverable Run revision. Keep them as
-- unacknowledged legacy inputs; new commands always supply a positive revision.
alter table public.ai_mission_internal_inputs
  add constraint ai_mission_internal_inputs_direction_shape_check
  check ((kind='internal_fact' and direction_revision is null and consumed_at is null)
    or (kind='manager_direction' and (direction_revision is null or direction_revision > 0)));
create unique index if not exists ai_mission_internal_inputs_direction_revision_uidx
  on public.ai_mission_internal_inputs(organization_id,mission_id,direction_revision)
  where kind='manager_direction' and direction_revision is not null;

alter table public.ai_agent_run_events
  drop constraint if exists ai_agent_run_events_event_type_check;
alter table public.ai_agent_run_events
  add constraint ai_agent_run_events_event_type_check check (event_type in (
    'run_started','context_loaded','model_decision','tool_proposed','policy_checked',
    'tool_started','tool_completed','crm_state_changed','human_confirmation_requested',
    'human_confirmation_received','run_resumed','run_completed','run_partial',
    'run_failed','run_cancelled','usage_reported','collaboration_started',
    'specialist_started','specialist_completed','specialist_failed',
    'collaboration_conflict','collaboration_completed','manager_direction_consumed'
  ));
notify pgrst, 'reload schema';
