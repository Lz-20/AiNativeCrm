-- 0382 — A workbench reply becomes a normal, reviewable CRM reply draft.
-- Delivery is still owned by the existing approved_reply queue worker, which
-- applies the live send gates, service boundary and idempotent send ledger.

alter table public.ai_reply_drafts
  add column if not exists workbench_run_id uuid,
  add column if not exists workbench_proposal_id uuid;

do $fk$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.ai_reply_drafts'::regclass and conname='ai_reply_drafts_workbench_run_fkey') then
    alter table public.ai_reply_drafts add constraint ai_reply_drafts_workbench_run_fkey
      foreign key (workbench_run_id) references public.ai_workbench_runs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.ai_reply_drafts'::regclass and conname='ai_reply_drafts_workbench_proposal_fkey') then
    alter table public.ai_reply_drafts add constraint ai_reply_drafts_workbench_proposal_fkey
      foreign key (workbench_proposal_id) references public.ai_agent_action_proposals(id) on delete cascade;
  end if;
end
$fk$;

create unique index if not exists ai_reply_drafts_workbench_proposal_uidx
  on public.ai_reply_drafts (organization_id, workbench_proposal_id)
  where workbench_proposal_id is not null;

comment on column public.ai_reply_drafts.workbench_run_id is
  'Source workbench run for a customer-approved message; delivery remains on approved_reply.';
comment on column public.ai_reply_drafts.workbench_proposal_id is
  'Exact human-confirmed send_message proposal that authorized this reply draft.';

create or replace function public.fn_reply_workbench_stage(
  p_org uuid,
  p_run uuid,
  p_proposal uuid,
  p_version uuid,
  p_context_revision bigint,
  p_operation_revision bigint,
  p_body text
) returns uuid
language plpgsql security definer set search_path=public as $$
declare
  r public.ai_workbench_runs;
  a public.ai_agents;
  c public.conversations;
  d public.ai_reply_drafts;
  contact uuid;
  boundary jsonb;
begin
  if p_body is null or length(btrim(p_body))=0 or length(p_body)>12000 then
    raise exception 'reply_body_invalid' using errcode='22023';
  end if;
  select * into r from public.ai_workbench_runs where organization_id=p_org and id=p_run for update;
  if not found or r.mode<>'act' or r.status<>'running' or r.scope->>'conversationId' is null then
    raise exception 'workbench_reply_run_stale' using errcode='40001';
  end if;
  select * into a from public.ai_agents where organization_id=p_org and id=r.agent_id for share;
  if not found or a.archived_at is not null or a.operation_revision<>p_operation_revision then
    raise exception 'reply_agent_stale' using errcode='40001';
  end if;
  if not exists (
    select 1 from public.ai_agent_versions v
    where v.organization_id=p_org and v.agent_id=a.id and v.id=p_version
  ) then raise exception 'reply_agent_version_stale' using errcode='40001'; end if;
  if not exists (
    select 1 from public.ai_agent_action_proposals p
    where p.organization_id=p_org and p.run_id=p_run and p.id=p_proposal
      and p.tool_name='send_message' and p.status='pending' and p.tool_args->>'body'=p_body
  ) then raise exception 'workbench_reply_proposal_stale' using errcode='40001'; end if;

  select contact_id into contact from public.conversations
  where organization_id=p_org and id=(r.scope->>'conversationId')::uuid;
  if contact is null then raise exception 'reply_context_unavailable' using errcode='42501'; end if;
  perform public.fn_service_lock(p_org,contact);
  select * into c from public.conversations
  where organization_id=p_org and id=(r.scope->>'conversationId')::uuid and contact_id=contact
  for no key update;
  if not found or c.is_group or c.reply_context_revision<>p_context_revision
     or c.channel_session_id is null then
    raise exception 'reply_context_stale' using errcode='40001';
  end if;
  perform 1 from public.contacts where organization_id=p_org and id=contact and not is_blocked and not is_anonymized for share;
  if not found then raise exception 'reply_context_unavailable' using errcode='42501'; end if;
  perform 1 from public.channel_sessions where organization_id=p_org and id=c.channel_session_id and archived_at is null for share;
  if not found then raise exception 'reply_context_unavailable' using errcode='42501'; end if;
  boundary:=public.fn_service_boundary(p_org,c.id)-'status'-'demanda_fechada_em'-'service_started_at';
  if not public.fn_meet_boundary_current(boundary) then
    raise exception 'reply_context_stale' using errcode='40001';
  end if;

  select * into d from public.ai_reply_drafts
  where organization_id=p_org and workbench_proposal_id=p_proposal;
  if found then
    if d.original_body<>p_body or d.workbench_run_id<>p_run or d.agent_version_id<>p_version
       or d.context_revision<>p_context_revision or d.operation_revision<>p_operation_revision then
      raise exception 'workbench_reply_proposal_conflict' using errcode='40001';
    end if;
    return d.id;
  end if;
  insert into public.ai_reply_drafts(
    organization_id,conversation_id,contact_id,agent_id,agent_version_id,channel_session_id,
    service_boundary,context_revision,operation_revision,status,original_body,workbench_run_id,workbench_proposal_id
  ) values (
    p_org,c.id,contact,a.id,p_version,c.channel_session_id,boundary,p_context_revision,
    p_operation_revision,'pending',p_body,p_run,p_proposal
  ) returning * into d;
  return d.id;
end;
$$;
revoke all on function public.fn_reply_workbench_stage(uuid,uuid,uuid,uuid,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.fn_reply_workbench_stage(uuid,uuid,uuid,uuid,bigint,bigint,text) to service_role;

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
revoke all on function public.fn_reply_context_current(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_reply_context_current(uuid,uuid) to service_role;

create or replace function public.fn_reply_workbench_decision_bridge()
returns trigger language plpgsql security definer set search_path=public as $$
declare target_status text;
begin
  if old.status='pending' and new.workbench_proposal_id is not null
     and new.status in ('approved','dismissed') then
    target_status:=case when new.status='approved' then 'executed' else 'rejected' end;
    update public.ai_agent_action_proposals
      set status=target_status,
          decision_by=coalesce(new.approved_by,auth.uid()),
          decision_reason=case when new.status='dismissed' then left(new.feedback->>'reason',1000) else null end,
          decision_at=coalesce(new.approved_at,now()),
          result_summary=case when new.status='approved'
            then jsonb_build_object('outcome','queued','sendJobId',new.send_job_id)
            else jsonb_build_object('outcome','rejected') end
      where organization_id=new.organization_id and run_id=new.workbench_run_id
        and id=new.workbench_proposal_id and status='pending';
    if not found then raise exception 'workbench_reply_proposal_stale' using errcode='40001'; end if;
    update public.ai_workbench_runs set status='running'
      where organization_id=new.organization_id and id=new.workbench_run_id
        and status in ('awaiting_confirmation','running');
    if not found then raise exception 'workbench_reply_run_stale' using errcode='40001'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_reply_workbench_decision_bridge() from public,anon,authenticated;
drop trigger if exists trg_reply_workbench_decision_bridge on public.ai_reply_drafts;
create trigger trg_reply_workbench_decision_bridge after update of status on public.ai_reply_drafts
  for each row execute function public.fn_reply_workbench_decision_bridge();

notify pgrst, 'reload schema';
