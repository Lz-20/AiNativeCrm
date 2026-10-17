import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

export interface FeishuWebhookConfig {
  appId: string;
  encryptKey: string;
  verificationToken: string;
}

export type FeishuWebhookPayload =
  | { kind: "challenge"; challenge: string }
  | { kind: "ignored" }
  | {
      kind: "binding_request";
      tenantKey: string;
      eventId: string;
      openId: string;
      token: string;
    }
  | {
      kind: "internal_text";
      tenantKey: string;
      eventId: string;
      openId: string;
      chatId: string;
      rootMessageId: string;
      messageId: string;
      content: string;
    };

export class FeishuWebhookError extends Error {
  constructor(readonly code: "invalid_signature" | "invalid_payload" | "invalid_config") {
    super(code);
    this.name = "FeishuWebhookError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function readJson(value: string): Record<string, unknown> {
  try {
    const parsed = record(JSON.parse(value));
    if (parsed) return parsed;
  } catch { /* malformed or unsupported body */ }
  throw new FeishuWebhookError("invalid_payload");
}

/**
 * Feishu's event signature is SHA-256(timestamp + nonce + encryptKey + body),
 * not HMAC. See the official node-sdk dispatcher/request-handle.ts. Use the
 * exact raw body, require a fresh timestamp, and fail closed when unconfigured.
 */
export function parseFeishuWebhook(
  rawBody: string,
  headers: Headers,
  config: FeishuWebhookConfig,
  nowMs = Date.now(),
): FeishuWebhookPayload {
  if (!config.appId || !config.encryptKey || !config.verificationToken)
    throw new FeishuWebhookError("invalid_config");
  if (Buffer.byteLength(rawBody, "utf8") > 65_536)
    throw new FeishuWebhookError("invalid_payload");
  const timestamp = headers.get("x-lark-request-timestamp");
  const nonce = headers.get("x-lark-request-nonce");
  const signature = headers.get("x-lark-signature");
  const seconds = timestamp && /^\d{10}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (!Number.isFinite(seconds) || Math.abs(nowMs - seconds * 1000) > 5 * 60_000 ||
      !nonce || nonce.length > 256 || !signature || !/^[a-f0-9]{64}$/i.test(signature))
    throw new FeishuWebhookError("invalid_signature");
  const expected = createHash("sha256")
    .update(timestamp + nonce + config.encryptKey + rawBody)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new FeishuWebhookError("invalid_signature");

  const envelope = readJson(rawBody);
  let payload = envelope;
  if (typeof envelope.encrypt === "string") {
    try {
      const bytes = Buffer.from(envelope.encrypt, "base64");
      if (bytes.length < 32) throw new Error("ciphertext_short");
      const key = createHash("sha256").update(config.encryptKey).digest();
      const decipher = createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16));
      payload = readJson(Buffer.concat([
        decipher.update(bytes.subarray(16)), decipher.final(),
      ]).toString("utf8"));
    } catch {
      throw new FeishuWebhookError("invalid_payload");
    }
  }
  if (payload.type === "url_verification") {
    if (payload.token !== config.verificationToken)
      throw new FeishuWebhookError("invalid_signature");
    const challenge = nonempty(payload.challenge, 1024);
    if (!challenge) throw new FeishuWebhookError("invalid_payload");
    return { kind: "challenge", challenge };
  }

  const header = record(payload.header);
  if (!header || header.app_id !== config.appId ||
      header.token !== config.verificationToken)
    throw new FeishuWebhookError("invalid_signature");
  if (header.event_type !== "im.message.receive_v1") return { kind: "ignored" };
  const event = record(payload.event);
  const sender = record(event?.sender);
  const senderId = record(sender?.sender_id);
  const message = record(event?.message);
  if (sender?.sender_type !== "user" || message?.message_type !== "text")
    return { kind: "ignored" };
  const tenantKey = nonempty(header.tenant_key);
  const eventId = nonempty(header.event_id);
  const openId = nonempty(senderId?.open_id);
  const chatId = nonempty(message.chat_id);
  const rootMessageId = nonempty(message.root_id) ?? nonempty(message.parent_id);
  const messageId = nonempty(message.message_id);
  if (!rootMessageId && message.chat_type === "p2p") {
    if (!tenantKey || !eventId || !openId || !chatId || !messageId ||
        typeof message.content !== "string" || message.content.length > 8_192)
      throw new FeishuWebhookError("invalid_payload");
    const content = nonempty(readJson(message.content).text, 2_000)?.trim();
    const match = /^CRM-BIND ([A-Za-z0-9_-]{43})$/.exec(content ?? "");
    if (!match) return { kind: "ignored" };
    const token = match[1]!;
    if (Buffer.from(token, "base64url").length !== 32) return { kind: "ignored" };
    return { kind: "binding_request", tenantKey, eventId, openId, token };
  }
  // Most IM messages are not replies to a Mission question. A short "可以" is
  // also not enough to become a fact, and must never be treated as approval.
  if (!rootMessageId) return { kind: "ignored" };
  if (!tenantKey || !eventId || !openId || !chatId || !messageId ||
      typeof message.content !== "string" || message.content.length > 8_192)
    throw new FeishuWebhookError("invalid_payload");
  const content = nonempty(readJson(message.content).text, 2_000)?.trim();
  if (!content || content.length < 5) return { kind: "ignored" };
  if (/^CRM-BIND [A-Za-z0-9_-]{43}$/.test(content)) return { kind: "ignored" };
  return { kind: "internal_text", tenantKey, eventId, openId, chatId,
    rootMessageId, messageId, content };
}

/** Stable UUID for the existing Mission input idempotency contract. */
export function feishuEventRequestKey(tenantKey: string, eventId: string): string {
  const bytes = createHash("sha256").update(`feishu\0${tenantKey}\0${eventId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
