-- 0385 — Fence durable specialist execution attempts with an atomic lease.
--
-- A root job can be reclaimed after a worker crash. The child run therefore
-- needs its own claim token: an old worker may finish its model call, but it
-- must not be able to overwrite the result written by the new owner.

alter table public.ai_workbench_runs
  add column if not exists execution_attempt_id uuid,
  add column if not exists execution_lease_expires_at timestamptz;

-- Deployment must stop workers before schema migration. Any legacy in-flight
-- specialist has no fencing token, so fail it closed and let the durable root
-- retry it through the new claim function.
update public.ai_workbench_runs
set status = 'failed',
    error_code = 'specialist_lease_migration',
    error_summary = 'Legacy specialist execution had no fencing token.',
    completed_at = now()
where run_kind = 'specialist'
  and status = 'running'
  and execution_attempt_id is null;

alter table public.ai_workbench_runs
  drop constraint if exists ai_workbench_runs_specialist_execution_shape_check;
alter table public.ai_workbench_runs
  add constraint ai_workbench_runs_specialist_execution_shape_check
  check (
    (
      run_kind = 'root'
      and execution_attempt_id is null
      and execution_lease_expires_at is null
    )
    or
    (
      run_kind = 'specialist'
      and (
        (
          status = 'running'
          and execution_attempt_id is not null
          and execution_lease_expires_at is not null
        )
        or
        (
          status <> 'running'
          and execution_lease_expires_at is null
        )
      )
    )
  );

create index if not exists ai_workbench_runs_specialist_lease_idx
  on public.ai_workbench_runs (execution_lease_expires_at)
  where run_kind = 'specialist' and status = 'running';

create or replace function public.fn_claim_ai_specialist_run(
  p_org uuid,
  p_parent uuid,
  p_run uuid,
  p_attempt uuid,
  p_lease_seconds integer default 120
) returns table (
  execution_attempt_id uuid,
  execution_lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_attempt is null or p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'specialist_lease_invalid' using errcode = '22023';
  end if;

  return query
  update public.ai_workbench_runs as r
  set status = 'running',
      execution_attempt_id = p_attempt,
      execution_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = clock_timestamp(),
      completed_at = null,
      error_code = null,
      error_summary = null
  where r.organization_id = p_org
    and r.id = p_run
    and r.parent_run_id = p_parent
    and r.run_kind = 'specialist'
    and (
      r.status in ('queued', 'failed', 'cancelled')
      or (
        r.status = 'running'
        and r.execution_lease_expires_at <= clock_timestamp()
      )
    )
  returning r.execution_attempt_id, r.execution_lease_expires_at;
end;
$$;

revoke all on function public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)
  to service_role;

comment on column public.ai_workbench_runs.execution_attempt_id is
  'Fencing token for the latest durable specialist execution attempt.';
comment on column public.ai_workbench_runs.execution_lease_expires_at is
  'After this instant another worker may atomically reclaim the specialist run.';
comment on function public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer) is
  'Atomically claims a queued/retryable or lease-expired specialist and returns its fencing token.';

notify pgrst, 'reload schema';
