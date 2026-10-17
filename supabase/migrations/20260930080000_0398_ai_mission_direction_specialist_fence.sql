-- 0398 — A manager may replace a running Mission. A cancelled specialist
-- must not be reclaimed by an old worker after the replacement commits.
create or replace function public.fn_ai_specialist_parent_active()
returns trigger language plpgsql set search_path = public as $$
declare
  v_parent_status text;
begin
  if new.run_kind <> 'specialist' or new.status not in ('queued','running') then
    return new;
  end if;
  -- Lock the parent before a child is created or reactivated. The manager's
  -- replacement locks that same root before cancelling its children. A
  -- terminal-but-not-cancelled parent remains compatible with historical
  -- specialist/evaluation rows; cancellation is the security boundary.
  select status into v_parent_status
  from public.ai_workbench_runs
  where organization_id = new.organization_id and id = new.parent_run_id
    and run_kind = 'root'
  for share;
  -- Missing/wrong-tenant parentage is reported by the existing composite FK.
  if v_parent_status = 'cancelled' then
    raise exception 'specialist_parent_inactive' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_ai_specialist_parent_active()
  from public, anon, authenticated;
drop trigger if exists trg_ai_specialist_parent_active on public.ai_workbench_runs;
create trigger trg_ai_specialist_parent_active
  before insert or update of status on public.ai_workbench_runs
  for each row execute function public.fn_ai_specialist_parent_active();

create or replace function public.fn_claim_ai_specialist_run(
  p_org uuid, p_parent uuid, p_run uuid, p_attempt uuid,
  p_lease_seconds integer default 120
) returns table (
  execution_attempt_id uuid,
  execution_lease_expires_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_parent_status text;
begin
  if p_attempt is null or p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'specialist_lease_invalid' using errcode = '22023';
  end if;
  -- Acquire the parent lock before touching the child row. Otherwise a
  -- simultaneous manager replacement can deadlock child -> parent.
  select status into v_parent_status
  from public.ai_workbench_runs
  where organization_id = p_org and id = p_parent and run_kind = 'root'
  for share;
  if v_parent_status is null or v_parent_status = 'cancelled' then return; end if;

  return query
  update public.ai_workbench_runs as r
  set status = 'running',
      execution_attempt_id = p_attempt,
      execution_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = clock_timestamp(), completed_at = null,
      error_code = null, error_summary = null
  where r.organization_id = p_org and r.id = p_run
    and r.parent_run_id = p_parent and r.run_kind = 'specialist'
    and (
      r.status in ('queued', 'failed', 'cancelled')
      or (r.status = 'running' and r.execution_lease_expires_at <= clock_timestamp())
    )
  returning r.execution_attempt_id, r.execution_lease_expires_at;
end;
$$;
revoke all on function public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)
  to service_role;

-- The worker checks its lease before persisting proposals, but cancellation
-- can commit between that check and INSERT. Locking the root on INSERT makes
-- either ordering safe: the manager revokes an earlier proposal, or the late
-- proposal is refused after the root becomes cancelled.
create or replace function public.fn_ai_mission_proposal_parent_active()
returns trigger language plpgsql set search_path = public as $$
declare
  v_run record;
begin
  select r.status,r.mission_id into v_run
  from public.ai_workbench_runs r
  where r.organization_id = new.organization_id and r.id = new.run_id
  for share;
  if v_run.mission_id is not null and v_run.status = 'cancelled' then
    raise exception 'mission_run_cancelled' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_ai_mission_proposal_parent_active()
  from public, anon, authenticated;
drop trigger if exists trg_ai_mission_proposal_parent_active
  on public.ai_agent_action_proposals;
create trigger trg_ai_mission_proposal_parent_active
  before insert on public.ai_agent_action_proposals
  for each row execute function public.fn_ai_mission_proposal_parent_active();
notify pgrst, 'reload schema';
