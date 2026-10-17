-- 0401 — the reply trigger, not HTTP, claims a waiting workbench Run.
-- A crash before fn_reply_action now leaves the Run awaiting confirmation;
-- a competing send decision cannot run while another decision owns the Run.
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
        and status='awaiting_confirmation';
    if not found then raise exception 'workbench_reply_run_stale' using errcode='40001'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_reply_workbench_decision_bridge()
  from public,anon,authenticated;
notify pgrst, 'reload schema';
