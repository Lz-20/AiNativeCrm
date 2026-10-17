import { createClient } from "@/lib/supabase/server";
import type { HomeAgentRun, HomeDashboardData, HomePipelineStage, HomeTask } from "./types";

const PAGE_SIZE = 1000;

type LeadRow = { id: string; stage_id: string | null; value_cents: number | null };
type StageRow = { id: string; name: string; position: number };

async function readAllOpenLeads(orgId: string): Promise<LeadRow[]> {
  const supabase = await createClient();
  const rows: LeadRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("crm_leads")
      .select("id, stage_id, value_cents")
      .eq("organization_id", orgId)
      .eq("status", "open")
      .order("updated_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`无法读取商机摘要：${error.message}`);
    const page = (data ?? []) as LeadRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function readHomeDashboard(orgId: string, canSeeAgentRuns: boolean): Promise<HomeDashboardData> {
  const supabase = await createClient();
  const [contacts, tasksCount, tasksResult, pipelineResult, leads] = await Promise.all([
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("is_merged_into", null),
    supabase
      .from("crm_tasks")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .in("status", ["pending", "in_progress"]),
    supabase
      .from("crm_tasks")
      .select("id, title, due_date, priority, status")
      .eq("organization_id", orgId)
      .in("status", ["pending", "in_progress"])
      .not("due_date", "is", null)
      .lt("due_date", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
      .order("due_date", { ascending: true })
      .limit(5),
    supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("is_default", true)
      .limit(1)
      .maybeSingle(),
    readAllOpenLeads(orgId),
  ]);

  if (contacts.error) throw new Error(`无法读取客户总数：${contacts.error.message}`);
  if (tasksCount.error) throw new Error(`无法读取待办总数：${tasksCount.error.message}`);
  if (tasksResult.error) throw new Error(`无法读取待办摘要：${tasksResult.error.message}`);
  if (pipelineResult.error) throw new Error(`无法读取销售漏斗：${pipelineResult.error.message}`);

  const tasks = (tasksResult.data ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    dueDate: task.due_date,
    priority: task.priority,
    status: task.status,
  })) as HomeTask[];
  const pipeline = pipelineResult.data as { id: string; name: string } | null;
  let stages: HomePipelineStage[] = [];
  if (pipeline) {
    const { data: stageData, error: stageError } = await supabase
      .from("crm_stages")
      .select("id, name, position")
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipeline.id)
      .eq("is_won", false)
      .eq("is_lost", false)
      .order("position", { ascending: true });
    if (stageError) throw new Error(`无法读取漏斗阶段：${stageError.message}`);
    const stageRows = (stageData ?? []) as StageRow[];
    const perStage = new Map<string, { count: number; valueCents: number }>();
    for (const lead of leads) {
      if (!lead.stage_id) continue;
      const current = perStage.get(lead.stage_id) ?? { count: 0, valueCents: 0 };
      current.count += 1;
      current.valueCents += Number(lead.value_cents ?? 0);
      perStage.set(lead.stage_id, current);
    }
    stages = stageRows.map((stage) => ({
      id: stage.id,
      name: stage.name,
      ...(perStage.get(stage.id) ?? { count: 0, valueCents: 0 }),
    }));
  }

  let agentRuns: HomeAgentRun[] = [];
  if (canSeeAgentRuns) {
    const { data: runs, error: runsError } = await supabase
      .from("ai_workbench_runs")
      .select("id, agent_id, task, status, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (runsError) throw new Error(`无法读取 Agent 执行记录：${runsError.message}`);
    const runRows = (runs ?? []) as Array<Omit<HomeAgentRun, "agentName" | "createdAt"> & { agent_id: string; created_at: string }>;
    const agentIds = [...new Set(runRows.map((run) => run.agent_id))];
    const names = new Map<string, string>();
    if (agentIds.length) {
      const { data: agents, error: agentsError } = await supabase
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", orgId)
        .in("id", agentIds);
      if (agentsError) throw new Error(`无法读取 Agent 名称：${agentsError.message}`);
      for (const agent of agents ?? []) names.set(agent.id, agent.name);
    }
    agentRuns = runRows.map((run) => ({
      id: run.id,
      agentName: names.get(run.agent_id) ?? "Agent",
      task: run.task,
      status: run.status,
      createdAt: run.created_at,
    }));
  }

  return {
    contactCount: contacts.count ?? 0,
    activeLeadCount: leads.length,
    openTaskCount: tasksCount.count ?? 0,
    activeLeadValueCents: leads.reduce((sum, lead) => sum + Number(lead.value_cents ?? 0), 0),
    tasks,
    agentRuns,
    stages,
    pipelineName: pipeline?.name ?? null,
  };
}
