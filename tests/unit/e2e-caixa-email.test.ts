// Exercita a sonda REAL do workflow. HTTP 200 de outro serviço não prova
// caixa de e-mail, e uma falha deve parar o job antes das jornadas de Auth.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const workflow = readFileSync(".github/workflows/e2e.yml", "utf8");
const job = workflow.split(/^  e2e-parte:\s*$/m)[1]?.split(/^  [a-z][a-z-]*:\s*$/m)[0] ?? "";
const step = job.match(/      - name: Verificar caixa de e-mail local\n([\s\S]*?)(?=\n      - |$)/)?.[1] ?? "";
const probe = step.match(/          node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/)?.[1]
  ?.split("\n").map(line => line.replace(/^          /, "")).join("\n");

async function exercise(status: number, body: unknown) {
  expect(probe, "a sonda executável precisa existir no workflow").toBeTruthy();
  const server = createServer((req, res) => {
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/v1/messages");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address");
  try {
    return await run(process.execPath, ["--input-type=module", "-e", probe!], {
      env: { ...process.env, MAILPIT_URL: `http://127.0.0.1:${address.port}` },
    }).then(() => true, () => false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("caixa de e-mail real do E2E", () => {
  it("habilita o SMTP local do CLI e usa a mesma porta no leitor de e-mails", () => {
    const enabled = job.match(/^      SUPABASE_LOCAL_SMTP_ENABLED: "(true)"$/m)?.[1];
    const port = job.match(/^      SUPABASE_LOCAL_SMTP_PORT: "(\d+)"$/m)?.[1];
    const url = job.match(/^      MAILPIT_URL: "([^"]+)"$/m)?.[1];
    expect(enabled).toBe("true");
    expect(url).toBeTruthy();
    expect(new URL(url!).hostname).toBe("127.0.0.1");
    expect(new URL(url!).port).toBe(port);
    expect(job.indexOf("- name: Verificar caixa de e-mail local")).toBeGreaterThan(job.indexOf("          supabase start"));
    expect(job.indexOf("- name: Verificar caixa de e-mail local")).toBeLessThan(job.indexOf("- name: Aplicar o baseline.sql"));
  });
  it("aceita a caixa pronta mesmo antes de chegar o primeiro e-mail", async () => {
    expect(await exercise(200, { messages: [], total: 0 })).toBe(true);
  });
  it("recusa uma resposta HTTP de erro", async () => {
    expect(await exercise(401, { messages: [] })).toBe(false);
  });
  it("recusa HTTP 200 que não tenha o contrato do Mailpit", async () => {
    expect(await exercise(200, { status: "ok" })).toBe(false);
  });
});
