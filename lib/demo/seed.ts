import { createAdminClient } from "@/lib/supabase/admin";
import { ensureBuiltinAgents } from "@/lib/ai/agents/ensure-builtins";
import { ensureStoppedDemoChannelSession } from "@/lib/channels/demo-session";
import { DEMO_EMAIL, DEMO_ORG_SLUG, DEMO_PASSWORD } from "./config";

const DEMO_ORG_NAME = "演示工作区";

type Row = { id: string };

async function ensureUser(admin: ReturnType<typeof createAdminClient>): Promise<string> {
  const { data: listed, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listError) throw new Error(`无法读取演示账号：${listError.message}`);
  const existing = listed.users.find((user) => user.email?.toLowerCase() === DEMO_EMAIL.toLowerCase());
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password: DEMO_PASSWORD,
      user_metadata: { ...existing.user_metadata, full_name: "演示账号", locale: "zh-CN", demo: true },
    });
    if (error) throw new Error(`无法更新演示账号：${error.message}`);
    return existing.id;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "演示账号", locale: "zh-CN", demo: true },
  });
  if (error || !data.user) throw new Error(`无法创建演示账号：${error?.message ?? "未知错误"}`);
  return data.user.id;
}

async function ensureOrganization(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string> {
  const { data: existing, error: findError } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", DEMO_ORG_SLUG)
    .maybeSingle();
  if (findError) throw new Error(`无法读取演示工作区：${findError.message}`);

  let orgId = (existing as Row | null)?.id;
  if (!orgId) {
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug: DEMO_ORG_SLUG,
        legal_name: DEMO_ORG_NAME,
        display_name: DEMO_ORG_NAME,
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        onboarded_at: new Date().toISOString(),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`无法创建演示工作区：${error?.message ?? "未知错误"}`);
    orgId = (data as Row).id;
  } else {
    const { error } = await admin
      .from("organizations")
      .update({ display_name: DEMO_ORG_NAME, locale: "zh-CN", timezone: "Asia/Shanghai", onboarded_at: new Date().toISOString() } as never)
      .eq("id", orgId);
    if (error) throw new Error(`无法更新演示工作区：${error.message}`);
  }

  const { data: membership } = await admin
    .from("user_organizations")
    .select("id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (membership) {
    await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null, accepted_at: new Date().toISOString() } as never)
      .eq("id", (membership as Row).id);
  } else {
    const { error } = await admin.from("user_organizations").insert({
      user_id: userId,
      organization_id: orgId,
      role: "admin",
      accepted_at: new Date().toISOString(),
    } as never);
    if (error) throw new Error(`无法绑定演示账号：${error.message}`);
  }
  return orgId;
}

async function ensureBoard(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  userId: string,
): Promise<void> {
  const { data: foundPipeline, error: pipelineReadError } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("slug", "demo-sales")
    .maybeSingle();
  if (pipelineReadError) throw new Error(`无法读取演示漏斗：${pipelineReadError.message}`);

  let pipelineId = (foundPipeline as Row | null)?.id;
  if (!pipelineId) {
    const { data: defaultPipeline, error: defaultPipelineError } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", orgId)
      .eq("is_default", true)
      .maybeSingle();
    if (defaultPipelineError) throw new Error(`无法读取演示默认漏斗：${defaultPipelineError.message}`);
    pipelineId = (defaultPipeline as Row | null)?.id;
  }

  const pipelinePayload = {
    name: "演示销售漏斗",
    slug: "demo-sales",
    description: "用于体验 CRM 工作流的示例数据。",
    is_default: true,
    vocabulary: { lead: "客户", lead_plural: "客户", deal: "商机", deal_plural: "商机", won: "已成交", lost: "已流失", stage: "阶段", stage_plural: "阶段" },
    settings: { fields: [], canonical_tags: ["重点"], lost_reasons: [], identity_resolution: { fields_in_priority_order: ["phone_e164", "email"] } },
  };

  if (!pipelineId) {
    const { data, error } = await admin
      .from("crm_pipelines")
      .insert({ organization_id: orgId, ...pipelinePayload } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`无法创建演示漏斗：${error?.message ?? "未知错误"}`);
    pipelineId = (data as Row).id;
  } else {
    const { error } = await admin.from("crm_pipelines").update(pipelinePayload as never).eq("id", pipelineId);
    if (error) throw new Error(`无法更新演示漏斗：${error.message}`);
  }

  const stages = [
    ["new", "新客户", 1000],
    ["contacted", "已联系", 2000],
    ["proposal", "方案沟通", 3000],
    ["won", "已成交", 4000],
  ] as const;
  const stageIds: Record<string, string> = {};
  for (const [slug, name, position] of stages) {
    const { data: foundBySlug } = await admin
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .eq("slug", slug)
      .maybeSingle();
    let found = foundBySlug as Row | null;
    if (!found && slug === "won") {
      const { data: foundWon } = await admin
        .from("crm_stages")
        .select("id")
        .eq("pipeline_id", pipelineId)
        .eq("is_won", true)
        .maybeSingle();
      found = foundWon as Row | null;
    }
    if (found) {
      const { error } = await admin
        .from("crm_stages")
        .update({ name, slug, position, is_won: slug === "won", is_lost: false } as never)
        .eq("id", found.id);
      if (error) throw new Error(`无法更新演示阶段：${error.message}`);
      stageIds[slug] = found.id;
      continue;
    }
    const { data, error } = await admin
      .from("crm_stages")
      .insert({ organization_id: orgId, pipeline_id: pipelineId, name, slug, position, is_won: slug === "won", is_lost: false } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`无法创建演示阶段：${error?.message ?? "未知错误"}`);
    stageIds[slug] = (data as Row).id;
  }

  const contacts = [
    ["林晓梅", "lin.xiaomei@example.test", "+8613800138001"],
    ["陈伟", "chen.wei@example.test", "+8613800138002"],
    ["王芳", "wang.fang@example.test", "+8613800138003"],
    ["赵强", "zhao.qiang@example.test", "+8613800138004"],
    ["周敏", "zhou.min@example.test", "+8613800138005"],
  ] as const;
  const contactIds: string[] = [];
  for (const [name, email, phone] of contacts) {
    const { data: found } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("email", email)
      .maybeSingle();
    if (found) {
      contactIds.push((found as Row).id);
      continue;
    }
    const { data, error } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, name, display_name: name, email, phone_number: phone, source: "demo", created_by_user_id: userId } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`无法创建演示客户：${error?.message ?? "未知错误"}`);
    contactIds.push((data as Row).id);
  }

  const leads = [
    ["林晓梅 — 企业官网改版", "new", 1280000, 0],
    ["陈伟 — 门店会员系统", "contacted", 760000, 1],
    ["王芳 — 私域运营方案", "proposal", 2450000, 2],
    ["赵强 — 年度服务合同", "proposal", 5200000, 3],
    ["周敏 — 已签约客户", "won", 980000, 4],
  ] as const;
  for (const [title, stage, valueCents, contactIndex] of leads) {
    const { data: found } = await admin
      .from("crm_leads")
      .select("id")
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .eq("title", title)
      .maybeSingle();
    const payload = {
      organization_id: orgId,
      pipeline_id: pipelineId,
      stage_id: stageIds[stage],
      contact_id: contactIds[contactIndex],
      title,
      description: "演示商机：可自由编辑、移动和测试自动化。",
      status: stage === "won" ? "won" : "open",
      value_cents: valueCents,
      currency: "CNY",
      owner_user_id: userId,
      source: "demo",
      tags: [stage === "won" ? "重点客户" : "待跟进"],
      ...(stage === "won" ? { closed_at: new Date().toISOString() } : {}),
    };
    if (found) {
      await admin.from("crm_leads").update(payload as never).eq("id", (found as Row).id);
    } else {
      const { error } = await admin.from("crm_leads").insert({ ...payload, organization_id: orgId } as never);
      if (error) throw new Error(`无法创建演示商机：${error.message}`);
    }
  }

  // The authenticated home page consumes ordinary CRM tasks. Keep a small,
  // repeatable mix of overdue, upcoming, and completed examples so the demo
  // communicates real task states without manufacturing Agent executions.
  const now = new Date();
  const demoTasks = [
    { title: "回访林晓梅：确认官网改版需求", due: new Date(now.getTime() - 2 * 60 * 60 * 1000), priority: "urgent", status: "pending", contactIndex: 0, leadIndex: 0 },
    { title: "复核王芳的私域运营方案", due: new Date(now.getTime() + 3 * 60 * 60 * 1000), priority: "high", status: "in_progress", contactIndex: 2, leadIndex: 2 },
    { title: "跟进赵强年度服务合同", due: new Date(now.getTime() + 26 * 60 * 60 * 1000), priority: "medium", status: "pending", contactIndex: 3, leadIndex: 3 },
    { title: "整理陈伟的门店会员系统记录", due: new Date(now.getTime() - 24 * 60 * 60 * 1000), priority: "low", status: "done", contactIndex: 1, leadIndex: 1 },
  ] as const;
  const { data: demoLeadRows, error: demoLeadRowsError } = await admin
    .from("crm_leads")
    .select("id, title")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId);
  if (demoLeadRowsError) throw new Error(`无法读取演示商机：${demoLeadRowsError.message}`);
  const demoLeadIds = new Map((demoLeadRows ?? []).map((lead) => [lead.title, lead.id]));
  for (const task of demoTasks) {
    const { data: found, error: findTaskError } = await admin
      .from("crm_tasks")
      .select("id")
      .eq("organization_id", orgId)
      .eq("title", task.title)
      .maybeSingle();
    if (findTaskError) throw new Error(`无法读取演示任务：${findTaskError.message}`);
    const payload = {
      organization_id: orgId,
      title: task.title,
      description: "演示任务：可在任务列表中修改、完成或取消。",
      due_date: task.due.toISOString(),
      priority: task.priority,
      status: task.status,
      contact_id: contactIds[task.contactIndex],
      lead_id: demoLeadIds.get(leads[task.leadIndex][0]) ?? null,
      assigned_to: userId,
      created_by: userId,
    };
    if (found) {
      const { error } = await admin.from("crm_tasks").update(payload as never)
        .eq("organization_id", orgId).eq("id", (found as Row).id);
      if (error) throw new Error(`无法更新演示任务：${error.message}`);
    } else {
      const { error } = await admin.from("crm_tasks")
        .insert({ ...payload, organization_id: orgId } as never);
      if (error) throw new Error(`无法创建演示任务：${error.message}`);
    }
  }

  // An explicitly stopped synthetic channel gives the built-in communications
  // agent a real CRM conversation to inspect without connecting to WhatsApp or
  // dispatching a message. Assigning the conversation at insert also avoids
  // enqueueing the normal unassigned-conversation routing event.
  const channelSessionId = await ensureStoppedDemoChannelSession(admin, orgId, userId);

  const { data: existingConversation, error: conversationReadError } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactIds[0])
    .eq("channel_session_id", channelSessionId)
    .maybeSingle();
  if (conversationReadError) throw new Error(`无法读取演示会话：${conversationReadError.message}`);
  if (!existingConversation) {
    const now = new Date().toISOString();
    const { error } = await admin.from("conversations").insert({
      organization_id: orgId,
      contact_id: contactIds[0],
      channel_session_id: channelSessionId,
      channel: "whatsapp",
      status: "open",
      assigned_to_user_id: userId,
      assigned_at: now,
      last_inbound_at: now,
      last_message_at: now,
      last_message_preview: "演示客户：我想和真人客服沟通，请不要让机器人继续回复。",
      unread_count_for_assignee: 1,
      metadata: { demo: true, no_external_channel: true },
    } as never);
    if (error) throw new Error(`无法创建演示会话：${error.message}`);
  }
}

/** 幂等地准备本地演示账号、工作区和 CRM 数据。 */
export async function ensureDemoData(): Promise<{ userId: string; orgId: string }> {
  const admin = createAdminClient();
  const userId = await ensureUser(admin);
  const orgId = await ensureOrganization(admin, userId);
  await ensureBoard(admin, orgId, userId);
  await ensureBuiltinAgents(orgId);
  return { userId, orgId };
}
