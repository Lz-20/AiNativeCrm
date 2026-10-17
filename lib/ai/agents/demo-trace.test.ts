import { describe, expect, it } from "vitest";
import { publicDemoText, publicDemoTools } from "./demo-trace";
describe("public real-demo evidence is minimized", () => {
  it("drops unknown inputs, private fields, non-demo facts and all assistant/system text", () => {
    const result = publicDemoTools([
      { role: "system", content: "CANARY SYSTEM SECRET" },
      { role: "assistant", content: "CANARY HIDDEN TEXT", privateContinuation: "CANARY REASONING",
        toolCalls: [{ id: "call", name: "crm_get_contact", arguments: { contact_id: "CANARY ID", secret: "CANARY KEY" } }] },
      { role: "tool", toolCallId: "call", toolName: "crm_get_contact", content: JSON.stringify({
        phone: "CANARY PHONE", email: "CANARY EMAIL", secret: "CANARY KEY",
        confirmed_customer_memory: { status: "local", coverage: "complete", memories: [{ body: "CANARY REAL CUSTOMER" }, { body: "[演示合成事实] 下午沟通" }] },
      }) },
    ]);
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(result[0]?.observation.confirmedCustomerMemory).toMatchObject({ confirmedCount: 2, facts: [{ body: "[演示合成事实] 下午沟通" , authority: "customer_context_only" }] });
  });
  it("redacts public synthetic answer locators and contact channels", () => {
    expect(publicDemoText("sk-abcdefgh12345 user@example.test +8613800138001 11111111-1111-4111-8111-111111111111"))
      .not.toMatch(/abcdefgh|user@|13800138001|11111111/);
  });
});
