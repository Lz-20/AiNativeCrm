import { describe, expect, it, vi } from "vitest";
import { endSupportRequest } from "./end-support";

describe("support end receipt before navigation", () => {
  it("does not finish on headers while the JSON body is delayed", async () => {
    let finish!: (v: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: () => body });
    let navigated = false;
    const pending = endSupportRequest(fetcher).then(() => {
      navigated = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(navigated).toBe(false);
    finish({ data: { ended: true, redirect_url: "/app/inbox" } });
    await pending;
    expect(navigated).toBe(true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/admin/impersonate/end", {
      method: "POST",
    });
  });
  it("preserves an unknown body failure and never retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.reject(new Error("body aborted")) });
    await expect(endSupportRequest(fetcher)).rejects.toThrow("body aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects denied, invalid, incomplete and redirected receipts", async () => {
    for (const response of [
      { ok: false },
      { ok: true, json: async () => ({ data: { ended: true } }) },
      { ok: true, json: async () => ({ data: { ended: "true", redirect_url: "/app/inbox" } }) },
      {
        ok: true,
        json: async () => ({ data: { ended: true, redirect_url: "https://example.invalid" } }),
      },
    ])
      await expect(endSupportRequest(vi.fn().mockResolvedValue(response))).rejects.toThrow();
  });
  it("accepts the idempotent already-ended response", async () => {
    await expect(
      endSupportRequest(
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { ended: false, redirect_url: "/app/inbox" } }),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
