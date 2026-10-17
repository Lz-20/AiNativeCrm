import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
function sourceFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesIn(path);
    return /\.tsx?$/.test(entry.name) ? [path.slice(ROOT.length + 1)] : [];
  });
}

const sourceFiles = sourceFilesIn(ROOT);

describe("Pi runtime architecture boundary", () => {
  it("keeps direct Pi SDK imports inside the Pi adapter directory", () => {
    const offenders = sourceFiles.filter((relativePath) => {
      const source = readFileSync(`${ROOT}/${relativePath}`, "utf8");
      return (
        /@earendil-works\/pi-(?:agent-core|ai)/.test(source) &&
        !relativePath.startsWith("lib/agent-runtime/pi/") &&
        !relativePath.startsWith("tests/agent-runtime/fixtures/")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the CRM runtime contract provider-neutral", () => {
    const contract = readFileSync(`${ROOT}/lib/agent-runtime/types.ts`, "utf8");
    expect(contract).not.toMatch(/@earendil-works\/pi|from ['"]ai['"]/);
  });

  it("injects the AgentRuntime contract at the worker composition root", () => {
    const worker = readFileSync(`${ROOT}/workers/agent-worker/main.ts`, "utf8");
    expect(worker).toContain("createAgentRuntime");
    expect(worker).toContain("runtime: createAgentRuntime()");

    const route = readFileSync(`${ROOT}/app/api/internal/agents/run/route.ts`, "utf8");
    expect(route).toContain("createAgentRuntime");
    expect(route).toContain("runtime: createAgentRuntime()");
  });

  it("keeps CRM tools and the model gateway free of Pi SDK types", () => {
    const files = [
      "lib/agent-engine/agent/inbound-turn.ts",
      "lib/agent-engine/edge/llm/run-model-call.ts",
      "lib/agent-runtime/model-gateway.ts",
    ];
    for (const file of files) {
      expect(readFileSync(`${ROOT}/${file}`, "utf8")).not.toMatch(/@earendil-works\/pi-/);
    }
  });

  it("keeps CRM turn policy outside the generic model execution seam", () => {
    const inbound = readFileSync(`${ROOT}/lib/agent-engine/agent/inbound-turn.ts`, "utf8");
    const execution = readFileSync(`${ROOT}/lib/agent-engine/agent/pi-turn-execution.ts`, "utf8");
    expect(inbound).toContain("executePiTurnModelCall");
    expect(inbound).not.toContain("await runModelCall(");
    expect(execution).toContain("runModelCall");
    expect(execution).toContain("runtime: deps.runtime");
  });

  it("keeps the static CRM tool registry outside the turn orchestrator", () => {
    const inbound = readFileSync(`${ROOT}/lib/agent-engine/agent/inbound-turn.ts`, "utf8");
    const definitions = readFileSync(`${ROOT}/lib/agent-engine/agent/tool-definitions.ts`, "utf8");
    expect(inbound).toMatch(/import \{ AGENT_TOOL_DEFS \} from ["']\.\/tool-definitions["'];/);
    expect(inbound).not.toContain("export const AGENT_TOOL_DEFS = {");
    expect(definitions).toContain("export const AGENT_TOOL_DEFS = {");
    expect(definitions).toContain("request_human_handoff");
    expect(definitions).toContain("send_template");
    expect(definitions).toContain('capability: "send" as const');
    expect(definitions).toContain('capability: "handoff" as const');
  });

  it("keeps CRM context assembly behind a dedicated context builder", () => {
    const inbound = readFileSync(`${ROOT}/lib/agent-engine/agent/inbound-turn.ts`, "utf8");
    const contextBuilder = readFileSync(
      `${ROOT}/lib/agent-engine/agent/context-builder.ts`,
      "utf8",
    );
    expect(inbound).toMatch(/from ["']\.\/context-builder["']/);
    expect(inbound).not.toContain("export function ritualBlocks(");
    expect(inbound).not.toContain("export function buildOpeningMessage(");
    expect(contextBuilder).toContain("export function ritualBlocks(");
    expect(contextBuilder).toContain("projetarContexto");
  });

  it("keeps the durable checkpoint contract outside the turn orchestrator", () => {
    const inbound = readFileSync(`${ROOT}/lib/agent-engine/agent/inbound-turn.ts`, "utf8");
    const checkpoint = readFileSync(
      `${ROOT}/lib/agent-engine/agent/checkpoint-contract.ts`,
      "utf8",
    );
    expect(inbound).toMatch(/from ["']\.\/checkpoint-contract["']/);
    expect(inbound).not.toContain("export const checkpointContentSchema = z.object");
    expect(checkpoint).toContain("export const checkpointContentSchema = z.object");
    expect(checkpoint).toContain("export function parseCheckpointText(");
    expect(checkpoint).toContain("export const CHECKPOINT_INSTRUCTION");
  });

  it("keeps Pi out of CRM domain, MCP, and channel tool implementations", () => {
    const domains = ["lib/agent-engine/agent", "lib/agent-engine/edge/crm", "lib/mcp"];
    const offenders = domains.flatMap((directory) =>
      sourceFilesIn(`${ROOT}/${directory}`).filter((relativePath) =>
        /@earendil-works\/pi-(?:agent-core|ai)/.test(
          readFileSync(`${ROOT}/${relativePath}`, "utf8"),
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the Pi adapter independent from CRM persistence infrastructure", () => {
    const piSources = sourceFilesIn(`${ROOT}/lib/agent-runtime/pi`);
    const offenders = piSources.filter((relativePath) =>
      /from ["'](?:pg|@\/lib\/supabase|@\/lib\/agent-engine\/db)|ai_agent_runs|supabase/i.test(
        readFileSync(`${ROOT}/${relativePath}`, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the Model Gateway free of agent-loop controls", () => {
    const gateway = readFileSync(`${ROOT}/lib/agent-runtime/model-gateway.ts`, "utf8");
    expect(gateway).not.toMatch(
      /generateText|streamText|agentLoop|shouldStopAfterTurn|stepCountIs/,
    );
  });

  it("forwards provider-neutral hooks and normalized events through the model seam", () => {
    const gateway = readFileSync(`${ROOT}/lib/agent-engine/edge/llm/run-model-call.ts`, "utf8");
    const adapter = readFileSync(`${ROOT}/lib/agent-runtime/pi/ai-sdk-compat.ts`, "utf8");
    expect(gateway).toContain("input.beforeToolCall");
    expect(gateway).toContain("events: result.events");
    expect(adapter).toContain("transformContext");
    expect(adapter).toContain("afterToolCall");
    expect(adapter).toContain("events: result.events");
  });

  it("keeps the persisted-run composition outside the Pi adapter without a second loop", () => {
    const crmRun = readFileSync(`${ROOT}/lib/agent-engine/agent/ai-agent-run.ts`, "utf8");
    expect(crmRun).not.toMatch(/generateText|stepCountIs|stopWhen/);
    expect(crmRun).toContain("runModelCall");
    expect(crmRun).not.toContain("runPiAiSdkCall");
    expect(crmRun).toContain("runtime: input.runtime");
    expect(crmRun).toContain('purpose: "agent_turn"');
    expect(crmRun).not.toContain("createAgentRuntime");
    expect(crmRun).not.toContain("@deprecated");
    expect(() => readFileSync(`${ROOT}/lib/ai/runtime/agent.ts`, "utf8")).toThrow();
  });

  it("keeps the Pi compatibility entrypoint behind the runtime seam", () => {
    const offenders = sourceFiles.filter((relativePath) => {
      if (relativePath.startsWith("tests/")) return false;
      if (relativePath.startsWith("lib/agent-runtime/pi/")) return false;
      if (relativePath === "lib/agent-engine/edge/llm/run-model-call.ts") return false;
      return readFileSync(`${ROOT}/${relativePath}`, "utf8").includes("runPiAiSdkCall");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps runtime pricing inside the Model Gateway", () => {
    const productionFiles = sourceFiles.filter(
      (relativePath) => !relativePath.startsWith("tests/"),
    );
    const offenders = productionFiles.filter((relativePath) => {
      const source = readFileSync(`${ROOT}/${relativePath}`, "utf8");
      return /computeCostCents|@\/lib\/ai\/runtime\/cost/.test(source);
    });
    expect(offenders).toEqual([]);
    expect(() => readFileSync(`${ROOT}/lib/ai/runtime/cost.ts`, "utf8")).toThrow();
  });

  it("uses Pi when a production caller omits an explicit runtime selector", () => {
    const seam = readFileSync(`${ROOT}/lib/agent-engine/edge/llm/run-model-call.ts`, "utf8");
    expect(seam).toContain('input.runtimeMode ?? cfg.runtimeMode ?? "pi"');
    expect(seam).not.toMatch(/generateText|streamText|stepCountIs|stopWhen/);
    expect(seam).not.toContain('runtimeMode === "legacy"');
    const fixture = readFileSync(`${ROOT}/lib/agent-engine/agent/request-deps.ts`, "utf8");
    expect(fixture).toContain("createPreviewAgentRuntime");
    expect(fixture).not.toContain('runtimeMode = "legacy"');
  });

  it("does not expose the removed legacy selector through production env schemas", () => {
    const appEnv = readFileSync(`${ROOT}/lib/env.ts`, "utf8");
    const workerEnv = readFileSync(`${ROOT}/lib/agent-engine/env.ts`, "utf8");
    const credentials = readFileSync(`${ROOT}/lib/agent-engine/edge/llm/credentials.ts`, "utf8");
    const envExample = readFileSync(`${ROOT}/.env.example`, "utf8");
    expect(appEnv).not.toMatch(/enum\(\["legacy"/);
    expect(workerEnv).not.toMatch(/enum\(\["legacy"/);
    expect(credentials).not.toContain('runtimeMode !== "legacy"');
    const contract = readFileSync(`${ROOT}/lib/agent-runtime/types.ts`, "utf8");
    expect(contract).not.toContain('"legacy"');
    expect(envExample).toContain("AGENT_RUNTIME=pi");
    expect(envExample).not.toContain("legacy");
  });
});
