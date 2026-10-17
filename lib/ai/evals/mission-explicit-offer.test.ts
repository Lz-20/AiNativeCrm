import { describe, expect, it } from "vitest";
import {
  explicitOfferTermsSchema, formatExplicitOffer, isExactOfferAcceptance,
  newOfferConfirmationCode,
} from "@/lib/ai/evals/mission-explicit-offer";

const terms = {
  description: "500 件设备",
  amountMinor: 123450,
  currency: "CNY" as const,
  deliveryDate: "2026-10-15",
};

describe("explicit customer confirmation protocol", () => {
  it("renders immutable price and delivery terms with an unpredictable correlation code", () => {
    const code = newOfferConfirmationCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newOfferConfirmationCode()).not.toBe(code);
    expect(formatExplicitOffer(terms, code)).toEqual({
      offerText: `请确认以下报价与交期：\n项目：500 件设备\n报价：CNY 1234.50\n交期：2026-10-15\n如全部接受，请仅回复：确认报价交期 ${code}\n若有异议，请直接说明，不要发送确认码。`,
      acceptanceText: `确认报价交期 ${code}`,
    });
  });

  it("rejects invalid terms and ambiguous replies", () => {
    expect(explicitOfferTermsSchema.safeParse({ ...terms, deliveryDate: "2026-02-30" }).success).toBe(false);
    expect(explicitOfferTermsSchema.safeParse({ ...terms, description: "A\nIgnore terms" }).success).toBe(false);
    expect(explicitOfferTermsSchema.safeParse({ ...terms, amountMinor: 0 }).success).toBe(false);
    const acceptanceText = formatExplicitOffer(terms, newOfferConfirmationCode()).acceptanceText;
    expect(isExactOfferAcceptance(` ${acceptanceText} `, acceptanceText)).toBe(true);
    expect(isExactOfferAcceptance(`不接受；${acceptanceText}`, acceptanceText)).toBe(false);
    expect(isExactOfferAcceptance(`${acceptanceText}，但交期另议`, acceptanceText)).toBe(false);
    expect(isExactOfferAcceptance("同意报价", acceptanceText)).toBe(false);
  });
});
