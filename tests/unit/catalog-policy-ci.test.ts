import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/catalog-policy-ci.yml", "utf8")
  .split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const unsafe = (text: string) => /workflow_dispatch|pull_request_target|^  push:|secrets\.|packages:|contents: write|ssh\s|staging-release|continue-on-error|\|\| true|self-hosted/m.test(text);

describe("Catalog PR gate measures real PostgreSQL without deployment authority", () => {
  it("has only the read-only PR trigger and native immutable source", () => {
    expect(workflow).toContain("  pull_request:");
    expect(workflow).toContain("  contents: read");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(workflow).toContain('test "$(uname -m)" = aarch64');
    expect(unsafe(workflow)).toBe(false);
  });
  it("executes actual controller, protocol and pinned PostgreSQL fixture checks", () => {
    for (const command of [
      "python3 -m unittest discover -s tests/deployment -p 'test_*.py' -v",
      "python3 tests/staging_ci_test.py -v",
      "docker pull --platform linux/arm64 supabase/postgres:17.6.1.136@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00",
      "python3 tests/deployment/catalog_isolated_test.py",
      "set -euo pipefail", "source-files.sha256", "if: always()",
    ]) expect(workflow).toContain(command);
  });
  it("rejects injected bypasses, publishing privileges or remote access", () => {
    for (const injected of ["\n  push:", "continue-on-error: true", "run: ssh oracle-sg", "password: ${{ secrets.VPS_KEY }}", "contents: write"])
      expect(unsafe(workflow + "\n" + injected)).toBe(true);
  });
});
