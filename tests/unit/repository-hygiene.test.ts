/**
 * Root session notes obscured the product entry points. Keep historical notes
 * in docs, ignore private local output, but never hide deploy/demo/test source.
 * Query Git's real ignore engine rather than matching .gitignore text.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

function ignored(file: string): boolean {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", file], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect([0, 1], result.stderr).toContain(result.status);
  return result.status === 0;
}

describe("repository hygiene", () => {
  it.each([
    "output/session/report.md",
    "tmp/probe.json",
    "scratchpad/task.md",
    ".local/settings.json",
    "secrets/provider.json",
    "credentials/key.json",
    ".env.local",
    ".env.e2e",
    ".auth/session.json",
    ".e2e-new-fixture.json",
    "backups/env.bak",
    ".qa-backups/db.dump",
    "private.sql.gz",
    "session.har",
    "browser.trace.zip",
    "client.p12",
    "client.pfx",
    "tls.private.key",
    "docker-compose.override.yaml",
    "docker-compose.local.yml",
    "docker-compose.local.yaml",
    "compose.override.yml",
    "compose.override.yaml",
    "HANDOFF-next-session.md",
    "RELATORIO-next-session.md",
  ])("ignores local/private artifact %s", (file) => {
    expect(ignored(file), file).toBe(true);
  });

  it.each([
    ".env.example",
    ".env.hostgator.example",
    ".env.voip.example",
    "pnpm-lock.yaml",
    "docker-compose.yml",
    "docker-compose.prod.yml",
    ".github/workflows/e2e.yml",
    "infra/local-agent-services/docker-compose.yml",
    "examples/chat-first-demo/dist/index.html",
    "tests/e2e/configs/live.config.ts",
    "supabase/baseline.sql",
  ])("does not hide reviewed source/configuration %s", (file) => {
    expect(ignored(file), file).toBe(false);
  });

  it("keeps tracked session reports out of the root", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => /^(?:HANDOFF.*|RELATORIO-.*)\.md$/.test(file))).toEqual([]);
    expect(files).not.toContain("playwright.acceptance.config.ts");
    expect(files).not.toContain("playwright.live.config.ts");
    expect(
      files.filter(
        (file) =>
          /^(?:output|tmp|scratchpad|\.local|secrets|credentials|backups|\.qa-backups|\.auth)\//.test(
            file,
          ) ||
          /(^|\/)node_modules(?:\/|$)/.test(file) ||
          (/(^|\/)\.env/.test(file) && !/\.example$/.test(file)) ||
          /\.(?:dump|har|trace\.zip)$/.test(file),
      ),
      "private runtime artifacts must not be tracked even with git add -f",
    ).toEqual([]);
  });

  it.each(["acceptance", "live"])("resolves relocated %s test and artifact paths", (name) => {
    const configPath = resolve(root, `tests/e2e/configs/${name}.config.ts`);
    const config = readFileSync(configPath, "utf8");
    const base = dirname(configPath);
    for (const [key, expected] of [
      ["testDir", "tests/e2e"],
      ["outputDir", "test-results"],
      ...(name === "acceptance" ? [["globalTeardown", "tests/e2e/global-teardown.ts"]] : []),
    ]) {
      const value = config.match(new RegExp(`${key}:\\s*"([^"]+)"`))?.[1];
      expect(value, `${name}: ${key}`).toBeDefined();
      expect(resolve(base, value!)).toBe(resolve(root, expected!));
    }
    expect(existsSync(resolve(root, "tests/e2e/global-teardown.ts"))).toBe(true);
    const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
    expect(scripts[`test:e2e:${name}`]).toBe(
      `playwright test --config tests/e2e/configs/${name}.config.ts`,
    );
  });
});
