import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { submitMissionInternalResponse,
  submitMissionManagerDirection } from "@/lib/ai/agents/mission-internal-response";
import { loadMissionDirectionContextProbe, persistMissionRunMessagesAndDirectionAck } from
  "@/lib/ai/agents/mission-direction-consumption";
import { submitFeishuMissionText } from "@/lib/ai/internal-collaboration/feishu-mission";
import { persistFeishuMissionEvent } from "@/lib/ai/internal-collaboration/feishu-mission";
import {
  reconcileDeadFeishuInboxJobs,
  runFeishuInboxJob,
} from "@/lib/ai/internal-collaboration/feishu-inbox-job";
import {
  approveProposedFeishuQuestion, askFeishuColleague,
} from "@/lib/ai/internal-collaboration/feishu-question";
import { runFeishuQuestionJob } from "@/lib/ai/internal-collaboration/feishu-question-job";
import { loadMissionContinuationAgent } from "@/lib/ai/agents/mission-continuation-agent";
import { assertWorkbenchJobLease } from "@/lib/ai/agents/workbench-job-lease";
import {
  MissionDirectionFenceError, missionDirectionLockKey,
  stopMissionRunAfterDirectionFence, withMissionDirectionWriteFence,
} from
  "@/lib/ai/agents/mission-direction-fence";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
  ], { input: script, encoding: "utf8" }).trim();
}

const A = {
  org: "a3910000-0000-4000-8000-000000000001",
  user: "a3910000-1111-4000-8000-000000000001",
  pipeline: "a3910000-2222-4000-8000-000000000001",
  stage: "a3910000-3333-4000-8000-000000000001",
  lead: "a3910000-4444-4000-8000-000000000001",
  agent: "a3910000-5555-4000-8000-000000000001",
  mission: "a3910000-6666-4000-8000-000000000001",
  run: "a3910000-7777-4000-8000-000000000001",
  run2: "a3910000-7777-4000-8000-000000000003",
};
const B = {
  org: "b3910000-0000-4000-8000-000000000002",
  user: "b3910000-1111-4000-8000-000000000002",
  pipeline: "b3910000-2222-4000-8000-000000000002",
  stage: "b3910000-3333-4000-8000-000000000002",
  lead: "b3910000-4444-4000-8000-000000000002",
  agent: "b3910000-5555-4000-8000-000000000002",
  mission: "b3910000-6666-4000-8000-000000000002",
  run: "b3910000-7777-4000-8000-000000000002",
};
const KEY = "c3910000-8888-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const CONTINUATION = {
  lead: "a3910000-4444-4000-8000-000000000004",
  mission: "a3910000-6666-4000-8000-000000000004",
  run: "a3910000-7777-4000-8000-000000000004",
  session: "a3910000-9999-4000-8000-000000000004",
  version: "a3910000-aaaa-4000-8000-000000000004",
  key: "a3910000-bbbb-4000-8000-000000000004",
};
const BUILTIN = {
  lead: "a3910000-4444-4000-8000-000000000005",
  agent: "a3910000-5555-4000-8000-000000000005",
  mission: "a3910000-6666-4000-8000-000000000005",
  run: "a3910000-7777-4000-8000-000000000005",
  version: "a3910000-aaaa-4000-8000-000000000005",
  key: "a3910000-bbbb-4000-8000-000000000005",
};
const FOLLOWUP = {
  lead: "a3910000-4444-4000-8000-000000000011",
  mission: "a3910000-6666-4000-8000-000000000011",
  run: "a3910000-7777-4000-8000-000000000011",
  key: "a3910000-bbbb-4000-8000-000000000011",
};
const ACTIVE_DIRECTION = {
  lead: "a3910000-4444-4000-8000-000000000016",
  mission: "a3910000-6666-4000-8000-000000000016",
  run: "a3910000-7777-4000-8000-000000000016",
  child: "a3910000-8888-4000-8000-000000000016",
  attempt: "a3910000-9999-4000-8000-000000000016",
  key: "a3910000-bbbb-4000-8000-000000000016",
};
const CONSUMPTION = {
  lead: "a3910000-4444-4000-8000-000000000018",
  mission: "a3910000-6666-4000-8000-000000000018",
  run: "a3910000-7777-4000-8000-000000000018",
  marker: "a3910000-aaaa-4000-8000-000000000018",
  key: "a3910000-bbbb-4000-8000-000000000018",
  direction: "先核对最新版报价，再联系客户",
};
const CONSUMPTION_MISSING = {
  lead: "a3910000-4444-4000-8000-000000000019",
  mission: "a3910000-6666-4000-8000-000000000019",
  run: "a3910000-7777-4000-8000-000000000019",
};
const DIRECTION_FENCE = {
  lead: "a3910000-4444-4000-8000-000000000015",
  mission: "a3910000-6666-4000-8000-000000000015",
  run: "a3910000-7777-4000-8000-000000000015",
};
const FEISHU = {
  user: "a3910000-1111-4000-8000-000000000006",
  lead: "a3910000-4444-4000-8000-000000000006",
  mission: "a3910000-6666-4000-8000-000000000006",
  run: "a3910000-7777-4000-8000-000000000006",
};
const INBOX = {
  lead: "a3910000-4444-4000-8000-000000000007",
  mission: "a3910000-6666-4000-8000-000000000007",
  run: "a3910000-7777-4000-8000-000000000007",
};
const FENCED_INBOX = {
  lead: "a3910000-4444-4000-8000-000000000008",
  mission: "a3910000-6666-4000-8000-000000000008",
  run: "a3910000-7777-4000-8000-000000000008",
};
const RECOVERY_INBOX = {
  lead: "a3910000-4444-4000-8000-000000000009",
  mission: "a3910000-6666-4000-8000-000000000009",
  run: "a3910000-7777-4000-8000-000000000009",
};
const DEAD_INBOX = {
  lead: "a3910000-4444-4000-8000-00000000000a",
  mission: "a3910000-6666-4000-8000-00000000000a",
  run: "a3910000-7777-4000-8000-00000000000a",
};
const QUESTION = {
  lead: "a3910000-4444-4000-8000-00000000000b",
  mission: "a3910000-6666-4000-8000-00000000000b",
  run: "a3910000-7777-4000-8000-00000000000b",
  key: "a3910000-bbbb-4000-8000-00000000000b",
};
const QUESTION_FENCE = {
  lead: "a3910000-4444-4000-8000-00000000000c",
  mission: "a3910000-6666-4000-8000-00000000000c",
  run: "a3910000-7777-4000-8000-00000000000c",
  key: "a3910000-bbbb-4000-8000-00000000000c",
};
const QUESTION_EXPIRED = {
  lead: "a3910000-4444-4000-8000-00000000000d",
  mission: "a3910000-6666-4000-8000-00000000000d",
  run: "a3910000-7777-4000-8000-00000000000d",
  key: "a3910000-bbbb-4000-8000-00000000000d",
};
const QUESTION_RACE = {
  lead: "a3910000-4444-4000-8000-000000000010",
  mission: "a3910000-6666-4000-8000-000000000010",
  run: "a3910000-7777-4000-8000-000000000010",
  key: "a3910000-bbbb-4000-8000-000000000010",
};
const PROPOSED = {
  lead: "a3910000-4444-4000-8000-00000000000e",
  agent: "a3910000-5555-4000-8000-00000000000e",
  mission: "a3910000-6666-4000-8000-00000000000e",
  run: "a3910000-7777-4000-8000-00000000000e",
  version: "a3910000-aaaa-4000-8000-00000000000e",
  proposal: "a3910000-bbbb-4000-8000-00000000000e",
};
const PROPOSED_CANCEL = {
  lead: "a3910000-4444-4000-8000-00000000000f",
  mission: "a3910000-6666-4000-8000-00000000000f",
  run: "a3910000-7777-4000-8000-00000000000f",
  proposal: "a3910000-bbbb-4000-8000-00000000000f",
};
const REPLAN = {
  session: "a3910000-2222-4000-8000-000000000013",
  contact: "a3910000-3333-4000-8000-000000000013",
  conversation: "a3910000-5555-4000-8000-000000000013",
  lead: "a3910000-4444-4000-8000-000000000013",
  mission: "a3910000-6666-4000-8000-000000000013",
  run: "a3910000-7777-4000-8000-000000000013",
  proposal: "a3910000-bbbb-4000-8000-000000000013",
  sendProposal: "a3910000-bbbb-4000-8000-000000000014",
  draft: "a3910000-dddd-4000-8000-000000000013",
  key: "a3910000-cccc-4000-8000-000000000013",
};

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${A.user}','internal-a@invariant.test'),('${B.user}','internal-b@invariant.test'),
      ('${FEISHU.user}','internal-colleague@invariant.test');
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${A.org}','mission-internal-a','Internal A','Internal A'),
      ('${B.org}','mission-internal-b','Internal B','Internal B');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
      ('${A.user}','${A.org}','manager',now()),('${B.user}','${B.org}','manager',now()),
      ('${FEISHU.user}','${A.org}','agent',now());
    insert into public.crm_pipelines(id,organization_id,name,slug) values
      ('${A.pipeline}','${A.org}','Pipeline A','internal-a'),
      ('${B.pipeline}','${B.org}','Pipeline B','internal-b');
    insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position) values
      ('${A.stage}','${A.org}','${A.pipeline}','Open','open',100),
      ('${B.stage}','${B.org}','${B.pipeline}','Open','open',100);
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title) values
      ('${A.lead}','${A.org}','${A.pipeline}','${A.stage}','Opportunity A'),
      ('${B.lead}','${B.org}','${B.pipeline}','${B.stage}','Opportunity B');
    insert into public.ai_agents(id,organization_id,name,system_prompt) values
      ('${A.agent}','${A.org}','Agent A','Invariant'),
      ('${B.agent}','${B.org}','Agent B','Invariant');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria) values
      ('${A.mission}','${A.org}','${A.lead}','${A.user}','Goal A','Accept A'),
      ('${B.mission}','${B.org}','${B.lead}','${B.user}','Goal B','Accept B');
    insert into public.ai_workbench_runs(id,organization_id,agent_id,mission_id,task,mode) values
      ('${A.run}','${A.org}','${A.agent}','${A.mission}','Task A','act'),
      ('${B.run}','${B.org}','${B.agent}','${B.mission}','Task B','act'),
      ('${A.run2}','${A.org}','${A.agent}','${A.mission}','Task A2','act');
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${CONTINUATION.session}','${A.org}','mission-internal-service','\\x00'::bytea);
    insert into public.ai_agent_versions
      (id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
    values ('${CONTINUATION.version}','${A.org}','${A.agent}',1,'Invariant','openai','test-model',
      '${CONTINUATION.session}','published');
    update public.ai_agents set published_version_id='${CONTINUATION.version}' where id='${A.agent}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${CONTINUATION.lead}','${A.org}','${A.pipeline}','${A.stage}','Continuation');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${CONTINUATION.mission}','${A.org}','${CONTINUATION.lead}','${A.user}',
        '推进交期确认','客户接受交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${CONTINUATION.run}','${A.org}','${A.agent}','${CONTINUATION.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待交付团队核对'
      where id='${CONTINUATION.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${FOLLOWUP.lead}','${A.org}','${A.pipeline}','${A.stage}','Manager Follow-up');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${FOLLOWUP.mission}','${A.org}','${FOLLOWUP.lead}','${A.user}',
        '推进报价','客户确认有效报价');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
      values ('${FOLLOWUP.run}','${A.org}','${A.agent}','${FOLLOWUP.mission}',
        '${A.user}','首次执行','act','completed',
        '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
        '{"versionId":"${CONTINUATION.version}"}');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${ACTIVE_DIRECTION.lead}','${A.org}','${A.pipeline}','${A.stage}','Active direction');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${ACTIVE_DIRECTION.mission}','${A.org}','${ACTIVE_DIRECTION.lead}','${A.user}',
        '核对商机并跟进客户','客户确认下一步');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
      values ('${ACTIVE_DIRECTION.run}','${A.org}','${A.agent}','${ACTIVE_DIRECTION.mission}',
        '${A.user}','首次执行','act','running',
        '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
        '{"versionId":"${CONTINUATION.version}","directionRevision":0}');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,parent_run_id,run_kind,specialist_key,collaboration_key,task,mode,status)
      values ('${ACTIVE_DIRECTION.child}','${A.org}','${A.agent}','${ACTIVE_DIRECTION.run}',
        'specialist','customer_evidence','manager-replan','读取客户证据','inspect','queued');
    select execution_attempt_id from public.fn_claim_ai_specialist_run(
      '${A.org}','${ACTIVE_DIRECTION.run}','${ACTIVE_DIRECTION.child}',
      '${ACTIVE_DIRECTION.attempt}',120);
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title) values
      ('${CONSUMPTION.lead}','${A.org}','${A.pipeline}','${A.stage}','Consumption evidence'),
      ('${CONSUMPTION_MISSING.lead}','${A.org}','${A.pipeline}','${A.stage}','Missing context');
    insert into public.ai_missions
      (id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria,current_direction,direction_revision)
    values
      ('${CONSUMPTION.mission}','${A.org}','${CONSUMPTION.lead}','${A.user}',
       '核对报价','客户确认','${CONSUMPTION.direction}',1),
      ('${CONSUMPTION_MISSING.mission}','${A.org}','${CONSUMPTION_MISSING.lead}','${A.user}',
       '核对报价','客户确认','先核对合同条款',1);
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,runtime_state)
    values
      ('${CONSUMPTION.run}','${A.org}','${A.agent}','${CONSUMPTION.mission}','${A.user}',
       '按负责人方向继续','act','running','{"versionId":"${CONTINUATION.version}","directionRevision":1}'),
      ('${CONSUMPTION_MISSING.run}','${A.org}','${A.agent}','${CONSUMPTION_MISSING.mission}',
       '${A.user}','按负责人方向继续','act','running',
       '{"versionId":"${CONTINUATION.version}","directionRevision":1}');
    insert into public.ai_mission_internal_inputs
      (id,organization_id,mission_id,request_key,actor_user_id,run_id,content_digest,direction_revision,kind)
    values ('${CONSUMPTION.marker}','${A.org}','${CONSUMPTION.mission}',
      '${CONSUMPTION.key}','${A.user}','${CONSUMPTION.run}',repeat('a',64),1,'manager_direction');
    insert into public.ai_agent_run_events
      (organization_id,run_id,sequence,event_type,payload)
    values ('${A.org}','${CONSUMPTION.run}',1,'run_started','{}'::jsonb);
    insert into public.ai_agents
      (id,organization_id,name,system_prompt,origin,builtin_key,model_binding_mode)
      values ('${BUILTIN.agent}','${A.org}','Built-in Agent','Invariant',
        'builtin','sales_operator','organization_default');
    insert into public.ai_agent_versions
      (id,organization_id,agent_id,version_number,system_prompt,provider,model,status)
      values ('${BUILTIN.version}','${A.org}','${BUILTIN.agent}',1,'Invariant',
        'openai','test-model','draft');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${BUILTIN.lead}','${A.org}','${A.pipeline}','${A.stage}','Built-in Mission');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${BUILTIN.mission}','${A.org}','${BUILTIN.lead}','${A.user}',
        '核对交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
      values ('${BUILTIN.run}','${A.org}','${BUILTIN.agent}','${BUILTIN.mission}',
        '${A.user}','首次执行','act','completed',
        '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
        '{"versionId":"${BUILTIN.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待内部补充'
      where id='${BUILTIN.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${FEISHU.lead}','${A.org}','${A.pipeline}','${A.stage}','Feishu Opportunity');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${FEISHU.mission}','${A.org}','${FEISHU.lead}','${A.user}',
        '核对 500 件交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${FEISHU.run}','${A.org}','${A.agent}','${FEISHU.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待飞书交期补充'
      where id='${FEISHU.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${INBOX.lead}','${A.org}','${A.pipeline}','${A.stage}','Inbox Opportunity');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${INBOX.mission}','${A.org}','${INBOX.lead}','${A.user}',
        '等待交付确认','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${INBOX.run}','${A.org}','${A.agent}','${INBOX.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待飞书内部回复'
      where id='${INBOX.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${FENCED_INBOX.lead}','${A.org}','${A.pipeline}','${A.stage}','Fenced Inbox Opportunity');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${FENCED_INBOX.mission}','${A.org}','${FENCED_INBOX.lead}','${A.user}',
        '等待交付确认','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${FENCED_INBOX.run}','${A.org}','${A.agent}','${FENCED_INBOX.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待飞书内部回复'
      where id='${FENCED_INBOX.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${RECOVERY_INBOX.lead}','${A.org}','${A.pipeline}','${A.stage}','Recovery Inbox Opportunity');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${RECOVERY_INBOX.mission}','${A.org}','${RECOVERY_INBOX.lead}','${A.user}',
        '等待交付确认','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${RECOVERY_INBOX.run}','${A.org}','${A.agent}','${RECOVERY_INBOX.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待飞书内部回复'
      where id='${RECOVERY_INBOX.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${DEAD_INBOX.lead}','${A.org}','${A.pipeline}','${A.stage}','Dead Inbox Opportunity');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${DEAD_INBOX.mission}','${A.org}','${DEAD_INBOX.lead}','${A.user}',
        '等待交付确认','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${DEAD_INBOX.run}','${A.org}','${A.agent}','${DEAD_INBOX.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待飞书内部回复'
      where id='${DEAD_INBOX.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${QUESTION.lead}','${A.org}','${A.pipeline}','${A.stage}','Question Opportunity');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${QUESTION.mission}','${A.org}','${QUESTION.lead}','${A.user}',
        '确认 500 件交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${QUESTION.run}','${A.org}','${A.agent}','${QUESTION.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待交付同事确认'
      where id='${QUESTION.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${QUESTION_FENCE.lead}','${A.org}','${A.pipeline}','${A.stage}','Fenced Question');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${QUESTION_FENCE.mission}','${A.org}','${QUESTION_FENCE.lead}','${A.user}',
        '确认交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${QUESTION_FENCE.run}','${A.org}','${A.agent}','${QUESTION_FENCE.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待交付同事确认'
      where id='${QUESTION_FENCE.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${QUESTION_EXPIRED.lead}','${A.org}','${A.pipeline}','${A.stage}','Expired Question');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${QUESTION_EXPIRED.mission}','${A.org}','${QUESTION_EXPIRED.lead}','${A.user}',
        '确认交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
    values ('${QUESTION_EXPIRED.run}','${A.org}','${A.agent}','${QUESTION_EXPIRED.mission}',
      '${A.user}','首次执行','act','completed',
      '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
      '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待交付同事确认'
      where id='${QUESTION_EXPIRED.mission}';
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${QUESTION_RACE.lead}','${A.org}','${A.pipeline}','${A.stage}',
        'Cancellation Race Question');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${QUESTION_RACE.mission}','${A.org}','${QUESTION_RACE.lead}','${A.user}',
        '核对交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,budget,runtime_state)
      values ('${QUESTION_RACE.run}','${A.org}','${A.agent}','${QUESTION_RACE.mission}',
        '${A.user}','首次执行','act','completed',
        '{"maxSteps":6,"tokenBudget":5000,"costBudgetCents":50}',
        '{"versionId":"${CONTINUATION.version}"}');
    update public.ai_missions set status='waiting_internal',blocked_reason='等待交付同事确认'
      where id='${QUESTION_RACE.mission}';
    insert into public.ai_agents
      (id,organization_id,name,system_prompt,origin,builtin_key,model_binding_mode)
      values ('${PROPOSED.agent}','${A.org}','Supervisor','Invariant',
        'builtin','crm_supervisor','organization_default');
    insert into public.ai_agent_versions
      (id,organization_id,agent_id,version_number,system_prompt,provider,model,status)
      values ('${PROPOSED.version}','${A.org}','${PROPOSED.agent}',1,'Invariant',
        'openai','test-model','draft');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${PROPOSED.lead}','${A.org}','${A.pipeline}','${A.stage}','Proposed Question');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${PROPOSED.mission}','${A.org}','${PROPOSED.lead}','${A.user}',
        '向同事核对交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,scope,runtime_state)
      values ('${PROPOSED.run}','${A.org}','${PROPOSED.agent}','${PROPOSED.mission}',
        '${A.user}','向同事确认 500 件交期','act','awaiting_confirmation',
        '{"leadId":"${PROPOSED.lead}"}','{"versionId":"${PROPOSED.version}"}');
    insert into public.ai_agent_action_proposals
      (id,organization_id,run_id,sequence,tool_name,tool_args,preview,status)
      values ('${PROPOSED.proposal}','${A.org}','${PROPOSED.run}',1,
        'ask_internal_colleague',
        '{"recipientUserId":"${FEISHU.user}","question":"请核对 500 件下周的实际交期"}',
        '{"requiresHumanConfirmation":true,"externalEffect":"feishu_internal_question"}',
        'pending');
    insert into public.ai_agent_run_states(organization_id,run_id,messages)
      values ('${A.org}','${PROPOSED.run}',
        '[{"role":"user","content":"核对交期"},
          {"role":"assistant","content":"已提出待审问题"}]');
    insert into public.ai_agent_run_events(organization_id,run_id,sequence,event_type,payload)
      values ('${A.org}','${PROPOSED.run}',1,'human_confirmation_requested',
        '{"proposalId":"${PROPOSED.proposal}"}');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('${PROPOSED_CANCEL.lead}','${A.org}','${A.pipeline}','${A.stage}',
        'Question Cancelled Before Send');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${PROPOSED_CANCEL.mission}','${A.org}','${PROPOSED_CANCEL.lead}','${A.user}',
        '核对交期后或取消','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,scope,runtime_state)
      values ('${PROPOSED_CANCEL.run}','${A.org}','${PROPOSED.agent}',
        '${PROPOSED_CANCEL.mission}','${A.user}','可能向同事提问','act',
        'awaiting_confirmation','{"leadId":"${PROPOSED_CANCEL.lead}"}',
        '{"versionId":"${PROPOSED.version}"}');
    insert into public.ai_agent_action_proposals
      (id,organization_id,run_id,sequence,tool_name,tool_args,preview,status)
      values ('${PROPOSED_CANCEL.proposal}','${A.org}','${PROPOSED_CANCEL.run}',1,
        'ask_internal_colleague',
        '{"recipientUserId":"${FEISHU.user}","question":"请核对取消测试商机的交期"}',
        '{"requiresHumanConfirmation":true,"externalEffect":"feishu_internal_question"}',
        'pending');
    insert into public.ai_agent_run_states(organization_id,run_id,messages)
      values ('${A.org}','${PROPOSED_CANCEL.run}',
        '[{"role":"user","content":"核对交期"}]');
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${REPLAN.session}','${A.org}','replan-invariant','\\x00'::bytea);
    insert into public.contacts(id,organization_id,display_name)
      values ('${REPLAN.contact}','${A.org}','Replan contact');
    insert into public.conversations(id,organization_id,contact_id,channel_session_id)
      values ('${REPLAN.conversation}','${A.org}','${REPLAN.contact}','${REPLAN.session}');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title)
      values ('${REPLAN.lead}','${A.org}','${A.pipeline}','${A.stage}',
        '${REPLAN.contact}','Direction Replaces Proposal');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${REPLAN.mission}','${A.org}','${REPLAN.lead}','${A.user}',
        '核对新的交期','客户确认交期');
    insert into public.ai_workbench_runs
      (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,scope,runtime_state)
      values ('${REPLAN.run}','${A.org}','${PROPOSED.agent}',
        '${REPLAN.mission}','${A.user}','向同事确认原交期','act',
        'awaiting_confirmation',
        '{"leadId":"${REPLAN.lead}","contactId":"${REPLAN.contact}","conversationId":"${REPLAN.conversation}"}',
        '{"versionId":"${PROPOSED.version}"}');
    insert into public.ai_agent_action_proposals
      (id,organization_id,run_id,sequence,tool_name,tool_args,preview,status)
      values ('${REPLAN.proposal}','${A.org}','${REPLAN.run}',1,
        'ask_internal_colleague',
        '{"recipientUserId":"${FEISHU.user}","question":"旧的交期问题"}',
        '{"requiresHumanConfirmation":true,"externalEffect":"feishu_internal_question"}',
        'pending');
    insert into public.ai_agent_action_proposals
      (id,organization_id,run_id,sequence,tool_name,tool_args,preview,status)
      values ('${REPLAN.sendProposal}','${A.org}','${REPLAN.run}',2,
        'send_message','{"body":"旧的客户回复"}',
        '{"requiresHumanConfirmation":true,"externalEffect":"customer_message"}',
        'pending');
    insert into public.ai_reply_drafts
      (id,organization_id,conversation_id,contact_id,agent_id,agent_version_id,
       channel_session_id,service_boundary,context_revision,operation_revision,
       status,original_body,workbench_run_id,workbench_proposal_id)
      select '${REPLAN.draft}','${A.org}','${REPLAN.conversation}',
        '${REPLAN.contact}','${PROPOSED.agent}','${PROPOSED.version}',
        '${REPLAN.session}','{}'::jsonb,c.reply_context_revision,a.operation_revision,
        'pending','旧的客户回复','${REPLAN.run}','${REPLAN.sendProposal}'
      from public.conversations c,public.ai_agents a
      where c.id='${REPLAN.conversation}' and a.id='${PROPOSED.agent}';
    insert into public.ai_agent_run_events(organization_id,run_id,sequence,event_type,payload)
      values ('${A.org}','${REPLAN.run}',1,'human_confirmation_requested',
        '{"proposalId":"${REPLAN.proposal}"}');
    insert into public.ai_internal_platform_tenants(organization_id,provider,tenant_key)
      values ('${A.org}','feishu','tenant-a'),('${B.org}','feishu','tenant-b');
    insert into public.ai_internal_platform_users
      (organization_id,provider,tenant_key,external_user_id,user_id)
      values ('${A.org}','feishu','tenant-a','ou-colleague','${FEISHU.user}');
    insert into public.ai_mission_internal_threads
      (organization_id,mission_id,provider,tenant_key,chat_id,root_message_id)
      values ('${A.org}','${FEISHU.mission}','feishu','tenant-a','oc-internal','om-question'),
        ('${A.org}','${INBOX.mission}','feishu','tenant-a','oc-internal','om-inbox-question'),
        ('${A.org}','${FENCED_INBOX.mission}','feishu','tenant-a','oc-internal','om-fenced-question'),
        ('${A.org}','${RECOVERY_INBOX.mission}','feishu','tenant-a','oc-internal','om-recovery-question'),
        ('${A.org}','${DEAD_INBOX.mission}','feishu','tenant-a','oc-internal','om-dead-question');
  `);
});

describe("internal Mission input ledger", () => {
  it("distinguishes manager directions from internal facts at the database boundary", () => {
    const result = sql(`
      do $$ begin
        begin
          insert into public.ai_mission_internal_inputs
            (organization_id,mission_id,request_key,run_id,content_digest,kind)
          values ('${A.org}','${A.mission}',gen_random_uuid(),'${A.run2}','${DIGEST}','customer_approval');
          raise exception 'unknown input kind accepted';
        exception when check_violation then null; end;
      end $$;
      select count(*) from pg_constraint
      where conname='ai_mission_internal_inputs_kind_check';
    `).split("\n").at(-1);
    expect(result).toBe("1");
  });

  it("enforces same-tenant mission/run links and one request key per mission", () => {
    const result = sql(`
      do $$ begin
        begin
          insert into public.ai_mission_internal_inputs
            (organization_id,mission_id,request_key,run_id,content_digest)
          values ('${A.org}','${B.mission}',gen_random_uuid(),'${A.run}','${DIGEST}');
          raise exception 'cross-tenant mission accepted';
        exception when foreign_key_violation then null; end;
        begin
          insert into public.ai_mission_internal_inputs
            (organization_id,mission_id,request_key,run_id,content_digest)
          values ('${A.org}','${A.mission}',gen_random_uuid(),'${B.run}','${DIGEST}');
          raise exception 'cross-tenant run accepted';
        exception when foreign_key_violation then null; end;
        begin
          insert into public.ai_mission_internal_inputs
            (organization_id,mission_id,request_key,run_id,content_digest)
          values ('${A.org}','${A.mission}',gen_random_uuid(),'${CONTINUATION.run}','${DIGEST}');
          raise exception 'same-tenant wrong-mission run accepted';
        exception when foreign_key_violation then null; end;
      end $$;
      insert into public.ai_mission_internal_inputs
        (organization_id,mission_id,request_key,actor_user_id,run_id,content_digest)
      values ('${A.org}','${A.mission}','${KEY}','${A.user}','${A.run}','${DIGEST}');
      do $$ begin
        begin
          insert into public.ai_mission_internal_inputs
            (organization_id,mission_id,request_key,run_id,content_digest)
          values ('${A.org}','${A.mission}','${KEY}','${A.run2}','${DIGEST}');
          raise exception 'duplicate request accepted';
        exception when unique_violation then null; end;
      end $$;
      select count(*) from public.ai_mission_internal_inputs
      where organization_id='${A.org}' and mission_id='${A.mission}';
    `).split("\n").at(-1);
    expect(result).toBe("1");
  });

  it("keeps the ledger service-only and free of raw response text", () => {
    const privileges = sql(`
      select has_table_privilege('authenticated','public.ai_mission_internal_inputs','select')::int || ',' ||
             has_table_privilege('authenticated','public.ai_mission_internal_inputs','insert')::int || ',' ||
             has_table_privilege('anon','public.ai_mission_internal_inputs','select')::int || ',' ||
             has_table_privilege('service_role','public.ai_mission_internal_inputs','insert')::int;
    `).split("\n").at(-1);
    expect(privileges).toBe("0,0,0,1");
    const columns = sql(`
      select string_agg(column_name, ',') from information_schema.columns
      where table_schema='public' and table_name='ai_mission_internal_inputs';
    `);
    expect(columns.split(",")).toContain("content_digest");
    expect(columns.split(",")).not.toContain("content");
  });

  it("persists and queues one real continuation transaction, then replays a retry", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    const content = "交付团队确认下周二可以发货";
    const input = {
      organizationId: A.org,
      missionId: CONTINUATION.mission,
      actorUserId: A.user,
      requestKey: CONTINUATION.key,
      content,
    };
    try {
      const [first, concurrentRetry] = await Promise.all([
        submitMissionInternalResponse(pool, input),
        submitMissionInternalResponse(pool, input),
      ]);
      expect(first.runId).toBe(concurrentRetry.runId);
      expect([first.replayed, concurrentRetry.replayed].sort()).toEqual([false, true]);
      expect(first.missionStatus).toBe("queued");
      const retry = await submitMissionInternalResponse(pool, input);
      expect(retry).toMatchObject({ runId: first.runId, replayed: true });
      const { rows } = await pool.query<{
        mission_status: string;
        root_count: number;
        marker_count: number;
        job_count: number;
        event_count: number;
        task: string;
      }>(`
        select m.status as mission_status,
          (select count(*)::int from public.ai_workbench_runs r
           where r.organization_id=m.organization_id and r.mission_id=m.id and r.run_kind='root') as root_count,
          (select count(*)::int from public.ai_mission_internal_inputs i
           where i.organization_id=m.organization_id and i.mission_id=m.id) as marker_count,
          (select count(*)::int from public.job_queue j
           where j.organization_id=m.organization_id and j.source_event_id=$2) as job_count,
          (select count(*)::int from public.ai_agent_run_events e
           where e.organization_id=m.organization_id and e.run_id=$2) as event_count,
          (select task from public.ai_workbench_runs where id=$2) as task
        from public.ai_missions m where m.organization_id=$1 and m.id=$3`,
        [A.org, first.runId, CONTINUATION.mission],
      );
      expect(rows[0]).toMatchObject({
        mission_status: "queued", root_count: 2, marker_count: 1, job_count: 1, event_count: 1,
      });
      expect(rows[0]?.task).toContain(content);
      const { rows: provenance } = await pool.query<{
        marker_id: string;
        event_input_id: string;
        event_payload: string;
      }>(`
        select i.id as marker_id,
          e.payload->>'internalInputId' as event_input_id,
          e.payload::text as event_payload
        from public.ai_mission_internal_inputs i
        join public.ai_agent_run_events e on e.organization_id=i.organization_id
          and e.run_id=i.run_id and e.sequence=1
        where i.organization_id=$1 and i.run_id=$2`, [A.org, first.runId]);
      expect(provenance[0]?.event_input_id).toBe(provenance[0]?.marker_id);
      expect(provenance[0]?.event_payload).not.toContain(content);
      await expect(submitMissionInternalResponse(pool, { ...input, content: "另一个交期" }))
        .rejects.toMatchObject({ code: "source_conflict" });
      await expect(submitMissionInternalResponse(pool, { ...input,
        organizationId: B.org, actorUserId: B.user }))
        .rejects.toMatchObject({ code: "not_found" });
    } finally {
      await pool.end();
    }
  });

  it("serializes a reversible Mission write and refuses a superseded direction", async () => {
    sql(`
      insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
        values ('${DIRECTION_FENCE.lead}','${A.org}','${A.pipeline}','${A.stage}','Before direction');
      insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
        values ('${DIRECTION_FENCE.mission}','${A.org}','${DIRECTION_FENCE.lead}','${A.user}',
          '核对报价','客户确认报价');
      insert into public.ai_workbench_runs
        (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,runtime_state)
        values ('${DIRECTION_FENCE.run}','${A.org}','${A.agent}','${DIRECTION_FENCE.mission}',
          '${A.user}','核对商机','act','running','{"directionRevision":0}');
    `);
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 3,
    });
    const contender = await pool.connect();
    const fenceInput = { organizationId: A.org, missionId: DIRECTION_FENCE.mission,
      runId: DIRECTION_FENCE.run, expectedRevision: 0 };
    try {
      await withMissionDirectionWriteFence(pool, fenceInput, async () => {
        await contender.query("begin");
        const { rows: lock } = await contender.query<{ available: boolean }>(
          "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as available",
          [missionDirectionLockKey(A.org, DIRECTION_FENCE.mission)],
        );
        expect(lock[0]?.available).toBe(false);
        await contender.query("rollback");
        await pool.query(
          "update public.crm_leads set title='Written before direction' where organization_id=$1 and id=$2",
          [A.org, DIRECTION_FENCE.lead],
        );
      });
      await pool.query(
        `update public.ai_missions set direction_revision=1,current_direction='负责人要求核对新版报价'
         where organization_id=$1 and id=$2`,
        [A.org, DIRECTION_FENCE.mission],
      );
      let wroteAfterDirection = false;
      await expect(withMissionDirectionWriteFence(pool, fenceInput, async () => {
        wroteAfterDirection = true;
      })).rejects.toMatchObject({ code: "revision_changed" });
      expect(wroteAfterDirection).toBe(false);
      await expect(withMissionDirectionWriteFence(pool,
        { ...fenceInput, organizationId: B.org }, async () => undefined))
        .rejects.toMatchObject({ code: "run_inactive" });
      await pool.query(
        `insert into public.ai_agent_action_proposals
           (organization_id,run_id,sequence,tool_name,tool_args,status)
         values ($1,$2,1,'crm_update_lead','{}'::jsonb,'pending'),
                ($1,$2,2,'send_message','{}'::jsonb,'pending')`,
        [A.org, DIRECTION_FENCE.run],
      );
      const stoppedByWrongOrg = await stopMissionRunAfterDirectionFence(pool, {
        organizationId: B.org, missionId: DIRECTION_FENCE.mission,
        runId: DIRECTION_FENCE.run,
      }, new MissionDirectionFenceError("revision_changed"));
      expect(stoppedByWrongOrg).toBe(false);
      const stopped = await stopMissionRunAfterDirectionFence(pool, {
        organizationId: A.org, missionId: DIRECTION_FENCE.mission,
        runId: DIRECTION_FENCE.run,
      }, new MissionDirectionFenceError("revision_changed"));
      expect(stopped).toBe(true);
      expect(await stopMissionRunAfterDirectionFence(pool, {
        organizationId: A.org, missionId: DIRECTION_FENCE.mission,
        runId: DIRECTION_FENCE.run,
      }, new MissionDirectionFenceError("revision_changed"))).toBe(false);
      const { rows: stoppedState } = await pool.query<{
        run_status: string; error_code: string; mission_status: string;
        proposal_statuses: string[]; terminal_events: number;
      }>(
        `select r.status as run_status,r.error_code,m.status as mission_status,
                array(select p.status from public.ai_agent_action_proposals p
                      where p.organization_id=r.organization_id and p.run_id=r.id
                      order by p.sequence) as proposal_statuses,
                (select count(*)::int from public.ai_agent_run_events e
                 where e.organization_id=r.organization_id and e.run_id=r.id
                   and e.event_type='run_partial') as terminal_events
         from public.ai_workbench_runs r
         join public.ai_missions m on m.id=r.mission_id and m.organization_id=r.organization_id
         where r.organization_id=$1 and r.id=$2`,
        [A.org, DIRECTION_FENCE.run],
      );
      expect(stoppedState[0]).toMatchObject({
        run_status: "partial", error_code: "mission_direction_revision_changed",
        mission_status: "needs_review", proposal_statuses: ["cancelled", "cancelled"],
        terminal_events: 1,
      });
      const { rows: lead } = await pool.query<{ title: string }>(
        "select title from public.crm_leads where organization_id=$1 and id=$2",
        [A.org, DIRECTION_FENCE.lead],
      );
      expect(lead[0]?.title).toBe("Written before direction");
    } finally {
      await contender.query("rollback").catch(() => undefined);
      contender.release();
      await pool.end();
    }
  });

  it("atomically pauses old sends and starts one trusted manager-direction Run", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    const content = "改用新的报价依据，先核对客户需求";
    const input = { organizationId: A.org, missionId: FOLLOWUP.mission,
      actorUserId: A.user, requestKey: FOLLOWUP.key, content };
    try {
      const [first, concurrentRetry] = await Promise.all([
        submitMissionManagerDirection(pool, input),
        submitMissionManagerDirection(pool, input),
      ]);
      expect(first.runId).toBe(concurrentRetry.runId);
      expect([first.replayed, concurrentRetry.replayed].sort()).toEqual([false, true]);
      expect(first.missionStatus).toBe("queued");
      const { rows } = await pool.query<{
        paused: boolean; status: string; marker_kind: string; task: string;
        command_count: number; run_count: number; event_payload: string;
        current_direction: string; direction_revision: string; run_direction_revision: string;
      }>(`
        select m.customer_send_paused as paused,m.status,
          m.current_direction,m.direction_revision,
          i.kind as marker_kind,r.task,
          r.runtime_state->>'directionRevision' as run_direction_revision,
          (select count(*)::int from public.ai_mission_commands c
           where c.organization_id=m.organization_id and c.mission_id=m.id) as command_count,
          (select count(*)::int from public.ai_workbench_runs root
           where root.organization_id=m.organization_id and root.mission_id=m.id) as run_count,
          e.payload::text as event_payload
        from public.ai_missions m
        join public.ai_mission_internal_inputs i
          on i.organization_id=m.organization_id and i.mission_id=m.id
        join public.ai_workbench_runs r on r.organization_id=i.organization_id and r.id=i.run_id
        join public.ai_agent_run_events e on e.organization_id=r.organization_id
          and e.run_id=r.id and e.sequence=1
        where m.organization_id=$1 and m.id=$2`, [A.org, FOLLOWUP.mission]);
      expect(rows[0]).toMatchObject({ paused: true, status: "queued",
        marker_kind: "manager_direction", command_count: 1, run_count: 2,
        current_direction: content });
      expect(Number(rows[0]?.direction_revision)).toBe(1);
      expect(rows[0]?.run_direction_revision).toBe("1");
      expect(rows[0]?.task).toContain(content);
      expect(rows[0]?.event_payload).not.toContain(content);
      await expect(submitMissionManagerDirection(pool, { ...input, content: "另一个报价方案" }))
        .rejects.toMatchObject({ code: "source_conflict" });
      const { rows: resumed } = await pool.query<{ result: { result: string } }>(
        `select public.fn_set_ai_mission_send_policy($1,$2,$3,$4,$5,$6) as result`,
        [A.org, FOLLOWUP.mission, A.user,
          "a3910000-bbbb-4000-8000-000000000012",
          "resume_customer_send", "负责人已完成新的发送策略核对。"],
      );
      expect(resumed[0]?.result.result).toBe("changed");
      expect(await submitMissionManagerDirection(pool, input))
        .toMatchObject({ runId: first.runId, replayed: true, customerSendPaused: false });
      await expect(submitMissionManagerDirection(pool, { ...input,
        organizationId: B.org, actorUserId: B.user }))
        .rejects.toMatchObject({ code: "not_found" });
    } finally {
      await pool.end();
    }
  });

  it("stops a running root and specialist before accepting a new manager direction", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const changed = await submitMissionManagerDirection(pool, {
        organizationId: A.org, missionId: ACTIVE_DIRECTION.mission,
        actorUserId: A.user, requestKey: ACTIVE_DIRECTION.key,
        content: "停止旧分析，重新核对客户最新需求和商机状态",
      });
      expect(changed).toMatchObject({ missionStatus: "queued", customerSendPaused: true });
      const { rows } = await pool.query<{
        mission_status: string; root_status: string; child_status: string;
        child_lease: Date | null; cancelled_events: string;
      }>(`select m.status as mission_status,r.status as root_status,
                c.status as child_status,c.execution_lease_expires_at as child_lease,
                (select count(*)::text from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id in ($2,$3)
                   and e.event_type='run_cancelled') as cancelled_events
           from public.ai_missions m
           join public.ai_workbench_runs r on r.organization_id=m.organization_id and r.id=$2
           join public.ai_workbench_runs c on c.organization_id=r.organization_id and c.id=$3
           where m.organization_id=$1 and m.id=$4`,
        [A.org, ACTIVE_DIRECTION.run, ACTIVE_DIRECTION.child, ACTIVE_DIRECTION.mission]);
      expect(rows[0]).toMatchObject({ mission_status: "queued", root_status: "cancelled",
        child_status: "cancelled", child_lease: null, cancelled_events: "2" });
      const { rows: reclaimed } = await pool.query(
        `select execution_attempt_id from public.fn_claim_ai_specialist_run($1,$2,$3,$4,120)`,
        [A.org, ACTIVE_DIRECTION.run, ACTIVE_DIRECTION.child,
          "a3910000-9999-4000-8000-000000000017"],
      );
      expect(reclaimed).toEqual([]);
      await expect(pool.query(
        `insert into public.ai_workbench_runs
         (organization_id,agent_id,parent_run_id,run_kind,specialist_key,collaboration_key,task,mode)
         values ($1,$2,$3,'specialist','sales_evidence','manager-replan','迟到的子任务','inspect')`,
        [A.org, A.agent, ACTIVE_DIRECTION.run],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(
        `insert into public.ai_agent_action_proposals
         (organization_id,run_id,sequence,tool_name,tool_args,preview,status)
         values ($1,$2,1,'crm_update_lead','{}'::jsonb,'{}'::jsonb,'pending')`,
        [A.org, ACTIVE_DIRECTION.run],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.end();
    }
  });

  it("commits a direction acknowledgement only with the successful private transcript", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    const messages = [
      { role: "user" as const,
        content: `负责人新方向：${JSON.stringify(CONSUMPTION.direction)}` },
      { role: "assistant" as const, content: "已读取并核对最新报价" },
    ];
    const events = [{ type: "model_context_consumed" as const,
      data: { probeId: `manager-direction:${CONSUMPTION.mission}:1` } }];
    try {
      expect(await loadMissionDirectionContextProbe(pool, {
        organizationId: A.org, missionId: CONSUMPTION.mission,
        runId: CONSUMPTION.run, expectedRevision: 1,
      })).toEqual({ id: `manager-direction:${CONSUMPTION.mission}:1`,
        userText: JSON.stringify(CONSUMPTION.direction) });
      await expect(loadMissionDirectionContextProbe(pool, {
        organizationId: B.org, missionId: CONSUMPTION.mission,
        runId: CONSUMPTION.run, expectedRevision: 1,
      })).rejects.toMatchObject({ code: "run_inactive" });
      await expect(loadMissionDirectionContextProbe(pool, {
        organizationId: A.org, missionId: CONSUMPTION.mission,
        runId: CONSUMPTION.run, expectedRevision: 0,
      })).rejects.toMatchObject({ code: "revision_changed" });
      const input = { organizationId: A.org, missionId: CONSUMPTION.mission,
        runId: CONSUMPTION.run, expectedRevision: 1, messages, events };
      expect(await persistMissionRunMessagesAndDirectionAck(pool, input))
        .toEqual({ acknowledged: true });
      expect(await persistMissionRunMessagesAndDirectionAck(pool, input))
        .toEqual({ acknowledged: false });
      const { rows } = await pool.query<{
        consumed_revision: string; consumed_at: Date | null;
        state_messages: unknown; event_count: string; event_payload: string;
      }>(`select m.direction_consumed_revision::text as consumed_revision,i.consumed_at,
                s.messages as state_messages,
                (select count(*)::text from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$2
                   and e.event_type='manager_direction_consumed') as event_count,
                (select e.payload::text from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$2
                   and e.event_type='manager_direction_consumed') as event_payload
           from public.ai_missions m
           join public.ai_mission_internal_inputs i
             on i.organization_id=m.organization_id and i.mission_id=m.id
           join public.ai_agent_run_states s
             on s.organization_id=i.organization_id and s.run_id=i.run_id
           where m.organization_id=$1 and m.id=$3`,
        [A.org, CONSUMPTION.run, CONSUMPTION.mission]);
      expect(rows[0]).toMatchObject({ consumed_revision: "1", event_count: "1" });
      expect(rows[0]?.consumed_at).not.toBeNull();
      expect(rows[0]?.state_messages).toEqual(messages);
      expect(rows[0]?.event_payload).not.toContain(CONSUMPTION.direction);
      await expect(persistMissionRunMessagesAndDirectionAck(pool, {
        ...input, organizationId: B.org,
      })).rejects.toMatchObject({ code: "run_inactive" });
    } finally {
      await pool.end();
    }
  });

  it("does not persist state or acknowledge a direction missing from model context", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      await expect(persistMissionRunMessagesAndDirectionAck(pool, {
        organizationId: A.org, missionId: CONSUMPTION_MISSING.mission,
        runId: CONSUMPTION_MISSING.run, expectedRevision: 1,
        messages: [{ role: "user", content: "旧任务，不含负责人新方向" },
          { role: "assistant", content: "继续旧计划" }],
        events: [{ type: "model_context_consumed",
          data: { probeId: `manager-direction:${CONSUMPTION_MISSING.mission}:1` } }],
      })).rejects.toMatchObject({ code: "context_missing" });
      const { rows } = await pool.query<{ consumed_revision: string; state_count: string }>(
        `select m.direction_consumed_revision::text as consumed_revision,
                (select count(*)::text from public.ai_agent_run_states s
                 where s.organization_id=$1 and s.run_id=$2) as state_count
         from public.ai_missions m where m.organization_id=$1 and m.id=$3`,
        [A.org, CONSUMPTION_MISSING.run, CONSUMPTION_MISSING.mission],
      );
      expect(rows[0]).toEqual({ consumed_revision: "0", state_count: "0" });
    } finally {
      await pool.end();
    }
  });

  it("supersedes a pending approval without carrying its authorization into the next Run", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 3,
    });
    const input = { organizationId: A.org, missionId: REPLAN.mission,
      actorUserId: A.user, requestKey: REPLAN.key,
      content: "停止旧的交期提问，按新的合同依据重新核查" };
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from public.ai_workbench_runs where id=$1 for update`,
        [REPLAN.run]);
      await expect(submitMissionManagerDirection(pool, input))
        .rejects.toMatchObject({ code: "state_conflict" });
      const { rows: untouched } = await pool.query<{
        status: string; paused: boolean; proposal_status: string;
      }>(`select m.status,m.customer_send_paused as paused,p.status as proposal_status
          from public.ai_missions m join public.ai_agent_action_proposals p
            on p.organization_id=m.organization_id and p.run_id=$2
          where m.organization_id=$1 and m.id=$3`,
        [A.org, REPLAN.run, REPLAN.mission]);
      expect(untouched[0]).toMatchObject({ status: "waiting_approval", paused: false,
        proposal_status: "pending" });
      await holder.query("commit");

      const first = await submitMissionManagerDirection(pool, input);
      expect(first).toMatchObject({ missionStatus: "queued", customerSendPaused: true,
        replayed: false });
      expect(await submitMissionManagerDirection(pool, input))
        .toMatchObject({ runId: first.runId, replayed: true });
      const { rows: state } = await pool.query<{
        mission_status: string; old_run_status: string; old_run_error: string;
        proposal_status: string; old_events: number; new_runs: number;
        cancelled_proposals: number; stale_drafts: number;
        pending_questions: number; marker_kind: string;
      }>(`select m.status as mission_status,r.status as old_run_status,
            r.error_code as old_run_error,p.status as proposal_status,
            (select count(*)::int from public.ai_agent_run_events e
             where e.organization_id=$1 and e.run_id=$2 and e.event_type='run_cancelled') as old_events,
            (select count(*)::int from public.ai_workbench_runs n
             where n.organization_id=$1 and n.mission_id=$3 and n.status='queued') as new_runs,
            (select count(*)::int from public.ai_agent_action_proposals old
             where old.organization_id=$1 and old.run_id=$2 and old.status='cancelled') as cancelled_proposals,
            (select count(*)::int from public.ai_reply_drafts d
             where d.organization_id=$1 and d.workbench_run_id=$2 and d.status='stale'
               and d.error_code='mission_direction_replaced') as stale_drafts,
            (select count(*)::int from public.ai_internal_question_outbox q
             where q.organization_id=$1 and q.mission_id=$3) as pending_questions,
            i.kind as marker_kind
          from public.ai_missions m
          join public.ai_workbench_runs r on r.organization_id=m.organization_id and r.id=$2
          join public.ai_agent_action_proposals p on p.organization_id=r.organization_id and p.run_id=r.id
          join public.ai_mission_internal_inputs i on i.organization_id=m.organization_id
            and i.mission_id=m.id
          where m.organization_id=$1 and m.id=$3`,
        [A.org, REPLAN.run, REPLAN.mission]);
      expect(state[0]).toMatchObject({ mission_status: "queued", old_run_status: "cancelled",
        old_run_error: "manager_direction_replaced", proposal_status: "cancelled",
        old_events: 1, new_runs: 1, cancelled_proposals: 2, stale_drafts: 1,
        pending_questions: 0,
        marker_kind: "manager_direction" });
      const { rows: replyFence } = await pool.query<{ current: boolean }>(
        `select public.fn_reply_context_current($1,$2) as current`,
        [A.org, REPLAN.draft]);
      expect(replyFence[0]?.current).toBe(false);
      const { rows: staleApproval } = await pool.query<{ id: string }>(
        `update public.ai_workbench_runs set status='running'
         where organization_id=$1 and id=$2 and status='awaiting_confirmation' returning id`,
        [A.org, REPLAN.run]);
      expect(staleApproval).toEqual([]);
      await expect(submitMissionManagerDirection(pool, { ...input,
        organizationId: B.org, actorUserId: B.user }))
        .rejects.toMatchObject({ code: "not_found" });
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
      await pool.end();
    }
  });

  it("resumes a locked built-in draft version and fences a paused Agent before Worker side effects", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      expect(await loadMissionContinuationAgent(pool, A.org, BUILTIN.agent, BUILTIN.version))
        .toMatchObject({ operationRevision: expect.any(Number) });
      expect(await loadMissionContinuationAgent(pool, B.org, BUILTIN.agent, BUILTIN.version)).toBeNull();
      const result = await submitMissionInternalResponse(pool, {
        organizationId: A.org,
        missionId: BUILTIN.mission,
        actorUserId: A.user,
        requestKey: BUILTIN.key,
        content: "交付团队确认下周二可安排发货",
      });
      expect(result).toMatchObject({ missionStatus: "queued", replayed: false });
      const claim = (await pool.query<{ id: string; locked_at: string }>(
        `update public.job_queue
         set status='running',locked_by='mission-built-in-test',locked_at=now()
         where organization_id=$1 and source_event_id=$2
         returning id,locked_at::text`, [A.org, result.runId],
      )).rows[0];
      expect(claim).toBeDefined();
      const job = {
        id: claim!.id, organization_id: A.org, locked_by: "mission-built-in-test",
        claim_acquired_at: claim!.locked_at,
      } as never;
      await expect(assertWorkbenchJobLease(pool, job, "mission-built-in-test")).resolves.toBeUndefined();
      await pool.query(
        "update public.ai_agents set paused_at=now() where organization_id=$1 and id=$2",
        [A.org, BUILTIN.agent],
      );
      expect(await loadMissionContinuationAgent(pool, A.org, BUILTIN.agent, BUILTIN.version)).toBeNull();
      await expect(assertWorkbenchJobLease(pool, job, "mission-built-in-test"))
        .rejects.toThrow("workbench_job_lease_lost");
    } finally {
      await pool.end();
    }
  });

  it("rejects cross-tenant Feishu mappings and hides them from app roles", () => {
    expect(sql(`
      do $$ begin
        begin
          insert into public.ai_internal_platform_users
            (organization_id,provider,tenant_key,external_user_id,user_id)
          values ('${B.org}','feishu','tenant-a','ou-forged','${B.user}');
          raise exception 'cross-org user link accepted';
        exception when foreign_key_violation then null; end;
        begin
          insert into public.ai_mission_internal_threads
            (organization_id,mission_id,provider,tenant_key,chat_id,root_message_id)
          values ('${B.org}','${FEISHU.mission}','feishu','tenant-b','oc-forged','om-forged');
          raise exception 'cross-org thread accepted';
        exception when foreign_key_violation then null; end;
      end $$;
      select has_table_privilege('authenticated','public.ai_internal_platform_users','select')::int || ',' ||
        has_table_privilege('authenticated','public.ai_mission_internal_threads','insert')::int || ',' ||
        has_table_privilege('service_role','public.ai_mission_internal_threads','insert')::int;
    `).split("\n").at(-1)).toBe("0,0,1");
  });

  it("wakes once from a mapped Feishu reply without granting the sender execution authority", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    const event = {
      kind: "internal_text" as const,
      tenantKey: "tenant-a", eventId: "evt-500", openId: "ou-colleague",
      chatId: "oc-internal", rootMessageId: "om-question",
      messageId: "om-reply", content: "月底可交付 500 件，但报价仍需审批",
    };
    try {
      expect(await submitFeishuMissionText(pool, { ...event, openId: "ou-unknown" }))
        .toBeNull();
      expect(await submitFeishuMissionText(pool, { ...event, tenantKey: "tenant-b" }))
        .toBeNull();
      const [one, two] = await Promise.all([
        submitFeishuMissionText(pool, event), submitFeishuMissionText(pool, event),
      ]);
      expect([one?.replayed, two?.replayed].sort()).toEqual([false, true]);
      const first = one?.replayed ? two : one;
      expect(first).toMatchObject({ replayed: false });
      expect(await submitFeishuMissionText(pool, event))
        .toMatchObject({ runId: first!.runId, replayed: true });
      const { rows } = await pool.query<{
        run_actor: string; fact_actor: string; source_event_id: string;
        task: string; count: number;
      }>(`
        select r.actor_user_id as run_actor,i.actor_user_id as fact_actor,
          i.source_event_id,r.task,
          (select count(*)::int from public.ai_workbench_runs
           where mission_id=$1 and run_kind='root') as count
        from public.ai_workbench_runs r
        join public.ai_mission_internal_inputs i on i.run_id=r.id
        where r.id=$2`, [FEISHU.mission, first!.runId]);
      expect(rows[0]).toMatchObject({ run_actor: A.user, fact_actor: FEISHU.user,
        source_event_id: event.eventId, count: 2 });
      expect(rows[0]?.task).toContain(event.content);
      expect(rows[0]?.task).toContain("不等于报价、外发或其他外部动作的批准");
      await expect(submitFeishuMissionText(pool, { ...event, content: "另一个交期依据" }))
        .rejects.toMatchObject({ code: "source_conflict" });
      const globalDedup = sql(`
        do $$ begin
          begin
            insert into public.ai_mission_internal_inputs
              (organization_id,mission_id,request_key,run_id,content_digest,
               source_provider,source_tenant_key,source_event_id)
            values ('${A.org}','${A.mission}',gen_random_uuid(),'${A.run}',
              '${DIGEST}','feishu','tenant-a','evt-500');
            raise exception 'same Feishu event reused for another mission';
          exception when unique_violation then null; end;
        end $$;
        select count(*) from public.ai_mission_internal_inputs
        where source_provider='feishu' and source_tenant_key='tenant-a' and source_event_id='evt-500';
      `).split("\n").at(-1);
      expect(globalDedup).toBe("1");
      await pool.query(
        `update public.user_organizations set revoked_at=now()
         where organization_id=$1 and user_id=$2`, [A.org, FEISHU.user],
      );
      expect(await submitFeishuMissionText(pool, event)).toBeNull();
      await pool.query(
        `update public.user_organizations set revoked_at=null
         where organization_id=$1 and user_id=$2`, [A.org, FEISHU.user],
      );
    } finally {
      await pool.end();
    }
  });

  it("acks only after encrypted inbox+job commit; Worker resumes once and scrubs plaintext", async () => {
    const priorKey = process.env.AI_CRED_AES_KEY;
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    const event = {
      kind: "internal_text" as const,
      tenantKey: "tenant-a", eventId: "evt-inbox-500", openId: "ou-colleague",
      chatId: "oc-internal", rootMessageId: "om-inbox-question",
      messageId: "om-inbox-reply", content: "500 件月底能交，但价格要再确认",
    };
    try {
      const [a, b] = await Promise.all([
        persistFeishuMissionEvent(pool, event), persistFeishuMissionEvent(pool, event),
      ]);
      expect(a?.inboxId).toBe(b?.inboxId);
      expect([a?.replayed, b?.replayed].sort()).toEqual([false, true]);
      const inboxId = a!.inboxId;
      const before = await pool.query<{
        status: string; content_ciphertext: Buffer; roots: number; jobs: number;
      }>(`
        select i.status,i.content_ciphertext,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=i.organization_id and mission_id=i.mission_id
             and run_kind='root') as roots,
          (select count(*)::int from public.job_queue
           where organization_id=i.organization_id and source_event_id=i.id
             and kind='internal_im_event') as jobs
        from public.ai_internal_event_inbox i where i.id=$1`, [inboxId]);
      expect(before.rows[0]).toMatchObject({ status: "pending", roots: 1, jobs: 1 });
      expect(before.rows[0]!.content_ciphertext.toString("utf8")).not.toContain(event.content);
      const { rows: claimed } = await pool.query<{
        id: string; locked_by: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='feishu-inbox-test',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_event'
        returning id,locked_by,locked_at::text as claim_acquired_at`, [A.org, inboxId]);
      const job = { id: claimed[0]!.id, organization_id: A.org, kind: "internal_im_event",
        payload: { inboxId }, locked_by: claimed[0]!.locked_by,
        claim_acquired_at: claimed[0]!.claim_acquired_at } as never;
      await runFeishuInboxJob(job, pool);
      await runFeishuInboxJob(job, pool);
      const after = await pool.query<{
        status: string; content_ciphertext: Buffer | null;
        processed_run_id: string; roots: number; run_actor: string;
      }>(`
        select i.status,i.content_ciphertext,i.processed_run_id,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=i.organization_id and mission_id=i.mission_id
             and run_kind='root') as roots,
          (select actor_user_id from public.ai_workbench_runs
           where id=i.processed_run_id) as run_actor
        from public.ai_internal_event_inbox i where i.id=$1`, [inboxId]);
      expect(after.rows[0]).toMatchObject({ status: "processed", content_ciphertext: null,
        roots: 2, run_actor: A.user });
      expect(after.rows[0]?.processed_run_id).toBeTruthy();
      expect(await persistFeishuMissionEvent(pool, event))
        .toMatchObject({ inboxId, replayed: true });
      await expect(persistFeishuMissionEvent(pool, { ...event, content: "交期改为下个月" }))
        .rejects.toMatchObject({ code: "source_conflict" });
    } finally {
      await pool.end();
      if (priorKey === undefined) delete process.env.AI_CRED_AES_KEY;
      else process.env.AI_CRED_AES_KEY = priorKey;
    }
  });

  it("fences a stale inbox Worker and lets the current claim resume exactly once", async () => {
    const priorKey = process.env.AI_CRED_AES_KEY;
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const event = {
        kind: "internal_text" as const,
        tenantKey: "tenant-a", eventId: "evt-fenced-500", openId: "ou-colleague",
        chatId: "oc-internal", rootMessageId: "om-fenced-question",
        messageId: "om-fenced-reply", content: "交付确认 500 件月底可以发货",
      };
      const intake = await persistFeishuMissionEvent(pool, event);
      expect(intake).toMatchObject({ replayed: false });
      const inboxId = intake!.inboxId;
      const { rows: firstClaims } = await pool.query<{
        id: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='stale-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_event'
        returning id,locked_at::text as claim_acquired_at`, [A.org, inboxId]);
      const oldJob = {
        id: firstClaims[0]!.id, organization_id: A.org, kind: "internal_im_event",
        payload: { inboxId }, locked_by: "stale-worker",
        claim_acquired_at: firstClaims[0]!.claim_acquired_at,
      } as never;
      const { rows: currentClaims } = await pool.query<{ claim_acquired_at: string }>(`
        update public.job_queue set locked_by='current-worker',
          locked_at=clock_timestamp() + interval '1 second',attempts=attempts+1
        where organization_id=$1 and id=$2
        returning locked_at::text as claim_acquired_at`, [A.org, firstClaims[0]!.id]);
      await expect(runFeishuInboxJob(oldJob, pool))
        .rejects.toThrow("internal_im_job_lease_lost");
      const { rows: before } = await pool.query<{
        status: string; roots: number;
      }>(`
        select i.status,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=i.organization_id and mission_id=i.mission_id
             and run_kind='root') as roots
        from public.ai_internal_event_inbox i where i.id=$1`, [inboxId]);
      expect(before[0]).toMatchObject({ status: "pending", roots: 1 });
      const currentJob = {
        id: firstClaims[0]!.id, organization_id: A.org,
        kind: "internal_im_event", payload: { inboxId },
        locked_by: "current-worker",
        claim_acquired_at: currentClaims[0]!.claim_acquired_at,
      } as never;
      await runFeishuInboxJob(currentJob, pool);
      const { rows: after } = await pool.query<{
        status: string; roots: number; processed_run_id: string;
      }>(`
        select i.status,i.processed_run_id,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=i.organization_id and mission_id=i.mission_id
             and run_kind='root') as roots
        from public.ai_internal_event_inbox i where i.id=$1`, [inboxId]);
      expect(after[0]).toMatchObject({ status: "processed", roots: 2,
        processed_run_id: expect.any(String) });
    } finally {
      await pool.end();
      if (priorKey === undefined) delete process.env.AI_CRED_AES_KEY;
      else process.env.AI_CRED_AES_KEY = priorKey;
    }
  });

  it("recovers after the Run commits but before the inbox is marked processed", async () => {
    const priorKey = process.env.AI_CRED_AES_KEY;
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const event = {
        kind: "internal_text" as const,
        tenantKey: "tenant-a", eventId: "evt-recovery-500", openId: "ou-colleague",
        chatId: "oc-internal", rootMessageId: "om-recovery-question",
        messageId: "om-recovery-reply", content: "交期确认月底前可以完成交付",
      };
      const inboxId = (await persistFeishuMissionEvent(pool, event))!.inboxId;
      const { rows: initialClaims } = await pool.query<{
        id: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='crashed-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_event'
        returning id,locked_at::text as claim_acquired_at`, [A.org, inboxId]);
      const claim = {
        inboxId, jobId: initialClaims[0]!.id, workerId: "crashed-worker",
        acquiredAt: initialClaims[0]!.claim_acquired_at,
      };
      const committed = await submitFeishuMissionText(pool, event, claim);
      expect(committed).toMatchObject({ replayed: false, runId: expect.any(String) });
      const { rows: before } = await pool.query<{ status: string; roots: number }>(`
        select i.status,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=i.organization_id and mission_id=i.mission_id
             and run_kind='root') as roots
        from public.ai_internal_event_inbox i where i.id=$1`, [inboxId]);
      expect(before[0]).toMatchObject({ status: "pending", roots: 2 });
      const { rows: newClaims } = await pool.query<{ claim_acquired_at: string }>(`
        update public.job_queue set locked_by='recovery-worker',
          locked_at=clock_timestamp() + interval '1 second',attempts=attempts+1
        where organization_id=$1 and id=$2
        returning locked_at::text as claim_acquired_at`, [A.org, claim.jobId]);
      await runFeishuInboxJob({
        id: claim.jobId, organization_id: A.org, kind: "internal_im_event",
        payload: { inboxId }, locked_by: "recovery-worker",
        claim_acquired_at: newClaims[0]!.claim_acquired_at,
      } as never, pool);
      const { rows: after } = await pool.query<{
        status: string; roots: number; processed_run_id: string;
        content_ciphertext: Buffer | null;
      }>(`
        select i.status,i.processed_run_id,i.content_ciphertext,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=i.organization_id and mission_id=i.mission_id
             and run_kind='root') as roots
        from public.ai_internal_event_inbox i where i.id=$1`, [inboxId]);
      expect(after[0]).toMatchObject({ status: "processed", roots: 2,
        processed_run_id: committed!.runId, content_ciphertext: null });
    } finally {
      await pool.end();
      if (priorKey === undefined) delete process.env.AI_CRED_AES_KEY;
      else process.env.AI_CRED_AES_KEY = priorKey;
    }
  });

  it("reconciles a dead inbox job against its committed Run before requesting review", async () => {
    const priorKey = process.env.AI_CRED_AES_KEY;
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const event = {
        kind: "internal_text" as const,
        tenantKey: "tenant-a", eventId: "evt-dead-500", openId: "ou-colleague",
        chatId: "oc-internal", rootMessageId: "om-dead-question",
        messageId: "om-dead-reply", content: "交付确认月底前可以完成交付",
      };
      const inboxId = (await persistFeishuMissionEvent(pool, event))!.inboxId;
      const { rows: claims } = await pool.query<{ id: string; claim_acquired_at: string }>(`
        update public.job_queue set status='running',locked_by='crashed-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_event'
        returning id,locked_at::text as claim_acquired_at`, [A.org, inboxId]);
      const committed = await submitFeishuMissionText(pool, event, {
        inboxId, jobId: claims[0]!.id, workerId: "crashed-worker",
        acquiredAt: claims[0]!.claim_acquired_at,
      });
      expect(committed).toMatchObject({ replayed: false, runId: expect.any(String) });
      await pool.query(
        `update public.job_queue set status='dead',locked_by=null,locked_at=null
         where organization_id=$1 and id=$2`, [A.org, claims[0]!.id],
      );
      expect(await reconcileDeadFeishuInboxJobs(pool)).toBe(1);
      const { rows } = await pool.query<{
        inbox_status: string; processed_run_id: string; content_ciphertext: Buffer | null;
        mission_status: string; blocked_reason: string | null;
      }>(`
        select i.status as inbox_status,i.processed_run_id,i.content_ciphertext,
               m.status as mission_status,m.blocked_reason
        from public.ai_internal_event_inbox i
        join public.ai_missions m on m.organization_id=i.organization_id and m.id=i.mission_id
        where i.id=$1`, [inboxId]);
      expect(rows[0]).toMatchObject({ inbox_status: "processed",
        processed_run_id: committed!.runId, content_ciphertext: null,
        mission_status: "queued" });
      expect(await reconcileDeadFeishuInboxJobs(pool)).toBe(0);
    } finally {
      await pool.end();
      if (priorKey === undefined) delete process.env.AI_CRED_AES_KEY;
      else process.env.AI_CRED_AES_KEY = priorKey;
    }
  });

  it("queues a manager-approved question, sends once, and binds the real reply to its Mission", async () => {
    const previous = {
      key: process.env.AI_CRED_AES_KEY,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tenant: process.env.FEISHU_TENANT_KEY,
    };
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FEISHU_APP_ID = "cli-test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_TENANT_KEY = "tenant-a";
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const input = {
        organizationId: A.org, missionId: QUESTION.mission,
        requesterUserId: A.user, recipientUserId: FEISHU.user,
        requestKey: QUESTION.key, question: "请确认 500 件最早何时能交付？",
      };
      await expect(askFeishuColleague(pool, { ...input, organizationId: B.org }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(askFeishuColleague(pool, { ...input, requesterUserId: FEISHU.user }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(askFeishuColleague(pool, { ...input, recipientUserId: B.user }))
        .rejects.toMatchObject({ code: "recipient_unavailable" });
      const [first, retry] = await Promise.all([
        askFeishuColleague(pool, input), askFeishuColleague(pool, input),
      ]);
      expect(first.questionId).toBe(retry.questionId);
      expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
      const questionId = first.questionId;
      const { rows: before } = await pool.query<{
        status: string; question_ciphertext: Buffer; jobs: number; threads: number;
      }>(`
        select q.status,q.question_ciphertext,
          (select count(*)::int from public.job_queue
           where organization_id=q.organization_id and source_event_id=q.id
             and kind='internal_im_question') as jobs,
          (select count(*)::int from public.ai_mission_internal_threads
           where organization_id=q.organization_id and mission_id=q.mission_id) as threads
        from public.ai_internal_question_outbox q where q.id=$1`, [questionId]);
      expect(before[0]).toMatchObject({ status: "pending", jobs: 1, threads: 0 });
      expect(before[0]!.question_ciphertext.toString("utf8")).not.toContain(input.question);
      expect(sql(`
        select has_table_privilege('authenticated','public.ai_internal_question_outbox','select')::int || ',' ||
          has_table_privilege('anon','public.ai_internal_question_outbox','insert')::int || ',' ||
          has_table_privilege('service_role','public.ai_internal_question_outbox','insert')::int;
      `).split("\n").at(-1)).toBe("0,0,1");
      await expect(askFeishuColleague(pool, { ...input, question: "另一个交期问题" }))
        .rejects.toMatchObject({ code: "source_conflict" });
      const { rows: claims } = await pool.query<{
        id: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='question-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_question'
        returning id,locked_at::text as claim_acquired_at`, [A.org, questionId]);
      const job = { id: claims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "question-worker", claim_acquired_at: claims[0]!.claim_acquired_at } as never;
      const sends: Array<{ openId: string; text: string; uuid: string }> = [];
      await runFeishuQuestionJob(job, pool, async (_config, request) => {
        sends.push(request);
        return { messageId: "om-question-outbound", chatId: "oc-question-outbound" };
      });
      await runFeishuQuestionJob(job, pool, async () => {
        throw new Error("duplicate_send");
      });
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ openId: "ou-colleague", uuid: questionId });
      expect(sends[0]!.text).toContain(input.question);
      const { rows: sent } = await pool.query<{
        status: string; message_id: string; question_ciphertext: Buffer | null; active: boolean;
      }>(`
        select q.status,q.message_id,q.question_ciphertext,b.active
        from public.ai_internal_question_outbox q
        join public.ai_mission_internal_threads b
          on b.organization_id=q.organization_id and b.mission_id=q.mission_id
         and b.chat_id=q.chat_id and b.root_message_id=q.message_id
        where q.id=$1`, [questionId]);
      expect(sent[0]).toMatchObject({ status: "sent", message_id: "om-question-outbound",
        question_ciphertext: null, active: true });
      const event = { kind: "internal_text" as const, tenantKey: "tenant-a",
        eventId: "evt-question-reply", openId: "ou-colleague",
        chatId: "oc-question-outbound", rootMessageId: "om-question-outbound",
        messageId: "om-employee-reply", content: "交付确认 500 件月底前可完成" };
      const inboxId = (await persistFeishuMissionEvent(pool, event))!.inboxId;
      const { rows: replyClaim } = await pool.query<{
        id: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='reply-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_event'
        returning id,locked_at::text as claim_acquired_at`, [A.org, inboxId]);
      await runFeishuInboxJob({ id: replyClaim[0]!.id, organization_id: A.org,
        kind: "internal_im_event", payload: { inboxId }, locked_by: "reply-worker",
        claim_acquired_at: replyClaim[0]!.claim_acquired_at } as never, pool);
      const { rows: mission } = await pool.query<{ status: string; roots: number }>(`
        select m.status,
          (select count(*)::int from public.ai_workbench_runs
           where organization_id=m.organization_id and mission_id=m.id
             and run_kind='root') as roots
        from public.ai_missions m where m.id=$1`, [QUESTION.mission]);
      expect(mission[0]).toMatchObject({ status: "queued", roots: 2 });
    } finally {
      await pool.end();
      for (const [key, value] of Object.entries({
        AI_CRED_AES_KEY: previous.key, FEISHU_APP_ID: previous.appId,
        FEISHU_APP_SECRET: previous.appSecret, FEISHU_TENANT_KEY: previous.tenant,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("uses the same send UUID when a Worker loses its lease after Feishu accepts a question", async () => {
    const previous = {
      key: process.env.AI_CRED_AES_KEY,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tenant: process.env.FEISHU_TENANT_KEY,
    };
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FEISHU_APP_ID = "cli-test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_TENANT_KEY = "tenant-a";
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const questionId = (await askFeishuColleague(pool, {
        organizationId: A.org, missionId: QUESTION_FENCE.mission,
        requesterUserId: A.user, recipientUserId: FEISHU.user,
        requestKey: QUESTION_FENCE.key, question: "请核对这笔商机的最终交期",
      })).questionId;
      const { rows: firstClaims } = await pool.query<{
        id: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='old-question-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_question'
        returning id,locked_at::text as claim_acquired_at`, [A.org, questionId]);
      const oldJob = { id: firstClaims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "old-question-worker",
        claim_acquired_at: firstClaims[0]!.claim_acquired_at } as never;
      const sentUuids: string[] = [];
      await expect(runFeishuQuestionJob(oldJob, pool, async (_config, request) => {
        sentUuids.push(request.uuid);
        await pool.query(`
          update public.job_queue set locked_by='new-question-worker',
            locked_at=clock_timestamp() + interval '1 second',attempts=attempts+1
          where organization_id=$1 and id=$2`, [A.org, firstClaims[0]!.id]);
        return { messageId: "om-fenced-question", chatId: "oc-fenced-question" };
      })).rejects.toThrow("internal_question_job_lease_lost");
      const { rows: pending } = await pool.query<{ status: string; threads: number }>(`
        select q.status,
          (select count(*)::int from public.ai_mission_internal_threads
           where organization_id=q.organization_id and mission_id=q.mission_id) as threads
        from public.ai_internal_question_outbox q where q.id=$1`, [questionId]);
      expect(pending[0]).toMatchObject({ status: "pending", threads: 0 });
      const { rows: secondClaims } = await pool.query<{ claim_acquired_at: string }>(`
        select locked_at::text as claim_acquired_at from public.job_queue
        where organization_id=$1 and id=$2`, [A.org, firstClaims[0]!.id]);
      await runFeishuQuestionJob({ id: firstClaims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "new-question-worker",
        claim_acquired_at: secondClaims[0]!.claim_acquired_at } as never,
      pool, async (_config, request) => {
        sentUuids.push(request.uuid);
        return { messageId: "om-fenced-question", chatId: "oc-fenced-question" };
      });
      expect(sentUuids).toEqual([questionId, questionId]);
      const { rows: done } = await pool.query<{ status: string; threads: number }>(`
        select q.status,
          (select count(*)::int from public.ai_mission_internal_threads
           where organization_id=q.organization_id and mission_id=q.mission_id) as threads
        from public.ai_internal_question_outbox q where q.id=$1`, [questionId]);
      expect(done[0]).toMatchObject({ status: "sent", threads: 1 });
    } finally {
      await pool.end();
      for (const [key, value] of Object.entries({
        AI_CRED_AES_KEY: previous.key, FEISHU_APP_ID: previous.appId,
        FEISHU_APP_SECRET: previous.appSecret, FEISHU_TENANT_KEY: previous.tenant,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("expires an unsent question before the provider dedup window ends", async () => {
    const previous = {
      key: process.env.AI_CRED_AES_KEY,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tenant: process.env.FEISHU_TENANT_KEY,
    };
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FEISHU_APP_ID = "cli-test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_TENANT_KEY = "tenant-a";
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const questionId = (await askFeishuColleague(pool, {
        organizationId: A.org, missionId: QUESTION_EXPIRED.mission,
        requesterUserId: A.user, recipientUserId: FEISHU.user,
        requestKey: QUESTION_EXPIRED.key,
        question: "请核对这笔商机的最早可交付日期",
      })).questionId;
      await pool.query(
        `update public.ai_internal_question_outbox
         set send_deadline_at=now() - interval '1 minute'
         where organization_id=$1 and id=$2`, [A.org, questionId],
      );
      const { rows: claims } = await pool.query<{
        id: string; claim_acquired_at: string;
      }>(`
        update public.job_queue set status='running',locked_by='expired-question-worker',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_question'
        returning id,locked_at::text as claim_acquired_at`, [A.org, questionId]);
      await runFeishuQuestionJob({ id: claims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "expired-question-worker",
        claim_acquired_at: claims[0]!.claim_acquired_at } as never,
      pool, async () => { throw new Error("must_not_send"); });
      const { rows: state } = await pool.query<{
        question_status: string; mission_status: string; threads: number;
      }>(`
        select q.status as question_status,m.status as mission_status,
          (select count(*)::int from public.ai_mission_internal_threads
           where organization_id=q.organization_id and mission_id=q.mission_id) as threads
        from public.ai_internal_question_outbox q
        join public.ai_missions m on m.organization_id=q.organization_id and m.id=q.mission_id
        where q.id=$1`, [questionId]);
      expect(state[0]).toMatchObject({ question_status: "expired",
        mission_status: "needs_review", threads: 0 });
    } finally {
      await pool.end();
      for (const [key, value] of Object.entries({
        AI_CRED_AES_KEY: previous.key, FEISHU_APP_ID: previous.appId,
        FEISHU_APP_SECRET: previous.appSecret, FEISHU_TENANT_KEY: previous.tenant,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("approves an Agent question atomically, queues once, then wakes the same Mission on reply", async () => {
    const previous = {
      key: process.env.AI_CRED_AES_KEY,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tenant: process.env.FEISHU_TENANT_KEY,
    };
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FEISHU_APP_ID = "cli-test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_TENANT_KEY = "tenant-a";
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 3,
    });
    const approval = {
      organizationId: A.org, missionId: PROPOSED.mission, runId: PROPOSED.run,
      proposalId: PROPOSED.proposal, approverUserId: A.user,
    };
    try {
      const { rows: beforeApproval } = await pool.query<{ count: number }>(
        `select count(*)::int as count from public.ai_internal_question_outbox
         where organization_id=$1 and mission_id=$2`, [A.org, PROPOSED.mission],
      );
      expect(beforeApproval[0]?.count).toBe(0);
      await expect(approveProposedFeishuQuestion(pool, { ...approval, organizationId: B.org }))
        .rejects.toMatchObject({ code: "not_found" });
      const [one, two] = await Promise.allSettled([
        approveProposedFeishuQuestion(pool, approval),
        approveProposedFeishuQuestion(pool, approval),
      ]);
      const successful = [one, two].filter((item) => item.status === "fulfilled");
      const failed = [one, two].filter((item) => item.status === "rejected");
      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: "state_conflict" });
      const questionId = (successful[0] as PromiseFulfilledResult<{ questionId: string }>).value.questionId;
      const { rows: state } = await pool.query<{
        mission_status: string; run_status: string; proposal_status: string;
        proposal_args: string; proposal_preview: string; ciphertext: Buffer;
        job_count: number; event_count: number; messages: string;
      }>(`
        select m.status as mission_status,r.status as run_status,
          p.status as proposal_status,p.tool_args::text as proposal_args,
          p.preview::text as proposal_preview,q.question_ciphertext as ciphertext,
          (select count(*)::int from public.job_queue j
           where j.organization_id=q.organization_id and j.source_event_id=q.id
             and j.kind='internal_im_question') as job_count,
          (select count(*)::int from public.ai_agent_run_events e
           where e.organization_id=r.organization_id and e.run_id=r.id) as event_count,
          s.messages::text as messages
        from public.ai_internal_question_outbox q
        join public.ai_missions m on m.organization_id=q.organization_id and m.id=q.mission_id
        join public.ai_workbench_runs r on r.organization_id=m.organization_id and r.mission_id=m.id
        join public.ai_agent_action_proposals p on p.organization_id=r.organization_id
          and p.run_id=r.id and p.id=q.request_key
        join public.ai_agent_run_states s on s.organization_id=r.organization_id and s.run_id=r.id
        where q.organization_id=$1 and q.id=$2`, [A.org, questionId]);
      expect(state[0]).toMatchObject({ mission_status: "waiting_internal",
        run_status: "completed", proposal_status: "executed", job_count: 1, event_count: 6 });
      expect(state[0]!.proposal_args).not.toContain("请核对");
      expect(state[0]!.proposal_preview).not.toContain("请核对");
      expect(state[0]!.ciphertext.toString("utf8")).not.toContain("请核对");
      expect(state[0]!.messages).toContain(questionId);
      const { rows: timeline } = await pool.query<{ sequence: number; payload: string }>(
        `select sequence,payload::text from public.ai_agent_run_events
         where organization_id=$1 and run_id=$2 order by sequence`,
        [A.org, PROPOSED.run],
      );
      expect(timeline.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(timeline.map((event) => event.payload).join(" ")).not.toContain("请核对");
      const { rows: claims } = await pool.query<{ id: string; claim_acquired_at: string }>(`
        update public.job_queue set status='running',locked_by='agent-question-test',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_question'
        returning id,locked_at::text as claim_acquired_at`, [A.org, questionId]);
      await runFeishuQuestionJob({ id: claims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "agent-question-test",
        claim_acquired_at: claims[0]!.claim_acquired_at } as never,
      pool, async (_config, request) => {
        expect(request.uuid).toBe(questionId);
        return { messageId: "om-agent-question", chatId: "oc-agent-question" };
      });
      const reply = await submitFeishuMissionText(pool, {
        kind: "internal_text", tenantKey: "tenant-a", eventId: "evt-agent-question",
        openId: "ou-colleague", chatId: "oc-agent-question",
        rootMessageId: "om-agent-question", messageId: "om-agent-reply",
        content: "交付团队确认 500 件下周五可发货，报价仍需审批",
      });
      expect(reply).toMatchObject({ runId: expect.any(String), replayed: false });
      const { rows: resumed } = await pool.query<{ roots: number; status: string }>(`
        select m.status,
          (select count(*)::int from public.ai_workbench_runs r
           where r.organization_id=m.organization_id and r.mission_id=m.id
             and r.run_kind='root') as roots
        from public.ai_missions m where m.organization_id=$1 and m.id=$2`,
      [A.org, PROPOSED.mission]);
      expect(resumed[0]).toMatchObject({ roots: 2, status: "queued" });
    } finally {
      await pool.end();
      for (const [key, value] of Object.entries({
        AI_CRED_AES_KEY: previous.key, FEISHU_APP_ID: previous.appId,
        FEISHU_APP_SECRET: previous.appSecret, FEISHU_TENANT_KEY: previous.tenant,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not send an approved Agent question after the Mission is cancelled", async () => {
    const previous = {
      key: process.env.AI_CRED_AES_KEY,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tenant: process.env.FEISHU_TENANT_KEY,
    };
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FEISHU_APP_ID = "cli-test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_TENANT_KEY = "tenant-a";
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 2,
    });
    try {
      const { questionId } = await approveProposedFeishuQuestion(pool, {
        organizationId: A.org, missionId: PROPOSED_CANCEL.mission,
        runId: PROPOSED_CANCEL.run, proposalId: PROPOSED_CANCEL.proposal,
        approverUserId: A.user,
      });
      const { rows: cancellation } = await pool.query<{ result: string }>(
        "select public.fn_cancel_ai_mission($1,$2,$3,$4) as result",
        [A.org, PROPOSED_CANCEL.mission, A.user, "已取消本次交期核对"],
      );
      expect(cancellation[0]?.result).toBe("cancelled");
      const { rows: claims } = await pool.query<{ id: string; claim_acquired_at: string }>(`
        update public.job_queue set status='running',locked_by='agent-question-cancel-test',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_question'
        returning id,locked_at::text as claim_acquired_at`, [A.org, questionId]);
      await runFeishuQuestionJob({ id: claims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "agent-question-cancel-test",
        claim_acquired_at: claims[0]!.claim_acquired_at } as never,
      pool, async () => { throw new Error("must_not_send_after_cancel"); });
      const { rows: state } = await pool.query<{
        question_status: string; mission_status: string; threads: number;
      }>(`
        select q.status as question_status,m.status as mission_status,
          (select count(*)::int from public.ai_mission_internal_threads t
           where t.organization_id=q.organization_id and t.mission_id=q.mission_id) as threads
        from public.ai_internal_question_outbox q
        join public.ai_missions m on m.organization_id=q.organization_id and m.id=q.mission_id
        where q.organization_id=$1 and q.id=$2`, [A.org, questionId]);
      expect(state[0]).toMatchObject({ question_status: "needs_review",
        mission_status: "cancelled", threads: 0 });
    } finally {
      await pool.end();
      for (const [key, value] of Object.entries({
        AI_CRED_AES_KEY: previous.key, FEISHU_APP_ID: previous.appId,
        FEISHU_APP_SECRET: previous.appSecret, FEISHU_TENANT_KEY: previous.tenant,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("serializes Mission cancellation with an in-flight Feishu question send", async () => {
    const previous = {
      key: process.env.AI_CRED_AES_KEY,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      tenant: process.env.FEISHU_TENANT_KEY,
    };
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.FEISHU_APP_ID = "cli-test";
    process.env.FEISHU_APP_SECRET = "test-secret";
    process.env.FEISHU_TENANT_KEY = "tenant-a";
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 3,
    });
    try {
      const { questionId } = await askFeishuColleague(pool, {
        organizationId: A.org, missionId: QUESTION_RACE.mission,
        requesterUserId: A.user, recipientUserId: FEISHU.user,
        requestKey: QUESTION_RACE.key,
        question: "请核对这笔商机的最早交付日期",
      });
      const { rows: claims } = await pool.query<{ id: string; claim_acquired_at: string }>(`
        update public.job_queue set status='running',locked_by='question-cancel-race',
          locked_at=clock_timestamp(),attempts=attempts+1
        where organization_id=$1 and source_event_id=$2 and kind='internal_im_question'
        returning id,locked_at::text as claim_acquired_at`, [A.org, questionId]);
      let cancellationFinished = false;
      let cancellation: Promise<unknown> | null = null;
      await runFeishuQuestionJob({ id: claims[0]!.id, organization_id: A.org,
        kind: "internal_im_question", payload: { questionId },
        locked_by: "question-cancel-race",
        claim_acquired_at: claims[0]!.claim_acquired_at } as never,
      pool, async () => {
        cancellation = pool.query(
          "select public.fn_cancel_ai_mission($1,$2,$3,$4) as result",
          [A.org, QUESTION_RACE.mission, A.user, "已停止交期核对"],
        ).finally(() => { cancellationFinished = true; });
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(cancellationFinished).toBe(false);
        return { messageId: "om-cancel-race", chatId: "oc-cancel-race" };
      });
      await cancellation;
      const { rows: state } = await pool.query<{ status: string; question_status: string }>(`
        select m.status,q.status as question_status
        from public.ai_missions m join public.ai_internal_question_outbox q
          on q.organization_id=m.organization_id and q.mission_id=m.id
        where m.organization_id=$1 and m.id=$2`, [A.org, QUESTION_RACE.mission]);
      expect(state[0]).toMatchObject({ status: "cancelled", question_status: "sent" });
    } finally {
      await pool.end();
      for (const [key, value] of Object.entries({
        AI_CRED_AES_KEY: previous.key, FEISHU_APP_ID: previous.appId,
        FEISHU_APP_SECRET: previous.appSecret, FEISHU_TENANT_KEY: previous.tenant,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
