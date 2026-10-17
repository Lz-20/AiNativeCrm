import { z } from "zod";

const leadStatus = z.object({
  kind: z.literal("lead_status"),
  equals: z.enum(["open", "won", "lost"]),
}).strict();

const customerInbound = z.object({
  kind: z.literal("customer_inbound_after_verified_send"),
}).strict();

/** User-selected observable signals, not a substitute for free-text business acceptance. */
export const missionAcceptanceContractSchema = z.object({
  revision: z.literal(1),
  checks: z.array(z.discriminatedUnion("kind", [leadStatus, customerInbound]))
    .min(1).max(2)
    .refine((checks) => new Set(checks.map((check) => check.kind)).size === checks.length,
      "Duplicate acceptance check"),
}).strict();

export type MissionAcceptanceContract = z.infer<typeof missionAcceptanceContractSchema>;

export function parseMissionAcceptanceContract(value: unknown): MissionAcceptanceContract | null {
  if (value === null || value === undefined) return null;
  const parsed = missionAcceptanceContractSchema.safeParse(value);
  if (!parsed.success) throw new Error("mission_acceptance_contract_invalid");
  return parsed.data;
}
