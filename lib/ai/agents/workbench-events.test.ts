import { describe, expect, it } from "vitest";
import { redactEventPayload } from "./workbench-events";

describe("CRM workbench event payloads", () => {
  it("keeps only the product-safe fields for each event", () => {
    expect(redactEventPayload("context_loaded", {
      contactId: "contact-1", conversationId: "conversation-1", messageBody: "private customer content",
    })).toEqual({ contactId: "contact-1", conversationId: "conversation-1" });
  });

  it("retains only organization-memory provenance, never the published policy body", () => {
    expect(redactEventPayload("context_loaded", {
      orgMemoryRevision: "sha256:revision", orgMemoryVersionId: "version-3",
      orgMemoryVersionNumber: 3, orgMemoryEntriesCount: 2, memoryResolution: "current_published",
      content: "private policy", entries: [{ body: "private learning" }],
    })).toEqual({
      orgMemoryRevision: "sha256:revision", orgMemoryVersionId: "version-3",
      orgMemoryVersionNumber: 3, orgMemoryEntriesCount: 2, memoryResolution: "current_published",
    });
  });

  it("redacts secret-shaped fields even when nested in an allowed field", () => {
    expect(redactEventPayload("tool_proposed", {
      tool: "crm_update_lead", proposalId: "proposal-1", api_key: "never-store-this", extra: "discard",
    })).toEqual({ tool: "crm_update_lead", proposalId: "proposal-1" });
  });

  it("keeps send-policy trace labels without persisting customer text", () => {
    expect(redactEventPayload("policy_checked", {
      decision: "veto", verdict: "veto", tool: "send_message", gate: "opt_out", code: "blocked",
      body: "private draft",
    })).toEqual({ decision: "veto", verdict: "veto", tool: "send_message", gate: "opt_out", code: "blocked" });
  });

  it("keeps numeric usage counts but never lets a token-shaped string through", () => {
    expect(redactEventPayload("usage_reported", {
      inputTokens: 20_627,
      outputTokens: 1_140,
      costCents: 0,
      calls: 2,
      accessToken: "secret",
    })).toEqual({ inputTokens: 20_627, outputTokens: 1_140, costCents: 0, calls: 2 });
    expect(redactEventPayload("usage_reported", {
      inputTokens: "secret-in-token-field", outputTokens: -1, costCents: null,
    })).toEqual({ inputTokens: "[REDACTED]", outputTokens: "[REDACTED]", costCents: null });
  });

  it("records a direction consumption receipt without the instruction text", () => {
    expect(redactEventPayload("manager_direction_consumed", {
      directionId: "direction-1", directionRevision: 2,
      content: "private manager instruction", apiKey: "secret",
    })).toEqual({ directionId: "direction-1", directionRevision: 2 });
  });
});
