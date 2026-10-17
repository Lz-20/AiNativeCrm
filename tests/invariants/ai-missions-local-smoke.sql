-- Run after migration 0386 in a transaction and roll the transaction back.
do $$
declare
  v_org uuid;
  v_other_org uuid := gen_random_uuid();
  v_lead uuid;
  v_agent uuid;
  v_mission uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_message uuid;
  v_status text;
begin
  select l.organization_id, l.id, a.id into v_org, v_lead, v_agent
  from public.crm_leads l
  join public.ai_agents a on a.organization_id = l.organization_id
  limit 1;
  if v_org is null then raise exception 'mission_smoke_fixture_missing'; end if;
  insert into public.organizations(id,slug,legal_name,display_name)
  values (v_other_org, 'mission-smoke-' || substr(replace(v_other_org::text, '-', ''), 1, 8), 'Mission Smoke', 'Mission Smoke');
  begin
    insert into public.ai_missions(organization_id,lead_id,goal,acceptance_criteria)
    values (v_other_org,v_lead,'Wrong organization','Must be rejected');
    raise exception 'cross_org_lead_accepted';
  exception when foreign_key_violation then null;
  end;
  insert into public.ai_missions(id,organization_id,lead_id,goal,acceptance_criteria)
  values (v_mission,v_org,v_lead,'推进报价','客户确认报价与交期');
  begin
    insert into public.ai_missions(organization_id,lead_id,goal,acceptance_criteria)
    values (v_org,v_lead,'并行重复任务','不应被接受');
    raise exception 'duplicate_active_mission_accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ai_workbench_runs(organization_id,agent_id,mission_id,task,mode)
    values (v_other_org,v_agent,v_mission,'Wrong organization','act');
    raise exception 'cross_org_mission_accepted';
  exception when foreign_key_violation then null;
  end;
  insert into public.ai_workbench_runs(id,organization_id,agent_id,mission_id,task,mode)
  values (v_run,v_org,v_agent,v_mission,'推进报价','act');
  select id into v_message from public.messages
  where organization_id=v_org limit 1;
  if v_message is not null then
    insert into public.ai_mission_wakes(organization_id,mission_id,inbound_message_id,run_id)
    values (v_org,v_mission,v_message,v_run);
    begin
      insert into public.ai_mission_wakes(organization_id,mission_id,inbound_message_id,run_id)
      values (v_org,v_mission,v_message,v_run);
      raise exception 'duplicate_wake_accepted';
    exception when unique_violation then null;
    end;
  end if;
  update public.ai_workbench_runs set status='running' where id=v_run;
  select status into v_status from public.ai_missions where id=v_mission;
  if v_status <> 'running' then raise exception 'mission_running_sync_failed: %', v_status; end if;
  update public.ai_workbench_runs set status='awaiting_confirmation' where id=v_run;
  select status into v_status from public.ai_missions where id=v_mission;
  if v_status <> 'waiting_approval' then raise exception 'mission_approval_sync_failed: %', v_status; end if;
  update public.ai_workbench_runs set status='completed' where id=v_run;
  select status into v_status from public.ai_missions where id=v_mission;
  if v_status <> 'needs_review' then raise exception 'mission_completion_gate_failed: %', v_status; end if;
  update public.ai_missions set status='completed',completed_at=now() where id=v_mission;
  update public.ai_workbench_runs set status='running' where id=v_run;
  select status into v_status from public.ai_missions where id=v_mission;
  if v_status <> 'completed' then raise exception 'mission_manual_completion_overwritten: %', v_status; end if;
  raise notice 'mission smoke passed: tenant links, active uniqueness, wake idempotence, status transitions, business completion gate';
end $$;
