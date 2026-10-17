import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(`infra/local-agent-services/${name}`, "utf8");
describe("optional real local Agent services", () => {
  it("pins images, scopes network exposure to loopback and limits every service", () => {
    const compose = read("compose.yml");
    const services = compose.split(/\n  [a-z][a-z0-9-]*:\n/).slice(1, 9);
    expect(services).toHaveLength(8);
    for (const service of services) {
      expect(service).toContain("mem_limit:");
      expect(service).toContain("cpus:");
    }
    expect(compose).not.toMatch(/image:.*:latest/);
    expect(compose).not.toMatch(/ports:.*"(?:3006|8088|8888|5438|8333):/);
    expect(compose).toContain('AUTH_DISABLED: "false"');
    expect(compose).toContain('HF_HUB_OFFLINE: "1"');
    expect(compose).toContain('TELEMETRY_ENABLED: "false"');
    expect(compose).toContain("profiles: [mem0]");
    expect(compose).toContain("profiles: [wiki]");
    expect(compose).toContain("profiles: [langfuse]");
  });
  it("does not put generated credentials into build contexts or publish host paths", () => {
    expect(read(".dockerignore")).toContain(".env*");
    expect(read("compose.yml")).not.toContain("./.env.s3.generated:");
    expect(read("Mem0FastEmbed.py")).toContain("**self.config.model_kwargs");
    expect(read("Mem0.Dockerfile")).toContain("BAAI/bge-small-zh-v1.5");
  });
  it("keeps registration closed by default and verifies v4 persisted data with bounded reads", () => {
    expect(read("compose.yml")).toContain("WEKNORA_DISABLE_REGISTRATION:-true");
    const probe = readFileSync("scripts/verify-local-agent-services.ts", "utf8");
    expect(probe).toContain("/api/public/v2/observations?");
    expect(probe).toContain("/api/public/v3/scores?");
    expect(probe).toContain("fromStartTime");
    expect(probe).toContain("scores_must_belong_to_verified_trace");
    expect(probe).toContain("private_content_must_not_be_exported");
  });
});
