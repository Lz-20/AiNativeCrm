import { describe, expect, it } from "vitest";
import { SIGNED_MESSAGE_RECEIPT_SQL } from "./signed-receipt";

describe("authenticated message receipt capability", () => {
  it("keeps the current supported transport, signature and message-type gates", () => {
    expect(SIGNED_MESSAGE_RECEIPT_SQL).toBe(
      "w.provider='waha' and w.valid_signature is true " +
      "and w.event_type in ('message','message.any')",
    );
  });
});
