import { describe, expect, it } from "vitest";
import { resolveWorkbenchScope } from "./workbench-scope";

const ORG_ID = "org-1";
const LEAD_ID = "lead-1";
const PIPELINE_ID = "pipeline-1";
const CONTACT_ID = "contact-1";

function adminFor(rows: Record<string, Record<string, unknown>>) {
  const selected: Record<string, string> = {};
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select(columns: string) {
          selected[table] = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          const row = rows[table];
          return {
            data:
              row &&
              Object.entries(filters).every(([column, value]) => row[column] === value)
                ? row
                : null,
            error: null,
          };
        },
      };
      return builder;
    },
  };
  return { admin, selected };
}

describe("resolveWorkbenchScope", () => {
  it("resolves a scoped lead using the contacts.phone_number database column", async () => {
    const { admin, selected } = adminFor({
      crm_leads: {
        id: LEAD_ID,
        organization_id: ORG_ID,
        contact_id: CONTACT_ID,
        pipeline_id: PIPELINE_ID,
      },
      crm_pipelines: { id: PIPELINE_ID, organization_id: ORG_ID, is_archived: false },
      contacts: {
        id: CONTACT_ID,
        organization_id: ORG_ID,
        name: "林晓梅",
        phone_number: "+8613800000000",
      },
    });

    const scope = await resolveWorkbenchScope(
      admin as never,
      ORG_ID,
      { leadId: LEAD_ID, pipelineId: PIPELINE_ID },
    );

    expect(selected.contacts).toBe("id, name, phone_number");
    expect(scope).toMatchObject({
      leadId: LEAD_ID,
      pipelineId: PIPELINE_ID,
      contactId: CONTACT_ID,
      contact: { name: "林晓梅", phone: "+8613800000000" },
    });
  });
});
