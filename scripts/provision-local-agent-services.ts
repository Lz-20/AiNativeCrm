/** Generate local-only secrets without exposing them to chat, git or stdout.
 * pnpm exec tsx scripts/provision-local-agent-services.ts init|mem0-db|mem0-config
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const directory = resolve("infra/local-agent-services");
const envPath = resolve(directory, ".env.generated");
const secret = () => randomBytes(32).toString("hex");
// WeKnora accepts 8–32 characters; satisfy both simple and complex policies.
const wikiPassword = () => `${randomBytes(12).toString("base64url")}Aa1!`;
async function main() {
  const action = process.argv[2];
  if (action === "wiki-password") {
    const existing = readFileSync(envPath, "utf8");
    if (/^WEKNORA_TENANT_ID=/m.test(existing))
      throw new Error("refuse_to_rotate_existing_wiki_account");
    if (!/^WEKNORA_USER_PASSWORD=[a-f0-9]{64}$/m.test(existing))
      throw new Error("legacy_invalid_password_required");
    writeFileSync(
      envPath,
      existing.replace(
        /^WEKNORA_USER_PASSWORD=[a-f0-9]{64}$/m,
        `WEKNORA_USER_PASSWORD=${wikiPassword()}`,
      ),
      { mode: 0o600 },
    );
    console.info("Unregistered local Wiki bootstrap password repaired; no value printed.");
    return;
  }
  if (action === "init") {
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const values: Record<string, string> = {
      POSTGRES_PASSWORD: secret(),
      ADMIN_API_KEY: secret(),
      JWT_SECRET: secret(),
      WEKNORA_SYSTEM_AES_KEY: randomBytes(16).toString("hex"),
      WEKNORA_SIGNING_KEY: secret(),
      WEKNORA_JWT_SECRET: secret(),
      WEKNORA_USER_PASSWORD: wikiPassword(),
      REDIS_PASSWORD: secret(),
      CLICKHOUSE_PASSWORD: secret(),
      MINIO_PASSWORD: secret(),
      LANGFUSE_NEXTAUTH_SECRET: secret(),
      LANGFUSE_SALT: secret(),
      LANGFUSE_ENCRYPTION_KEY: secret(),
      LANGFUSE_PUBLIC_KEY: `pk-lf-${secret()}`,
      LANGFUSE_SECRET_KEY: `sk-lf-${secret()}`,
      LANGFUSE_USER_PASSWORD: secret(),
      ...(process.env.SERVICE_HTTP_PROXY
        ? { SERVICE_HTTP_PROXY: process.env.SERVICE_HTTP_PROXY }
        : {}),
    };
    const missing = Object.entries(values).filter(
      ([key]) => !existing.split("\n").some((line) => line.startsWith(`${key}=`)),
    );
    if (missing.length)
      writeFileSync(
        envPath,
        existing + missing.map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
        { mode: 0o600 },
      );
    const saved = Object.fromEntries(
      readFileSync(envPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    writeFileSync(
      resolve(directory, ".env.s3.generated"),
      JSON.stringify({
        identities: [
          {
            name: "langfuse-local",
            credentials: [{ accessKey: "crm-local", secretKey: saved.MINIO_PASSWORD }],
            actions: [
              "Admin:langfuse",
              "Read:langfuse",
              "Write:langfuse",
              "List:langfuse",
              "Tagging:langfuse",
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
    console.info("Local credentials generated (0600); no values printed.");
    return;
  }
  if (action === "bindings") {
    const values = Object.fromEntries(
      readFileSync(envPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    const org = "3ea5dbc2-050b-4324-a489-8a17c2b654c3";
    const bindings: Record<string, unknown>[] = [
      {
        organization_id: org,
        provider: "mem0",
        base_url: "http://127.0.0.1:8888",
        api_key: values.ADMIN_API_KEY,
      },
    ];
    if (values.WEKNORA_API_KEY && values.WEKNORA_KB_ID)
      bindings.push({
        organization_id: org,
        provider: "weknora",
        base_url: "http://127.0.0.1:8088",
        api_key: values.WEKNORA_API_KEY,
        knowledge_base_ids: [values.WEKNORA_KB_ID],
        visibility: "organization",
      });
    if (process.argv.includes("--langfuse"))
      bindings.push({
        organization_id: org,
        provider: "langfuse",
        base_url: "http://127.0.0.1:3006",
        public_key: values.LANGFUSE_PUBLIC_KEY,
        secret_key: values.LANGFUSE_SECRET_KEY,
      });
    writeFileSync(
      resolve(directory, ".env.crm.generated"),
      `AI_INTEGRATION_BINDINGS='${JSON.stringify(bindings)}'\n`,
      { mode: 0o600 },
    );
    console.info(
      `Local demo bindings generated for ${bindings.map((b) => b.provider).join(", ")}; no credentials printed.`,
    );
    return;
  }
  if (action !== "mem0-db" && action !== "mem0-config")
    throw new Error("unsupported_provisioning_action");
  const values = Object.fromEntries(
    readFileSync(envPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const connection = {
    host: "127.0.0.1",
    port: 5438,
    user: "postgres",
    password: values.POSTGRES_PASSWORD,
    database: "postgres",
    max: 1,
  };
  const pool = new pg.Pool(connection);
  try {
    for (const database of ["mem0_app", "mem0_vector", "weknora", "langfuse"]) {
      const found = await pool.query("select 1 from pg_database where datname=$1", [database]);
      if (!found.rows.length) await pool.query(`create database ${database}`);
    }
  } finally {
    await pool.end();
  }
  if (action === "mem0-db") {
    console.info("Dedicated Mem0 databases ready; run upstream Alembic before mem0-config.");
    return;
  }
  const app = new pg.Pool({ ...connection, database: "mem0_app" });
  try {
    // Upstream's persistent configuration override is applied before its runtime starts.
    await app.query(
      "insert into settings(key,value) values('config_overrides',$1) on conflict(key) do update set value=excluded.value,updated_at=now()",
      [
        JSON.stringify({
          embedder: {
            provider: "fastembed",
            config: {
              model: "BAAI/bge-small-zh-v1.5",
              embedding_dims: 512,
              model_kwargs: { local_files_only: true, threads: 1 },
            },
          },
          vector_store: { config: { embedding_model_dims: 512, hnsw: false } },
        }),
      ],
    );
    console.info("Dedicated Mem0 databases and local embedding configuration ready.");
  } finally {
    await app.end();
  }
}
void main().catch(() => {
  console.error("Local provisioning failed; credentials suppressed.");
  process.exitCode = 1;
});
