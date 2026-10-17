import { describe, expect, it } from "vitest";
import { isAppUrl } from "../e2e/utils/app-url";
describe("post-MFA URL boundary", () => {
  it.each(["/app", "/app?x=1", "/app/ai/workbench"])("recognizes protected route %s", path => {
    expect(isAppUrl(new URL(path,"http://127.0.0.1:3012"))).toBe(true);
  });
  it.each(["/login?next=/app", "/login/mfa?next=/app/inbox", "/application", "/signup"])("does not mistake anonymous %s for login success", path => {
    expect(isAppUrl(new URL(path,"http://127.0.0.1:3012"))).toBe(false);
  });
});
