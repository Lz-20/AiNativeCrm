import { describe, expect, it } from "vitest";

import { extractToolClaims } from "@/lib/ai/agents/evidence-claims";

describe("structured CRM evidence claims", () => {
  it("extracts stable field claims without retaining raw CRM values", () => {
    const message = {
      role: "tool" as const,
      toolCallId: "call-1",
      toolName: "crm_get_lead",
      content: JSON.stringify({
        id: "lead-1",
        stage_id: "stage-qualified",
        value_cents: 1280000,
        contact: { id: "contact-1", name: "敏感姓名" },
        updated_at: "2026-09-28T01:02:03Z",
      }),
    };
    const first = extractToolClaims({
      message,
      specialistKey: "opportunity_diagnosis",
      scope: { leadId: "lead-1" },
    });
    const second = extractToolClaims({
      message,
      specialistKey: "opportunity_diagnosis",
      scope: { leadId: "lead-1" },
    });

    expect(first).toEqual(second);
    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { resource: "lead", id: "lead-1" },
          field: "stage_id",
          valueType: "string",
          locator: expect.objectContaining({
            sourceId: "lead:lead-1",
            revision: "2026-09-28T01:02:03Z",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(first)).not.toContain("stage-qualified");
    expect(JSON.stringify(first)).not.toContain("敏感姓名");
  });

  it("uses the validated scope as a subject for unwrapped single-object tools", () => {
    const claims = extractToolClaims({
      message: {
        role: "tool",
        toolCallId: "call-2",
        toolName: "crm_get_contact",
        content: JSON.stringify({ name: "林晓梅", is_blocked: false }),
      },
      specialistKey: "customer_evidence",
      scope: { contactId: "contact-1" },
    });

    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { resource: "contact", id: "contact-1" },
          field: "is_blocked",
          valueType: "boolean",
        }),
      ]),
    );
    expect(JSON.stringify(claims)).not.toContain("林晓梅");
  });

  it("does not create claims from failed or unstructured observations", () => {
    expect(
      extractToolClaims({
        message: {
          role: "tool",
          toolCallId: "call-3",
          toolName: "crm_get_lead",
          content: "provider failed",
          isError: true,
        },
        specialistKey: "opportunity_diagnosis",
        scope: { leadId: "lead-1" },
      }),
    ).toEqual([]);
  });
});
