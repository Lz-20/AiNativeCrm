import { describe, expect, it } from "vitest";
import { validateWorkbenchToolArgs } from "./validate-workbench-tool-args";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

describe("workbench proposal approval validation", () => {
  it("validates native external message proposals strictly", () => {
    expect(validateWorkbenchToolArgs("send_message", { body: "  已确认的回复  " })).toEqual({
      ok: true,
      args: { body: "已确认的回复" },
    });
    expect(validateWorkbenchToolArgs("send_message", { body: " " })).toEqual({ ok: false });
    expect(validateWorkbenchToolArgs("send_message", { body: "回复", extra: true })).toEqual({ ok: false });
  });

  it("revalidates an Agent's internal question at the human gate", () => {
    const recipientUserId = "11111111-1111-4111-8111-111111111111";
    expect(validateWorkbenchToolArgs("ask_internal_colleague", {
      recipientUserId, question: "  请核对这笔商机的交期  ",
    })).toEqual({ ok: true, args: { recipientUserId, question: "请核对这笔商机的交期" } });
    expect(validateWorkbenchToolArgs("ask_internal_colleague", {
      recipientUserId, question: "请核对交期", extra: "ignore",
    })).toEqual({ ok: false });
  });

  it("revalidates handoff identifiers and applies CRM schema defaults", () => {
    expect(validateWorkbenchToolArgs("crm_request_human_handoff", {
      conversation_id: CONVERSATION_ID,
    })).toEqual({
      ok: true,
      args: { conversation_id: CONVERSATION_ID, reason: "requested_human", urgency: "normal" },
    });
  });

  it("rejects malformed or unknown CRM tools before execution", () => {
    expect(validateWorkbenchToolArgs("crm_request_human_handoff", { conversation_id: "not-a-uuid" })).toEqual({ ok: false });
    expect(validateWorkbenchToolArgs("not_a_tool", {})).toEqual({ ok: false });
  });
});
