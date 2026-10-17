import { describe, expect, it, vi } from "vitest";
import {
  executeApprovedWorkbenchTool, NonCompensableWorkbenchWriteError,
} from "./approved-workbench-tool";

describe("human-approved workbench tools", () => {
  it("never falls through to a raw lead update when compensation is impossible", async () => {
    const reader = vi.fn();
    const updater = vi.fn();
    await expect(executeApprovedWorkbenchTool({
      toolName: "crm_update_lead",
      args: { lead_id: "lead-1", custom_fields: { priority: "high" } },
      tools: {
        crm_get_lead: { execute: reader },
        crm_update_lead: { execute: updater },
      },
    })).rejects.toBeInstanceOf(NonCompensableWorkbenchWriteError);
    expect(reader).not.toHaveBeenCalled();
    expect(updater).not.toHaveBeenCalled();
  });

  it("returns the business inverse for a supported lead update", async () => {
    const reader = vi.fn().mockResolvedValue({ lead: {
      id: "lead-1", title: "Old", updated_at: "2026-09-30T00:00:00.000Z",
    } });
    const updater = vi.fn().mockResolvedValue({ lead: {
      id: "lead-1", title: "New", updated_at: "2026-09-30T00:01:00.000Z",
    } });
    const result = await executeApprovedWorkbenchTool({
      toolName: "crm_update_lead",
      args: { lead_id: "lead-1", title: "New" },
      tools: {
        crm_get_lead: { execute: reader },
        crm_update_lead: { execute: updater },
      },
    });
    expect(updater).toHaveBeenCalledTimes(1);
    expect(result.reversible?.compensationArgs).toEqual({
      lead_id: "lead-1", title: "Old", expected_updated_at: "2026-09-30T00:01:00.000Z",
    });
  });

  it("executes an approved non-reversible tool once and rejects reported errors", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    expect((await executeApprovedWorkbenchTool({
      toolName: "crm_request_human_handoff", args: { conversation_id: "conversation-1" },
      tools: { crm_request_human_handoff: { execute } },
    })).reversible).toBeNull();
    await expect(executeApprovedWorkbenchTool({
      toolName: "crm_request_human_handoff", args: { conversation_id: "conversation-1" },
      tools: { crm_request_human_handoff: { execute } },
    })).rejects.toThrow("crm_tool_reported_error");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("fails closed for an unclassified tool name", async () => {
    const execute = vi.fn();
    await expect(executeApprovedWorkbenchTool({
      toolName: "unregistered_write", args: {},
      tools: { unregistered_write: { execute } },
    })).rejects.toThrow("workbench_approved_tool_unclassified");
    expect(execute).not.toHaveBeenCalled();
  });
});
