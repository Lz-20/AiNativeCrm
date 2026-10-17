import { describe, expect, it, vi } from "vitest";
import { loadMissionContinuationAgent } from "./mission-continuation-agent";

describe("mission continuation Agent eligibility", () => {
  it("normalizes the PostgreSQL bigint revision and scopes the exact version", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ operation_revision: "3" }] });
    expect(await loadMissionContinuationAgent({ query } as never, "org-1", "agent-1", "version-1"))
      .toEqual({ operationRevision: 3 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("v.id=$3"), [
      "org-1", "agent-1", "version-1",
    ]);
    const statement = query.mock.calls[0]?.[0] as string;
    expect(statement).toContain("a.origin='builtin'");
    expect(statement).toContain("a.origin='user'");
    expect(statement).toContain("a.paused_at is null");
  });

  it.each(["9007199254740992", "not-a-revision", "0"])(
    "fails closed on an unsafe revision %s", async (operation_revision) => {
      const query = vi.fn().mockResolvedValue({ rows: [{ operation_revision }] });
      expect(await loadMissionContinuationAgent({ query } as never, "org", "agent", "version"))
        .toBeNull();
    },
  );
});
