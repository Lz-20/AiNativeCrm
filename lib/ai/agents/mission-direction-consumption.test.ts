import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, RuntimeMessage } from "@/lib/agent-runtime";
import { directionReachedModel } from "./mission-direction-consumption";

const direction = "先核对\"新版\"报价，再联系客户";
const probeId = "manager-direction:mission-1:2";
const successful: AgentRuntimeEvent[] = [
  { type: "model_context_consumed", data: { probeId } },
];
const transcript: RuntimeMessage[] = [
  { role: "user", content: `负责人方向：${JSON.stringify(direction)}` },
  { role: "assistant", content: "已核对当前资料" },
];

describe("Mission direction consumption evidence", () => {
  it("requires the serialized direction in the actual model prompt and a successful turn", () => {
    expect(directionReachedModel(transcript, successful, direction, probeId)).toBe(true);
    expect(directionReachedModel([{ role: "user", content: "旧方向" }], successful, direction, probeId))
      .toBe(false);
    expect(directionReachedModel(transcript,
      [{ type: "steering_queued", data: { steeringId: "direction-1" } }], direction, probeId)).toBe(false);
    expect(directionReachedModel(transcript,
      [{ type: "turn_end", data: { stop_reason: "stop" } }], direction, probeId)).toBe(false);
    expect(directionReachedModel(transcript,
      [{ type: "model_context_consumed", data: { probeId: "other" } }], direction, probeId)).toBe(false);
  });
});
