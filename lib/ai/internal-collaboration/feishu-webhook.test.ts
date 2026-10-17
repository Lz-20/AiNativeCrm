import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FeishuWebhookError,
  feishuEventRequestKey,
  parseFeishuWebhook,
} from "@/lib/ai/internal-collaboration/feishu-webhook";

const config = {
  appId: "cli_test",
  encryptKey: "event-encrypt-key",
  verificationToken: "event-verification-token",
};
const now = 1_800_000_000_000;
const event = {
  schema: "2.0",
  header: {
    app_id: config.appId,
    token: config.verificationToken,
    tenant_key: "tenant-a",
    event_id: "event-123",
    event_type: "im.message.receive_v1",
  },
  event: {
    sender: { sender_type: "user", sender_id: { open_id: "ou_A" } },
    message: {
      message_type: "text", chat_id: "oc_A", root_id: "om_root",
      message_id: "om_reply", content: JSON.stringify({ text: "交期预计月底，尚需核实" }),
    },
  },
};

function signed(value: unknown, at = now): { raw: string; headers: Headers } {
  const raw = JSON.stringify(value);
  const timestamp = String(Math.floor(at / 1000));
  const nonce = "nonce-1";
  const signature = createHash("sha256")
    .update(timestamp + nonce + config.encryptKey + raw).digest("hex");
  return { raw, headers: new Headers({
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  }) };
}

function encrypted(value: unknown): unknown {
  const iv = randomBytes(16);
  const key = createHash("sha256").update(config.encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return { encrypt: Buffer.concat([
    iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final(),
  ]).toString("base64") };
}

describe("signed Feishu internal facts", () => {
  it("reads a signed, encrypted thread reply without treating it as approval", () => {
    const { raw, headers } = signed(encrypted(event));
    expect(parseFeishuWebhook(raw, headers, config, now)).toEqual({
      kind: "internal_text", tenantKey: "tenant-a", eventId: "event-123",
      openId: "ou_A", chatId: "oc_A", rootMessageId: "om_root",
      messageId: "om_reply", content: "交期预计月底，尚需核实",
    });
  });

  it("rejects unsigned, stale and cross-app payloads", () => {
    const { raw, headers } = signed(event);
    headers.set("x-lark-signature", "0".repeat(64));
    expect(() => parseFeishuWebhook(raw, headers, config, now))
      .toThrowError(new FeishuWebhookError("invalid_signature"));
    const fresh = signed(event);
    expect(() => parseFeishuWebhook(fresh.raw, fresh.headers, config, now + 6 * 60_000))
      .toThrowError(new FeishuWebhookError("invalid_signature"));
    const wrongApp = signed({ ...event, header: { ...event.header, app_id: "cli_other" } });
    expect(() => parseFeishuWebhook(wrongApp.raw, wrongApp.headers, config, now))
      .toThrowError(new FeishuWebhookError("invalid_signature"));
  });

  it("requires a thread and ignores card-like or bot content", () => {
    const noThread = signed({ ...event, event: { ...event.event,
      message: { ...event.event.message, root_id: undefined } } });
    expect(parseFeishuWebhook(noThread.raw, noThread.headers, config, now))
      .toEqual({ kind: "ignored" });
    const bot = signed({ ...event, event: { ...event.event,
      sender: { ...event.event.sender, sender_type: "app" } } });
    expect(parseFeishuWebhook(bot.raw, bot.headers, config, now)).toEqual({ kind: "ignored" });
    const card = signed({ ...event, header: { ...event.header, event_type: "card.action.trigger" } });
    expect(parseFeishuWebhook(card.raw, card.headers, config, now)).toEqual({ kind: "ignored" });
  });

  it("accepts an exact binding token only from a signed private, unthreaded user message", () => {
    const token = randomBytes(32).toString("base64url");
    const binding = { ...event, event: { ...event.event,
      message: { ...event.event.message, chat_type: "p2p", root_id: undefined,
        content: JSON.stringify({ text: `CRM-BIND ${token}` }) } } };
    const { raw, headers } = signed(encrypted(binding));
    expect(parseFeishuWebhook(raw, headers, config, now)).toEqual({
      kind: "binding_request", tenantKey: "tenant-a", eventId: "event-123",
      openId: "ou_A", token,
    });
    const group = signed({ ...binding, event: { ...binding.event,
      message: { ...binding.event.message, chat_type: "group" } } });
    expect(parseFeishuWebhook(group.raw, group.headers, config, now))
      .toEqual({ kind: "ignored" });
    const threaded = signed({ ...binding, event: { ...binding.event,
      message: { ...binding.event.message, root_id: "om_root" } } });
    expect(parseFeishuWebhook(threaded.raw, threaded.headers, config, now))
      .toEqual({ kind: "ignored" });
    const malformed = signed({ ...binding, event: { ...binding.event,
      message: { ...binding.event.message, content: JSON.stringify({ text: `CRM-BIND ${token} extra` }) } } });
    expect(parseFeishuWebhook(malformed.raw, malformed.headers, config, now))
      .toEqual({ kind: "ignored" });
  });

  it("accepts only authenticated challenges and makes stable event keys", () => {
    const challenge = signed({ type: "url_verification", token: config.verificationToken,
      challenge: "challenge-a" });
    expect(parseFeishuWebhook(challenge.raw, challenge.headers, config, now))
      .toEqual({ kind: "challenge", challenge: "challenge-a" });
    expect(feishuEventRequestKey("tenant-a", "event-123"))
      .toBe(feishuEventRequestKey("tenant-a", "event-123"));
    expect(feishuEventRequestKey("tenant-b", "event-123"))
      .not.toBe(feishuEventRequestKey("tenant-a", "event-123"));
  });
});
