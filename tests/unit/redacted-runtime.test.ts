// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const WRAPPER = join(ROOT, "docker/redacted-runtime.cjs");
const secret = 'fixture-private-$value-"quoted"-and-\\slash';

function run(source: string, env: Record<string, string> = {}, direct = false) {
  return new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => {
    // O controle direto reproduz o CMD anterior, sem supervisor.
    const args = direct ? ["-e", source] : [WRAPPER, "--", process.execPath, "-e", source];
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ out, err, code }));
  });
}

describe("supervisor de logs em processos reais", () => {
  const chunks = `
    const s=process.env.INTERNAL_SECRET;
    process.stdout.write('normal antes\\ncredencial '+s.slice(0,12));
    setTimeout(()=>{
      process.stdout.write(s.slice(12)+'\\nnormal depois\\n');
      process.stderr.write('stderr '+s.slice(0,7));
      setTimeout(()=>process.stderr.write(s.slice(7)),10);
    },10);`;

  it("o controle sem supervisor detecta o vazamento original em ambos os streams", async () => {
    const result = await run(chunks, { INTERNAL_SECRET: secret }, true);
    expect(result.out).toContain(secret);
    expect(result.err).toContain(secret);
  });

  it("retém a linha completa entre chunks e protege também o EOF sem newline", async () => {
    expect(existsSync(WRAPPER)).toBe(true);
    const result = await run(chunks, { INTERNAL_SECRET: secret });
    expect(result.code).toBe(0);
    expect(result.out).toContain("normal antes\n");
    expect(result.out).toContain("normal depois\n");
    expect(result.out).not.toContain(secret);
    expect(result.err).not.toContain(secret);
    expect(result.out).toContain("[REDACTED]");
    expect(result.err).toContain("[REDACTED]");
  });

  it("oculta valores de env, codificação JSON/URL e a senha isolada da URL do banco", async () => {
    const password = "fixture-db-p@ss:/word";
    const database = `postgres://postgres:${encodeURIComponent(password)}@db:5432/postgres`;
    const result = await run(`
      const s=process.env.INTERNAL_SECRET;
      process.stdout.write(JSON.stringify({message:s})+'\\n'+encodeURIComponent(s)+'\\n');
      const u=new URL(process.env.DATABASE_URL);
      process.stdout.write(process.env.DATABASE_URL+'\\n'+decodeURIComponent(u.password)+'\\n');
      process.stdout.write(process.env.JWT_KEYS+'\\nfixture-jwk-private-material\\n');
    `, { INTERNAL_SECRET: secret, DATABASE_URL: database, JWT_KEYS: '{"keys":[{"d":"fixture-jwk-private-material"}]}' });
    expect(result.code).toBe(0);
    for (const value of [secret, JSON.stringify(secret).slice(1,-1), encodeURIComponent(secret), password, database, "fixture-jwk-private-material"])
      expect(result.out).not.toContain(value);
  });

  it("oculta tokens dinâmicos, cookies e assinaturas que não vieram do env", async () => {
    const samples = [
      'Authorization: Bearer dynamic-auth-secret',
      '{"cookie":"session=dynamic-cookie; next=other-cookie","apikey":"dynamic-api-secret"}',
      'set-cookie: session=dynamic-set-cookie; HttpOnly',
      'url=https://storage.invalid/object?token=dynamic-signed-token&x=1',
      'https://example.invalid/?X-Amz-Signature=dynamic-signature&X-Amz-Credential=dynamic-credential',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl',
      'connect postgres://user:dynamic-uri-password@db.invalid:5432/postgres',
      '{"refresh_token":"dynamic-refresh","password":"dynamic-password","x-api-key":"dynamic-header"}',
      'provider sb_secret_dynamic-provider-secret sk-dynamic-provider-secret',
      'https://fixture.test/object?X-Amz-Security-Token=dynamic-temporary-token&part=1',
    ];
    const result = await run(`process.stdout.write(${JSON.stringify(samples.join("\n"))});`);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/dynamic-|eyJhbGci|other-cookie/);
    expect(result.out).toContain("[REDACTED]");
  });

  it("descarta a linha enorme inteira, inclusive o prefixo, e retoma na próxima", async () => {
    const result = await run(`
      process.stdout.write('PREFIX-MUST-DISAPPEAR:'+process.env.INTERNAL_SECRET);
      process.stdout.write('x'.repeat(70000));
      process.stdout.write('SUFFIX-MUST-DISAPPEAR\\nnormal retomado\\n');
      process.stderr.write('EOF-MUST-DISAPPEAR'+'x'.repeat(70000));
    `, { INTERNAL_SECRET: secret });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("MUST-DISAPPEAR");
    expect(result.err).not.toContain("MUST-DISAPPEAR");
    expect(result.out).not.toContain(secret);
    expect(result.out).toContain("log_line_dropped");
    expect(result.err).toContain("log_line_dropped");
    expect(result.out).toContain("normal retomado\n");
    expect(result.out.length + result.err.length).toBeLessThan(1000);
  });

  it("protege JSON e util.inspect com chaves camelCase, arrays e valores multilinha", async () => {
    const samples = [
      "{ 'x-api-key': 'opaque-inspect-api' }",
      "{ 'set-cookie': [ 'sb-auth=opaque-cookie; HttpOnly' ] }",
      '{"accessToken":"opaque-access","refreshToken":"opaque-refresh","set-cookie":["opaque-json-cookie"]}',
      "{ headers: { 'set-cookie': [",
      "    'sb-auth=opaque-multiline-cookie; HttpOnly',",
      "    'sb-auth.1=opaque-continuation; HttpOnly'",
      "  ] } }",
      "normal depois do array",
      "{ authorization: {",
      "  value: 'opaque-object-token'",
      "} }",
      "accessToken:",
      "  'opaque-next-line'",
      "normal depois do valor",
      "{ rawHeaders: ['Cookie', 'opaque-raw-header'] }",
    ];
    const result = await run(`for(const line of ${JSON.stringify(samples)}) process.stdout.write(line+'\\n');`);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("opaque-");
    expect(result.out).toContain("normal depois do array\n");
    expect(result.out).toContain("normal depois do valor\n");
  });

  it("mantém contexto sensível mesmo quando o campo só aparece após 64KiB", async () => {
    const result = await run(`
      process.stdout.write('x'.repeat(70000)+" 'set-cookie': [\\n 'opaque-long-cookie',\\n]\\nnormal recuperado\\n");
      process.stderr.write("'cookie': [\\n  'opaque-long-string"+'x'.repeat(70000)+"',\\n  'opaque-next-cookie'\\n]\\nnormal stderr\\n");
    `);
    expect(result.code).toBe(0);
    expect(result.out + result.err).not.toContain("opaque-");
    expect(result.out).toContain("log_line_dropped");
    expect(result.out).toContain("normal recuperado\n");
    expect(result.err).toContain("normal stderr\n");
  });

  it("protege Map, null-prototype e instâncias que util.inspect formata com prefixo", async () => {
    const result = await run(`
      const {inspect}=require('node:util');
      const samples=[
        new Map([['set-cookie',['opaque-map-cookie']]]),
        {cookies:Object.assign(Object.create(null),{session:'opaque-null-cookie'})},
        {cookies:new(class SessionBag {constructor(){this.value='opaque-class-cookie'}})()},
      ];
      for(const item of samples) process.stdout.write(inspect(item,{compact:false})+'\\n');
      process.stdout.write('normal depois do inspect\\n');
    `);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("opaque-");
    expect(result.out).toContain("normal depois do inspect\n");
  });

  it("preserva Unicode dividido entre chunks e o código de saída do negócio", async () => {
    const result = await run(`
      const b=Buffer.from('ação 中文\\n');
      for(let i=0;i<b.length;i++) process.stdout.write(b.subarray(i,i+1));
      process.exitCode=17;
    `);
    expect(result).toEqual({ code: 17, out: "ação 中文\n", err: "" });
  });

  it.skipIf(process.platform === "win32")("encaminha TERM ao filho e preserva sua saída final", async () => {
    const result = await new Promise<{ out: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [WRAPPER, "--", process.execPath, "-e", `
        process.on('SIGTERM',()=>{process.stdout.write('terminou\\n');process.exit(23)});
        process.stdout.write('pronto\\n');setInterval(()=>{},1000);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; if(out.includes("pronto")) child.kill("SIGTERM"); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ out, code }));
    });
    expect(result.code).toBe(23);
    expect(result.out).toContain("terminou");
  });

  it("ambas as imagens executam o supervisor e o worker inclui o ffmpeg real", () => {
    for (const file of ["Dockerfile", "Dockerfile.worker"])
      expect(readFileSync(join(ROOT, file), "utf8")).toMatch(/CMD.*redacted-runtime\.cjs/);
    expect(readFileSync(join(ROOT, "Dockerfile.worker"), "utf8")).toMatch(/apk add --no-cache ffmpeg/);
  });
});
