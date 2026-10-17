import { describe, expect, it } from "vitest";
import {
  appendWorkbenchObservation,
  continueWorkbenchMessages,
  parseRuntimeMessages,
  specialistObservationEnvelope,
} from "./workbench-state";

describe("durable Pi workbench state", () => {
  it("parses only CRM runtime message shapes", () => {
    expect(parseRuntimeMessages([{ role: "user", content: "task" }])).toEqual([
      { role: "user", content: "task" },
    ]);
    expect(parseRuntimeMessages([{ role: "assistant", content: 9 }])).toBeNull();
  });

  it("retains opaque assistant continuation only in service-side state", () => {
    const saved = [{
      role: "assistant",
      content: "visible",
      privateContinuation: { content: [{ type: "thinking", thinking: "private" }] },
    }];
    expect(parseRuntimeMessages(saved)?.[0]).toEqual(saved[0]);
  });

  it("appends a bounded result observation and removes credential-shaped fields", () => {
    const next = appendWorkbenchObservation([{ role: "user", content: "move the lead" }], {
      tool: "crm_move_lead_stage",
      status: "executed",
      result: { lead_id: "lead-1", api_key: "never" },
    });
    expect(next).toHaveLength(2);
    expect(next[1]?.role).toBe("user");
    expect(JSON.stringify(next)).not.toContain("never");
    expect(JSON.stringify(next)).toContain("[REDACTED]");
  });

  it("keeps each model turn and tool result across consecutive automatic writes", () => {
    const firstTurn = [
      { role: "user" as const, content: "读取并推进商机" },
      { role: "assistant" as const, content: "已读取", toolCalls: [{ id: "read-1", name: "crm_get_lead", arguments: {} }] },
      { role: "tool" as const, toolCallId: "read-1", toolName: "crm_get_lead", content: "阶段: 待跟进" },
      { role: "assistant" as const, content: "更新阶段", toolCalls: [{ id: "write-1", name: "crm_update_lead", arguments: {} }] },
    ];
    const afterFirstWrite = continueWorkbenchMessages(firstTurn, [
      { tool: "crm_update_lead", status: "executed", result: { stage: "已联系" } },
    ]);
    const secondTurn = [
      ...afterFirstWrite,
      { role: "assistant" as const, content: "继续读取", toolCalls: [{ id: "read-2", name: "crm_get_lead", arguments: {} }] },
      { role: "tool" as const, toolCallId: "read-2", toolName: "crm_get_lead", content: "阶段: 已联系" },
      { role: "assistant" as const, content: "更新下一步", toolCalls: [{ id: "write-2", name: "crm_update_lead", arguments: {} }] },
    ];
    const persisted = JSON.parse(JSON.stringify(continueWorkbenchMessages(secondTurn, [
      { tool: "crm_update_lead", status: "executed", result: { nextStep: "报价" } },
    ])));
    const recovered = parseRuntimeMessages(persisted);
    expect(recovered).not.toBeNull();
    expect(recovered?.filter((message) => message.role === "assistant")).toHaveLength(4);
    expect(recovered?.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(JSON.stringify(recovered)).toContain("已联系");
    expect(JSON.stringify(recovered)).toContain("报价");
  });

  it("keeps specialist evidence in the database-required observation array", () => {
    const value = specialistObservationEnvelope([], []);
    expect(Array.isArray(value)).toBe(true);
    expect(value).toEqual([{ kind: "specialist_evidence", evidence: [], claims: [] }]);
  });
});
