import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

interface InboxCiphertext {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

interface InboxCipherContext {
  organizationId: string;
  tenantKey: string;
  eventId: string;
}

function payloadKey(purpose: "inbox" | "question"): Buffer {
  const encoded = process.env.AI_CRED_AES_KEY ?? "";
  const root = Buffer.from(encoded, "base64");
  if (root.length !== 32 || root.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, ""))
    throw new Error("feishu_inbox_encryption_unavailable");
  // Separate inbox payloads from provider credentials even though both use the
  // installation's existing encryption root. Key material never enters rows.
  return createHmac("sha256", root)
    .update(`pi-native-crm:feishu-${purpose}:v1`).digest();
}

function aad(context: InboxCipherContext): Buffer {
  return Buffer.from(JSON.stringify([
    context.organizationId, context.tenantKey, context.eventId,
  ]), "utf8");
}

export function encryptInboxText(content: string, context: InboxCipherContext): InboxCiphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", payloadKey("inbox"), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptInboxText(
  encrypted: InboxCiphertext,
  context: InboxCipherContext,
): string {
  const decipher = createDecipheriv("aes-256-gcm", payloadKey("inbox"), encrypted.iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext), decipher.final(),
  ]).toString("utf8");
}

/** Outbound questions use a distinct sub-key and the stable outbox ID as AAD. */
export function encryptQuestionText(content: string, context: InboxCipherContext): InboxCiphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", payloadKey("question"), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptQuestionText(
  encrypted: InboxCiphertext,
  context: InboxCipherContext,
): string {
  const decipher = createDecipheriv("aes-256-gcm", payloadKey("question"), encrypted.iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext), decipher.final(),
  ]).toString("utf8");
}
