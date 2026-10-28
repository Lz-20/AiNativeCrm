// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(__dirname, "../../hostgator-setup-kit/install.sh"),
  "utf8",
).replaceAll("\r\n", "\n");

function definition(start: string, end: string) {
  const begin = source.indexOf(`${start}() {`);
  const finish = source.indexOf(`${end}()`, begin);
  if (begin < 0 || finish < 0) throw new Error(`Validador ausente: ${start}`);
  return source.slice(begin, finish);
}

// Executa apenas as funções reais de validação, sem carregar o instalador,
// arquivos de ambiente ou iniciar serviços. curl é uma função local: nenhuma
// requisição sai do processo, inclusive nos casos de credencial aceita.
const program = `
${definition("jwt_claim", "v_domain")}
${definition("v_sb_key", "v_anon")}
exec 3>&2
curl() { printf 'CURL_CALLED\\n' >&3; printf '200'; }
NEXT_PUBLIC_SUPABASE_URL="$3"
v_sb_key "$1" "$2"
`;

function validate(key: string, role: string, url = "") {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", program, "fixture", key, role, url],
    {
      cwd: tmpdir(),
      // Não propaga BASH_ENV nem credenciais do processo que executa o teste.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        LANG: "C.UTF-8",
        NODE_ENV: "test",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return {
    status: result.status,
    message: result.stdout,
    calledHttp: result.stderr.includes("CURL_CALLED"),
  };
}

function legacyKey(role: string, ref = "fixture") {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ role, ref })).toString("base64url"),
    "fixture-signature",
  ].join(".");
}

describe.each(["", "https://fixture.invalid"])("chaves do instalador com URL '%s'", (url) => {
  it.each([
    ["sb_secret_installer_fixture", "anon"],
    ["sb_publishable_installer_fixture", "service_role"],
  ])("rejeita %s no campo %s antes de HTTP", (key, role) => {
    const result = validate(key, role, url);
    expect(result.status).toBe(1);
    expect(result.calledHttp).toBe(false);
    expect(result.message).not.toContain(key);
  });

  it.each([
    ["sb_publishable_installer_fixture", "anon"],
    ["sb_secret_installer_fixture", "service_role"],
  ])("aceita o tipo %s no campo %s e mantém a prova HTTP", (key, role) => {
    const result = validate(key, role, url);
    expect(result.status).toBe(0);
    expect(result.calledHttp).toBe(Boolean(url));
  });
});

describe("compatibilidade das chaves JWT legadas no instalador", () => {
  it.each(["anon", "service_role"])("preserva %s e a conferência de papel", (role) => {
    const key = legacyKey(role);
    expect(validate(key, role).status).toBe(0);
    const wrongRole = validate(key, role === "anon" ? "service_role" : "anon");
    expect(wrongRole.status).toBe(1);
    expect(wrongRole.calledHttp).toBe(false);
  });

  it("rejeita JWT de outro projeto antes da consulta HTTP", () => {
    const result = validate(legacyKey("anon", "other-project"), "anon", "https://fixture.invalid");
    expect(result.status).toBe(1);
    expect(result.calledHttp).toBe(false);
    expect(result.message).toContain("OUTRO projeto");
  });
});
