import { describe, expect, it } from "vitest";
import { missionAcceptanceContractSchema, parseMissionAcceptanceContract } from "./mission-acceptance-contract";

describe("Mission observable acceptance contract", () => {
  it("keeps historical Missions without a contract", () => {
    expect(parseMissionAcceptanceContract(null)).toBeNull();
  });

  it("accepts only the bounded versioned observable checks", () => {
    expect(missionAcceptanceContractSchema.parse({ revision: 1, checks: [
      { kind: "lead_status", equals: "won" },
      { kind: "customer_inbound_after_verified_send" },
    ] })).toMatchObject({ revision: 1 });
    for (const invalid of [
      { revision: 2, checks: [{ kind: "lead_status", equals: "won" }] },
      { revision: 1, checks: [] },
      { revision: 1, checks: [{ kind: "lead_status", equals: "won", sql: "select *" }] },
      { revision: 1, checks: [{ kind: "lead_status", equals: "won" },
        { kind: "lead_status", equals: "lost" }] },
      { revision: 1, checks: [{ kind: "customer_accepted_quote" }] },
    ]) expect(missionAcceptanceContractSchema.safeParse(invalid).success).toBe(false);
  });

  it("fails closed on a malformed persisted contract", () => {
    expect(() => parseMissionAcceptanceContract({ revision: 1, checks: [] }))
      .toThrow("mission_acceptance_contract_invalid");
  });
});
