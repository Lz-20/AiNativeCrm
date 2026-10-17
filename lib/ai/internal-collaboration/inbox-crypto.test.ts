import { afterEach, describe, expect, it } from "vitest";
import {
  decryptInboxText, decryptQuestionText, encryptInboxText, encryptQuestionText,
} from "@/lib/ai/internal-collaboration/inbox-crypto";

const originalKey = process.env.AI_CRED_AES_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.AI_CRED_AES_KEY;
  else process.env.AI_CRED_AES_KEY = originalKey;
});

describe("internal IM inbox encryption", () => {
  it("authenticates ciphertext against tenant and event identity", () => {
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    const context = { organizationId: "org-a", tenantKey: "tenant-a", eventId: "event-a" };
    const encrypted = encryptInboxText("客户交期需要再次确认", context);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("交期");
    expect(decryptInboxText(encrypted, context)).toBe("客户交期需要再次确认");
    expect(() => decryptInboxText(encrypted, { ...context, tenantKey: "tenant-b" })).toThrow();
    expect(() => decryptInboxText({ ...encrypted, tag: Buffer.alloc(16) }, context)).toThrow();
  });

  it("fails closed without a valid installation key", () => {
    delete process.env.AI_CRED_AES_KEY;
    expect(() => encryptInboxText("内部资料", {
      organizationId: "org-a", tenantKey: "tenant-a", eventId: "event-a",
    })).toThrow("feishu_inbox_encryption_unavailable");
  });

  it("separates outbound question keys from inbound reply keys", () => {
    process.env.AI_CRED_AES_KEY = Buffer.alloc(32, 7).toString("base64");
    const context = { organizationId: "org-a", tenantKey: "tenant-a", eventId: "outbox-id" };
    const encrypted = encryptQuestionText("请确认交期", context);
    expect(decryptQuestionText(encrypted, context)).toBe("请确认交期");
    expect(() => decryptInboxText(encrypted, context)).toThrow();
    expect(() => decryptQuestionText(encrypted, { ...context, eventId: "other" })).toThrow();
  });
});
