import { describe, expect, it } from "vitest";
import type { RuntimeMessage } from "@/lib/agent-runtime";
import type { AgentEvalRunInput } from "@/lib/ai/evals/contracts";
import { auditWorkbenchEvidenceProvenance } from "@/lib/ai/evals/evidence-provenance";

const contactId = "6842302c-a864-4a4e-8dc5-a605f6c10827";
const leadId = "84598184-e361-4faa-ad1e-ae5525e85323";
const conversationId = "761207e2-a792-4b75-b347-819d8c1a54fb";
const chunkId = "9a4dbb74-4986-4527-b3e0-ed736c05d95d";
const childId = "84128f3c-c3c3-4ae7-9c65-b2f6f047a88f";
const eventId = "a4cf6bbb-f1ea-4d7b-9528-ff81227136ed";

function tool(toolName: string, value: unknown, isError = false): RuntimeMessage {
  return {
    role: "tool", toolCallId: `call-${toolName}`, toolName,
    content: [{ type: "text", text: JSON.stringify(value) }], isError,
  };
}

const evidence = [
  { sourceType: "contact" as const, sourceId: contactId, claim: "联系人存在" },
  { sourceType: "lead" as const, sourceId: leadId, claim: "商机存在" },
  { sourceType: "conversation" as const, sourceId: conversationId, claim: "会话存在" },
  { sourceType: "knowledge" as const, sourceId: chunkId, claim: "知识片段存在" },
  { sourceType: "specialist" as const, sourceId: childId, claim: "专家运行存在" },
  { sourceType: "run_event" as const, sourceId: eventId, claim: "事件存在" },
];

function input(messages: RuntimeMessage[]): Pick<AgentEvalRunInput, "runtimeMessages" | "collaborationRuns" | "events"> {
  return {
    runtimeMessages: messages,
    collaborationRuns: [{ id: childId, specialistKey: "opportunity", status: "completed", errorCode: null }],
    events: [{ id: eventId, sequence: 1, eventType: "run_started", payload: {} }],
  };
}

describe("Workbench evidence provenance", () => {
  it("matches typed ids only in successful observations from the right tools", () => {
    const actual = input([
      tool("crm_search_contacts", { contacts: [{ id: contactId }] }),
      tool("crm_get_lead", { lead: { id: leadId, contact_id: contactId } }),
      tool("crm_list_conversations", { conversations: [{ id: conversationId }] }),
      tool("crm_search_knowledge", { evidence: [{ id: chunkId }] }),
    ]);
    expect(auditWorkbenchEvidenceProvenance(evidence, actual)).toEqual({
      observed: 6, unobserved: 0, verified: 0, mismatched: 0, unverifiable: 0,
    });
  });

  it("recognizes actual organization-memory version/entry evidence without proving its prose", () => {
    const cited = [{ sourceType: "knowledge" as const, sourceId: chunkId, claim: "Published memory policy" }];
    expect(auditWorkbenchEvidenceProvenance(cited, input([
      tool("crm_get_org_memory", { evidence: [{ id: chunkId, namespace: "organization_memory" }] }),
    ]))).toEqual({ observed: 1, unobserved: 0, verified: 0, mismatched: 0, unverifiable: 0 });
    expect(auditWorkbenchEvidenceProvenance(cited, input([
      tool("crm_get_org_memory", { evidence: [{ id: chunkId }] }, true),
    ])).unobserved).toBe(1);
  });

  it("does not treat a related id, wrong resource type, or failed tool as observed", () => {
    const actual = input([
      tool("crm_get_lead", { lead: { id: leadId, contact_id: contactId } }),
      tool("crm_get_contact", { id: contactId }, true),
      tool("crm_list_conversations", { conversations: [{ id: leadId }] }),
    ]);
    expect(auditWorkbenchEvidenceProvenance(evidence.slice(0, 3), actual))
      .toEqual({ observed: 1, unobserved: 2, verified: 0, mismatched: 0, unverifiable: 0 });
  });

  it("does not infer a source id from malformed text or an unrelated nested object", () => {
    const actual = input([
      { role: "tool", toolCallId: "malformed", toolName: "crm_get_contact", content: "not JSON" },
      tool("crm_get_contact", { id: leadId, metadata: { id: contactId } }),
    ]);
    expect(auditWorkbenchEvidenceProvenance([evidence[0]!], actual))
      .toEqual({ observed: 0, unobserved: 1, verified: 0, mismatched: 0, unverifiable: 0 });
  });

  it("checks safe scalar values, including explicit null, without inspecting claim prose", () => {
    const actual = input([
      tool("crm_get_contact", { id: contactId, is_blocked: false, name: "private" }),
      tool("crm_get_lead", { lead: {
        id: leadId, status: "open", value_cents: 128000000, expected_close_date: null,
      } }),
    ]);
    expect(auditWorkbenchEvidenceProvenance([
      { sourceType: "contact", sourceId: contactId, claim: "未经核实的自然语言",
        assertions: [{ field: "is_blocked", equals: false }] },
      { sourceType: "lead", sourceId: leadId, claim: "仍需人工核对",
        assertions: [
          { field: "status", equals: "open" },
          { field: "value_cents", equals: 128000000 },
          { field: "expected_close_date", equals: null },
        ] },
    ], actual)).toEqual({
      observed: 2, unobserved: 0, verified: 4, mismatched: 0, unverifiable: 0,
    });
  });

  it("uses the latest observed field value, but keeps a field omitted by a later sparse read", () => {
    const actual = input([
      tool("crm_get_lead", { lead: { id: leadId, status: "open", value_cents: 1200 } }),
      tool("crm_list_leads", { leads: [{ id: leadId, status: "won" }] }),
      tool("crm_get_lead", { lead: { id: leadId } }),
      tool("crm_get_lead", { lead: { id: leadId, status: "lost" } }, true),
    ]);
    expect(auditWorkbenchEvidenceProvenance([
      { sourceType: "lead", sourceId: leadId, claim: "商机状态",
        assertions: [{ field: "status", equals: "open" }, { field: "value_cents", equals: 1200 }] },
    ], actual)).toEqual({
      observed: 1, unobserved: 0, verified: 1, mismatched: 1, unverifiable: 0,
    });
  });

  it("does not mistake absent fields, wrong source types, or unsupported assertions for facts", () => {
    const actual = input([
      tool("crm_get_contact", { id: contactId, status: "open" }),
      tool("crm_get_contact", { id: leadId, status: "won" }),
      tool("crm_list_conversations", { conversations: [{ id: conversationId, status: "open" }] }),
    ]);
    expect(auditWorkbenchEvidenceProvenance([
      { sourceType: "contact", sourceId: contactId, claim: "状态",
        assertions: [{ field: "status", equals: "open" }, { field: "is_blocked", equals: null }] },
      { sourceType: "lead", sourceId: leadId, claim: "成交",
        assertions: [{ field: "status", equals: "won" }] },
      { sourceType: "conversation", sourceId: conversationId, claim: "会话",
        assertions: [{ field: "status", equals: "open" }] },
    ], actual)).toEqual({
      observed: 2, unobserved: 1, verified: 1, mismatched: 0, unverifiable: 3,
    });
  });
});
