import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/arm64-pr.yml", "utf8");
const effective = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

/** This PR gate must never acquire a registry or VPS publication path. */
function unsafeCapabilities(source: string): string[] {
  return [
    /\bpush:\s*true\b/,
    /\b(?:packages|contents):\s*write\b/,
    /\bsecrets\./,
    /docker\/login-action/,
    /\b(?:ssh|scp|ainativecrm-deploy)\b/,
    /^ {2}(?:workflow_dispatch|push|pull_request_target):/m,
    /continue-on-error/,
  ].filter((pattern) => pattern.test(source)).map((pattern) => pattern.source);
}

describe("ARM64 PR validation is build-only and bound to the exact source", () => {
  it("has an actual native matrix and the production Dockerfiles", () => {
    expect(effective).toContain("runs-on: ubuntu-24.04-arm");
    expect([...effective.matchAll(/- service: (\w+)/g)].map((match) => match[1]))
      .toEqual(["app", "worker", "scheduler"]);
    expect([...effective.matchAll(/dockerfile: (\S+)/g)].map((match) => match[1]))
      .toEqual(["Dockerfile", "Dockerfile.worker", "Dockerfile.scheduler"]);
    expect(effective).toContain("platforms: linux/arm64");
    expect(effective).toContain("push: false");
    expect(effective).toContain("load: true");
  });

  it("has no publication, privileged token, VPS or manual trigger capability", () => {
    expect(effective).toContain("  pull_request:");
    expect(effective).toContain("  contents: read");
    expect(unsafeCapabilities(effective)).toEqual([]);
  });

  it("detects injected publication and deployment paths (negative controls)", () => {
    expect(unsafeCapabilities(effective.replace("push: false", "push: true"))).not.toEqual([]);
    expect(unsafeCapabilities(effective + "\n    run: ssh oracle-sg deploy\n")).not.toEqual([]);
    expect(unsafeCapabilities(effective + "\n    password: ${{ secrets.VPS_SSH_KEY }}\n")).not.toEqual([]);
  });

  it("checks out and verifies the immutable PR head, not a moving branch", () => {
    expect(effective).toContain("SOURCE_SHA: ${{ github.event.pull_request.head.sha }}");
    expect(effective).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(effective).toContain("persist-credentials: false");
    expect(effective).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(effective).toContain("test \"$(uname -m)\" = aarch64");
    expect(effective).toContain('schema-fingerprint "$SOURCE_SHA"');
  });

  it("requires real checks and rejects any failed or skipped matrix", () => {
    for (const command of ["pnpm typecheck", "pnpm test:db", "pnpm test:db:update"])
      expect(effective).toContain(command);
    for (const path of ["lib/agent-runtime", "lib/ai/agents", "lib/agent-engine/agent", "credentials.test.ts"])
      expect(effective).toContain(path);
    expect(effective).toContain("fail-fast: false");
    expect(effective).toContain("if: always()");
    expect(effective).toContain("needs: images");
    expect(effective).toContain('run: test "$RESULT" = success');
  });

  it("inspects the architecture, runtime version, labels and real routes without networking", () => {
    for (const contract of [
      "image['Architecture'] == 'arm64'", "image['Os'] == 'linux'",
      "'APP_VERSION=' + os.environ['SOURCE_SHA'] in image['Config']['Env']",
      "labels['org.opencontainers.image.revision'] == os.environ['SOURCE_SHA']",
      "labels['io.ainativecrm.schema-sha256'] == os.environ['SCHEMA']",
      "--network none", "/api/v1/ai/agents/[id]/versions/[vid]/test/route",
      "/api/v1/ai/workbench/runs/route", "/app/ai/workbench/page",
      'fs.existsSync("/app/.next/server/" + manifest[route])',
    ]) expect(effective).toContain(contract);
  });
});
