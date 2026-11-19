import { describe, expect, it } from "vitest";
import {
  inputManifest,
  hashText,
  upperCost,
  isEmbeddingWaiting,
  authorizeOperationSchema,
  priceReviewSchema,
} from "./operation-contract";
import { EmbeddingConfigurationError } from "./profile";
describe("operation contract defaults to refusal", () => {
  it("has an ordered versioned chunk identity, unaffected by text in metadata", () => {
    const m = inputManifest(["SVC-101", "合成"]);
    expect(m.manifest[1]).toEqual({ position: 1, hash: hashText("合成"), bytes: 6 });
    expect(m.manifestHash).not.toBe(inputManifest(["合成", "SVC-101"]).manifestHash);
  });
  it("rounds upper costs upward with integer microcents, never floats", () => {
    expect(upperCost(8192, "1000000")).toBe(8192n);
    expect(upperCost(1, "1")).toBe(1n);
    expect(() => upperCost(1.5, "1")).toThrow();
  });
  it.each([
    "embedding_disabled",
    "embedding_credential_unavailable",
    "embedding_authorization_required",
    "embedding_lease_busy",
    "embedding_budget_exhausted",
    "embedding_operation_blocked",
  ])("%s is waiting, never success or a failed attempt", (code) => {
    expect(isEmbeddingWaiting(new EmbeddingConfigurationError(code))).toBe(true);
  });
  it.each([
    "embedding_transport_failed",
    "embedding_upstream_rejected",
    "embedding_vector_invalid",
    "database_write_failed",
  ])("%s remains a real failure", (code) => {
    expect(isEmbeddingWaiting(new EmbeddingConfigurationError(code))).toBe(false);
  });
  it("does not accept a fictional/default price, token estimate or authorization", () => {
    expect(priceReviewSchema.safeParse({}).success).toBe(false);
    expect(authorizeOperationSchema.safeParse({}).success).toBe(false);
    expect(
      priceReviewSchema.safeParse({ price_per_million_microcents: 0, token_bound: "chars/4" })
        .success,
    ).toBe(false);
  });
});
