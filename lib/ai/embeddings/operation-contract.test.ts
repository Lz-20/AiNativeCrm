import { describe, expect, it } from "vitest";
import {
  BOUNDED_FREE_QUERY_MARKER_HASH,
  MAX_BOUNDED_FREE_QUERY_BYTES,
  MAX_BOUNDED_FREE_QUERY_REQUESTS,
  boundedFreeQueryManifest,
  inputManifest,
  isBoundedFreeQueryManifest,
  hashText,
  upperCost,
  isEmbeddingWaiting,
  authorizeOperationSchema,
  priceReviewSchema,
  tenantStoragePath,
} from "./operation-contract";
import { EmbeddingConfigurationError } from "./profile";
describe("operation contract defaults to refusal", () => {
  it.each([
    "other/file.md",
    "org/../other.md",
    "org/%2e%2e/other.md",
    "org/%252e%252e/other.md",
    "org/%2fother.md",
    "org/%5cother.md",
  ])("rejects cross-tenant or encoded traversal path %s", (path) => {
    expect(tenantStoragePath("org", path)).toBe(false);
  });
  it("accepts only normal same-tenant storage paths", () => {
    expect(tenantStoragePath("org", "org/synthetic.md")).toBe(true);
  });
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
  it("cryptographically separates bounded free-text query manifests from exact v1 manifests", () => {
    const nonce = "b".repeat(64);
    const bounded = boundedFreeQueryManifest(1024, nonce);
    expect(bounded.manifest).toEqual([
      { position: 0, hash: BOUNDED_FREE_QUERY_MARKER_HASH, bytes: 1024 },
      { position: 1, hash: nonce, bytes: 1 },
    ]);
    expect(isBoundedFreeQueryManifest(bounded.manifest, bounded.manifestHash)).toBe(true);
    const v1HashOfSameEntries = hashText(JSON.stringify([1, bounded.manifest]));
    expect(bounded.manifestHash).not.toBe(v1HashOfSameEntries);
    expect(isBoundedFreeQueryManifest(bounded.manifest, v1HashOfSameEntries)).toBe(false);
    const exact = inputManifest(["SVC-101"]);
    expect(isBoundedFreeQueryManifest(exact.manifest, exact.manifestHash)).toBe(false);
    expect(() => boundedFreeQueryManifest(MAX_BOUNDED_FREE_QUERY_BYTES + 1, nonce)).toThrow();
  });
  it("allows bounded free-text manifests only for kind=query within hard request/byte bounds", () => {
    const bounded = boundedFreeQueryManifest(2000, "c".repeat(64));
    const base = {
      knowledge_source_id: "e4130000-0000-4000-8000-000000000001",
      kind: "query" as const,
      content_hash: "a".repeat(64),
      source_revision_hash: "b".repeat(64),
      manifest_hash: bounded.manifestHash,
      manifest: bounded.manifest,
      fingerprint: "embedding:v1:" + "d".repeat(64),
      configuration_version: "e4130000-0000-4000-8000-000000000002",
      price_review_id: "e4130000-0000-4000-8000-000000000003",
      knowledge_version_id: "e4130000-0000-4000-8000-000000000004",
      not_before: "2026-11-22T00:00:00.000Z",
      expires_at: "2026-11-23T00:00:00.000Z",
      max_requests: 1,
      max_request_tokens: 8192,
      max_total_tokens: "8192",
      max_cost_microcents: "8192",
      currency: "CNY",
      confirm_cost: true as const,
    };
    expect(authorizeOperationSchema.safeParse(base).success).toBe(true);
    expect(
      authorizeOperationSchema.safeParse({
        ...base,
        max_requests: MAX_BOUNDED_FREE_QUERY_REQUESTS,
      }).success,
    ).toBe(true);
    expect(
      authorizeOperationSchema.safeParse({
        ...base,
        max_requests: MAX_BOUNDED_FREE_QUERY_REQUESTS + 1,
      }).success,
    ).toBe(false);
    expect(
      authorizeOperationSchema.safeParse({
        ...base,
        kind: "index",
        knowledge_version_id: null,
      }).success,
    ).toBe(false);
    expect(
      authorizeOperationSchema.safeParse({
        ...base,
        kind: "validation",
        knowledge_version_id: null,
      }).success,
    ).toBe(false);
  });
});
