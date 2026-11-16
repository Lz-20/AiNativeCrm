import { describe, expect, it } from "vitest";
import { parseCheckpointText } from "./checkpoint-contract";

describe("checkpoint format is distinct from model failure", () => {
  it("parses valid schema without fabricating missing business facts", () => {
    expect(parseCheckpointText('{"commitments":["synthetic"],"next_action":null}')).toMatchObject({
      commitments: ["synthetic"],
      next_action: null,
    });
  });
  it.each(["no JSON", "{broken}", '{"commitments":12}', '{"next_action":{}}'])(
    "rejects missing JSON, malformed JSON and invalid schema safely",
    (value) => {
      expect(() => parseCheckpointText(value)).toThrow("checkpoint_invalid");
    },
  );
});
