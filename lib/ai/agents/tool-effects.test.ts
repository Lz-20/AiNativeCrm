import { describe, expect, it } from "vitest";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { workbenchToolEffect } from "./tool-effects";

describe("CRM workbench effect registry", () => {
  it("classifies every catalog tool and keeps unknown tools closed", () => {
    for (const tool of TOOL_CATALOG) {
      expect(workbenchToolEffect(tool.name)).toMatchObject({ resource: expect.any(String) });
    }
    expect(workbenchToolEffect("unregistered_write")).toBeNull();
  });

  it("only labels a CRM write reversible when its business compensation exists", () => {
    expect(workbenchToolEffect("send_message")).toEqual({ effect: "external", resource: "messages" });
    expect(workbenchToolEffect("crm_update_lead")).toMatchObject({
      effect: "reversible_write",
      compensationTool: "crm_update_lead",
    });
    expect(workbenchToolEffect("crm_create_lead")?.effect).toBe("irreversible");
    expect(workbenchToolEffect("crm_send_whatsapp_message")?.effect).toBe("external");
    expect(workbenchToolEffect("crm_request_human_handoff")?.effect).toBe("external");
    expect(workbenchToolEffect("list_internal_colleagues")?.effect).toBe("read");
    expect(workbenchToolEffect("ask_internal_colleague")?.effect).toBe("external");
  });
});
