import { describe, expect, it } from "vitest";
import { appUrlAtOrigin, isAppUrl } from "../e2e/utils/app-url";
describe("post-MFA URL boundary", () => {
  it.each(["/app", "/app?x=1", "/app/ai/workbench"])("recognizes protected route %s", path => {
    expect(isAppUrl(new URL(path,"http://127.0.0.1:3012"))).toBe(true);
  });
  it.each(["/login?next=/app", "/login/mfa?next=/app/inbox", "/application", "/signup"])("does not mistake anonymous %s for login success", path => {
    expect(isAppUrl(new URL(path,"http://127.0.0.1:3012"))).toBe(false);
  });
});

describe("login success on the configured application origin", () => {
  const matches = appUrlAtOrigin("http://127.0.0.1:3012/login");

  it.each(["/app", "/app?x=1", "/app/", "/app/inbox"])("accepts %s", (path) => {
    expect(matches(new URL(path, "http://127.0.0.1:3012"))).toBe(true);
  });

  it.each([
    "http://elsewhere.test/app",
    "https://127.0.0.1:3012/app",
    "http://127.0.0.1:3013/app/inbox",
    "http://127.0.0.1:3012/application",
    "http://127.0.0.1:3012/login?next=/app/inbox",
    "http://127.0.0.1:3012/login/mfa?next=/app",
    "http://127.0.0.1:3012/signup",
  ])("rejects a foreign origin or an anonymous destination: %s", (url) => {
    expect(matches(new URL(url))).toBe(false);
  });
});
