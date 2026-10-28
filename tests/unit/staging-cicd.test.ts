import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ler = (path: string) => readFileSync(path, "utf8");

describe("staging: release limitado ao código aprovado e aos três serviços", () => {
  it("executa os testes reais do protocolo, inclusive árvore Git e manifest adulterado", () => {
    expect(() =>
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["tests/staging_ci_test.py"],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("executa o controlador de deploy e o verificador de backup contra suas fixtures", () => {
    const run = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      ["-m", "unittest", "discover", "-s", "tests/deployment", "-p", "test_*.py", "-v"],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/Ran [1-9]\d* tests/);
  });

  it("publica ARM64 nativo e mantém o deploy automático desligado por padrão", () => {
    const workflow = ler(".github/workflows/staging-release.yml");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("platforms: linux/arm64");
    expect(workflow).toContain("vars.STAGING_AUTO_DEPLOY == 'true'");
    expect(workflow).toMatch(/default: build/);
    expect(workflow).not.toMatch(
      /setup-qemu|StrictHostKeyChecking=no|ssh-keyscan|secrets: inherit/,
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("ghcr.io/lz-20/ainativecrm-");
    expect(workflow).toContain("io.ainativecrm.schema-sha256");
  });

  it("reutiliza gates reais antes de liberar o manifest para implantação", () => {
    const workflow = ler(".github/workflows/staging-release.yml");
    for (const file of ["ci.yml", "perf.yml", "e2e.yml"]) {
      expect(ler(`.github/workflows/${file}`)).toMatch(/^  workflow_call:/m);
      expect(workflow).toContain(`uses: ./.github/workflows/${file}`);
    }
    expect(workflow).toContain("needs: [prepare, images, ci-checks, build-check, e2e-check]");
    expect(workflow).toContain("check-status");
    expect(workflow).toContain("verify-release");
  });

  it("nenhuma action externa nova usa ref mutável nem build recebe segredo de servidor", () => {
    const workflow = ler(".github/workflows/staging-release.yml");
    const refs = [...workflow.matchAll(/uses:\s+([^\s]+)@([^\s]+)/g)];
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) expect(ref[2]).toMatch(/^[0-9a-f]{40}$/);
    const images = workflow.split("\n  images:\n")[1]!.split("\n  manifest:\n")[0]!;
    expect(images).not.toMatch(
      /SUPABASE_SERVICE|DATABASE_URL|VPS_SSH_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
    expect(images).toContain("APP_VERSION=${{ github.sha }}");
  });
});
