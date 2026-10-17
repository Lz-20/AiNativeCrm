-- 0389 — cancelling a Mission is an atomic stop, not a note in its timeline.
-- The final approved-reply gate also checks the owning Mission immediately
-- before transport; a queued approval cannot outlive a cancellation.

create or replace function public.fn_cancel_ai_mission(
  p_org uuid, p_mission uuid, p_actor uuid, p_reason text
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_run record;
  v_attempt integer;
begin
  select status into v_status
  from public.ai_missions
  where organization_id = p_org and id = p_mission
  for update;
  if not found then return 'not_found'; end if;
  if v_status in ('completed', 'cancelled') then return 'terminal'; end if;

  update public.ai_missions set
    status = 'cancelled', blocked_reason = left(p_reason, 2000),
    wake_on_customer_reply = false, completed_at = now(),
    resolution_reason = left(p_reason, 2000), resolved_by_user_id = p_actor
  where organization_id = p_org and id = p_mission;

  -- Pending drafts become unusable even if the approval UI is still open.
  -- Approved/sending drafts are not rewritten: a provider may already have
  -- accepted them, so receipt reconciliation must remain possible.
  update public.ai_reply_drafts d set
    status = 'stale', error_code = 'mission_cancelled', updated_at = now()
  where d.organization_id = p_org and d.status = 'pending'
    and d.workbench_run_id in (
      select id from public.ai_workbench_runs
      where organization_id = p_org and mission_id = p_mission
    );
  update public.ai_agent_action_proposals p set status = 'cancelled'
  where p.organization_id = p_org and p.status = 'pending'
    and p.run_id in (
      select id from public.ai_workbench_runs
      where organization_id = p_org and mission_id = p_mission
    );

  for v_run in
    update public.ai_workbench_runs r set
      status = 'cancelled', completed_at = now(),
      error_code = 'mission_cancelled'
    where r.organization_id = p_org
      and r.status in ('queued', 'running', 'awaiting_confirmation')
      and (
        r.mission_id = p_mission or r.parent_run_id in (
          select id from public.ai_workbench_runs
          where organization_id = p_org and mission_id = p_mission
        )
      )
    returning r.id
  loop
    -- Persist the terminal product event in the same transaction. A worker
    -- may append another event concurrently; retry the sequence collision.
    for v_attempt in 1..8 loop
      begin
        insert into public.ai_agent_run_events
          (organization_id, run_id, sequence, event_type, payload)
        select p_org, v_run.id, coalesce(max(sequence), 0) + 1,
               'run_cancelled', jsonb_build_object('actorUserId', p_actor)
        from public.ai_agent_run_events
        where organization_id = p_org and run_id = v_run.id;
        exit;
      exception when unique_violation then
        if v_attempt = 8 then raise; end if;
      end;
    end loop;
  end loop;
  return 'cancelled';
end;
$$;
revoke all on function public.fn_cancel_ai_mission(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.fn_cancel_ai_mission(uuid,uuid,uuid,text)
  to service_role;

create or replace function public.fn_reply_context_current(p_org uuid,p_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.ai_reply_drafts d
    join public.conversations c on c.organization_id=d.organization_id and c.id=d.conversation_id and c.contact_id=d.contact_id
    join public.ai_agents a on a.organization_id=d.organization_id and a.id=d.agent_id
    join public.contacts p on p.organization_id=d.organization_id and p.id=d.contact_id
    join public.channel_sessions s on s.organization_id=d.organization_id and s.id=d.channel_session_id
    where d.organization_id=p_org and d.id=p_id
      and c.reply_context_revision=d.context_revision and a.operation_revision=d.operation_revision
      and a.archived_at is null and c.channel_session_id=d.channel_session_id and s.archived_at is null
      and not p.is_blocked and not p.is_anonymized and public.fn_meet_boundary_current(d.service_boundary)
      and (
        (d.workbench_run_id is null and a.published_version_id=d.agent_version_id)
        or (
          d.workbench_run_id is not null and d.workbench_proposal_id is not null
          and exists (
            select 1 from public.ai_workbench_runs r
            join public.ai_agent_action_proposals proposal
              on proposal.organization_id=r.organization_id and proposal.run_id=r.id
            where r.organization_id=d.organization_id and r.id=d.workbench_run_id
              and r.agent_id=d.agent_id and r.mode='act'
              and r.scope->>'conversationId'=d.conversation_id::text
              and r.status in ('awaiting_confirmation','running','completed','partial','failed')
              and (
                r.mission_id is null or exists (
                  select 1 from public.ai_missions m
                  where m.organization_id=r.organization_id and m.id=r.mission_id
                    and m.status not in ('cancelled','completed')
                    and a.is_active and a.paused_at is null
                    and a.operation_mode='automatic'
                )
              )
              and proposal.id=d.workbench_proposal_id and proposal.tool_name='send_message'
              and proposal.tool_args->>'body'=d.original_body
              and (
                (proposal.status='pending' and d.status='pending')
                or (proposal.status='executed' and d.status in ('approved','sending','sent'))
              )
          )
        )
      )
  );
$$;
revoke all on function public.fn_reply_context_current(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fn_reply_context_current(uuid,uuid)
  to service_role;

notify pgrst, 'reload schema';
