-- 0396 — a manager's "do not send" is durable policy, never just a model hint.
alter table public.ai_missions
  add column if not exists customer_send_paused boolean not null default false,
  add column if not exists customer_send_paused_at timestamptz,
  add column if not exists send_policy_revision bigint not null default 0;

create table if not exists public.ai_mission_commands (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  mission_id uuid not null,
  actor_user_id uuid not null,
  request_key uuid not null,
  kind text not null check (kind in ('pause_customer_send','resume_customer_send')),
  reason text not null check (char_length(reason) between 5 and 2000),
  changed boolean not null,
  paused_after boolean not null,
  policy_revision bigint not null,
  created_at timestamptz not null default now(),
  unique (organization_id, mission_id, request_key),
  foreign key (mission_id, organization_id)
    references public.ai_missions(id, organization_id) on delete cascade,
  foreign key (actor_user_id, organization_id)
    references public.user_organizations(user_id, organization_id)
);
create index if not exists ai_mission_commands_replay_idx
  on public.ai_mission_commands (organization_id, mission_id, id);
alter table public.ai_mission_commands enable row level security;
revoke all on public.ai_mission_commands from public, anon, authenticated;
revoke all on public.ai_mission_commands from service_role;
grant select on public.ai_mission_commands to service_role;

create or replace function public.fn_set_ai_mission_send_policy(
  p_org uuid, p_mission uuid, p_actor uuid, p_request_key uuid,
  p_kind text, p_reason text
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_mission public.ai_missions;
  v_prior public.ai_mission_commands;
  v_paused boolean;
  v_changed boolean;
  v_contact uuid;
begin
  if p_org is null or p_mission is null or p_actor is null or p_request_key is null
     or p_kind is null or p_kind not in ('pause_customer_send','resume_customer_send')
     or p_reason is null or char_length(p_reason) not between 5 and 2000 then
    return jsonb_build_object('result','invalid_request');
  end if;
  if not exists (
    select 1 from public.user_organizations u
    where u.organization_id=p_org and u.user_id=p_actor
      and u.revoked_at is null and u.role in ('manager','admin')
  ) then return jsonb_build_object('result','unauthorized'); end if;
  select l.contact_id into v_contact
  from public.ai_missions m
  join public.crm_leads l on l.organization_id=m.organization_id and l.id=m.lead_id
  where m.organization_id=p_org and m.id=p_mission;
  if v_contact is not null then perform public.fn_service_lock(p_org,v_contact); end if;
  select * into v_mission from public.ai_missions
  where organization_id=p_org and id=p_mission for update;
  if not found then return jsonb_build_object('result','not_found'); end if;
  select * into v_prior from public.ai_mission_commands
  where organization_id=p_org and mission_id=p_mission and request_key=p_request_key;
  if found then
    if v_prior.kind is distinct from p_kind or v_prior.reason is distinct from p_reason
       or v_prior.actor_user_id is distinct from p_actor then
      return jsonb_build_object('result','source_conflict');
    end if;
    return jsonb_build_object('result','replayed','paused',v_mission.customer_send_paused,
      'revision',v_mission.send_policy_revision,'commandId',v_prior.id);
  end if;
  if v_mission.status in ('completed','cancelled') then
    return jsonb_build_object('result','terminal');
  end if;
  v_paused := p_kind='pause_customer_send';
  v_changed := v_mission.customer_send_paused is distinct from v_paused;
  if v_changed then
    update public.ai_missions set customer_send_paused=v_paused,
      customer_send_paused_at=case when v_paused then clock_timestamp() else customer_send_paused_at end,
      send_policy_revision=send_policy_revision+1
    where organization_id=p_org and id=p_mission
    returning * into v_mission;
    if v_paused then
      -- Revoke approved work that has not crossed the final sending cut.
      -- A draft already in 'sending' may have reached the provider, so its
      -- receipt must remain reconcilable; the pause timestamp keeps that old
      -- approval invalid even if the manager resumes immediately.
      update public.ai_reply_drafts d set status='stale',
        error_code='mission_send_paused',updated_at=now()
      where d.organization_id=p_org and d.status='approved'
        and d.workbench_run_id in (
          select r.id from public.ai_workbench_runs r
          where r.organization_id=p_org and r.mission_id=p_mission
        );
      update public.job_queue j set status='failed',
        locked_by=null,locked_at=null,last_error='mission_send_paused'
      where j.organization_id=p_org and j.kind='approved_reply'
        and j.status in ('pending','running')
        and exists (
          select 1 from public.ai_reply_drafts d
          join public.ai_workbench_runs r
            on r.organization_id=d.organization_id and r.id=d.workbench_run_id
          where d.organization_id=j.organization_id and d.send_job_id=j.id
            and d.status='stale' and d.error_code='mission_send_paused'
            and r.mission_id=p_mission
        );
    end if;
  end if;
  insert into public.ai_mission_commands
    (organization_id,mission_id,actor_user_id,request_key,kind,reason,
     changed,paused_after,policy_revision)
  values (p_org,p_mission,p_actor,p_request_key,p_kind,p_reason,
          v_changed,v_paused,v_mission.send_policy_revision)
  returning * into v_prior;
  return jsonb_build_object('result',case when v_changed then 'changed' else 'unchanged' end,
    'paused',v_paused,'revision',v_mission.send_policy_revision,'commandId',v_prior.id);
end;
$$;
revoke all on function public.fn_set_ai_mission_send_policy(uuid,uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.fn_set_ai_mission_send_policy(uuid,uuid,uuid,uuid,text,text)
  to service_role;

-- This function is also checked immediately before provider transport. An
-- already accepted provider call cannot be rolled back; receipt reconciliation
-- remains possible even after the Mission is paused.
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
                    and not m.customer_send_paused
                    and (m.customer_send_paused_at is null or d.approved_at is null
                      or d.approved_at > m.customer_send_paused_at)
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
