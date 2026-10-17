import { randomBytes } from "node:crypto";
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

/** Only two-decimal currencies are accepted by this revision of the protocol. */
export const explicitOfferTermsSchema = z.object({
  description: z.string().trim().min(1).max(160).refine((value) => !/[\r\n]/.test(value)),
  amountMinor: z.number().int().min(1).max(1_000_000_000_000),
  currency: z.enum(["BRL", "CNY", "USD", "EUR"]),
  deliveryDate: isoDate,
}).strict();

export type ExplicitOfferTerms = z.infer<typeof explicitOfferTermsSchema>;

export function newOfferConfirmationCode(): string {
  return randomBytes(16).toString("base64url");
}

export function formatExplicitOffer(terms: ExplicitOfferTerms, code: string): {
  offerText: string;
  acceptanceText: string;
} {
  const valid = explicitOfferTermsSchema.parse(terms);
  if (!/^[A-Za-z0-9_-]{22}$/.test(code) || Buffer.from(code, "base64url").length !== 16)
    throw new Error("explicit_offer_code_invalid");
  const whole = Math.floor(valid.amountMinor / 100);
  const fractional = String(valid.amountMinor % 100).padStart(2, "0");
  const acceptanceText = `确认报价交期 ${code}`;
  return {
    offerText: [
      "请确认以下报价与交期：",
      `项目：${valid.description}`,
      `报价：${valid.currency} ${whole}.${fractional}`,
      `交期：${valid.deliveryDate}`,
      `如全部接受，请仅回复：${acceptanceText}`,
      "若有异议，请直接说明，不要发送确认码。",
    ].join("\n"),
    acceptanceText,
  };
}

/** Exact whole-message equality is intentional: quoted or qualified replies are not acceptance. */
export function isExactOfferAcceptance(body: string, acceptanceText: string): boolean {
  return body.trim() === acceptanceText;
}
