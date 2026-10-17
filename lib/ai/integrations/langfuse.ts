import { integrationQuery } from "./db";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { RuntimeObservation } from "@/lib/agent-runtime/types";
import type { AgentEvalReport } from "@/lib/ai/evals/contracts";
import type { EventHandler, EventRow } from "@/lib/event-log/dispatcher";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { enabledIntegration, integrationBinding, integrationBindings } from "./config";
import { integrationFetch } from "./http";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const langfuseTraceId = (org: string, root: string) =>
  hash(`crm:v1:${org}:${root}`).slice(0, 32);
const spanId = (value: string) => hash(value).slice(0, 16);
const eventId = (value: string) => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const runSpanId = (org: string, run: string) => spanId(`crm-run:${org}:${run}`);
const safeName = (value: string) => (/^[a-zA-Z0-9_./:-]{1,100}$/.test(value) ? value : "redacted");
const attributeKey = z.enum([
  "langfuse.observation.type",
  "langfuse.observation.model.name",
  "langfuse.observation.usage_details",
  "langfuse.trace.name",
  "langfuse.session.id",
  "langfuse.trace.metadata.crm_run",
  "langfuse.trace.metadata.crm_attempt",
  "langfuse.trace.metadata.crm_org",
  "langfuse.observation.metadata.tool",
  "langfuse.observation.metadata.status",
  "langfuse.observation.metadata.message_count",
  "gen_ai.system",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
]);
const spanSchema = z
  .object({
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    spanId: z.string().regex(/^[a-f0-9]{16}$/),
    parentSpanId: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
    name: z.enum(["crm.run", "crm.specialist", "crm.call", "crm.model", "crm.tool"]),
    kind: z.literal(1),
    startTimeUnixNano: z.string().regex(/^\d+$/),
    endTimeUnixNano: z.string().regex(/^\d+$/),
    attributes: z
      .array(
        z
          .object({
            key: attributeKey,
            value: z.union([
              z.object({ stringValue: z.string().max(2000) }).strict(),
              z.object({ intValue: z.string().regex(/^\d+$/) }).strict(),
            ]),
          })
          .strict(),
      )
      .max(24),
    status: z.object({ code: z.union([z.literal(1), z.literal(2)]) }).strict(),
  })
  .strict();
type Span = z.infer<typeof spanSchema>;
const scoreSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    observationId: z.string().regex(/^[a-f0-9]{16}$/),
    name: z
      .string()
      .regex(
        /^crm\.(task_completion|answer_quality|knowledge_grounding|tool_reliability|policy_compliance|efficiency|collaboration_quality|overall|semantic)$/,
      ),
    value: z.number().min(0).max(100),
    dataType: z.literal("NUMERIC"),
    timestamp: z.string().datetime(),
    metadata: z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        profile_revision: z.number().int(),
        rubric_revision: z.number().int().nullable(),
      })
      .strict(),
  })
  .strict();
const payloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("spans"),
      spans: z.array(spanSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("scores"),
      scores: z.array(scoreSchema).max(10),
    })
    .strict(),
]);
type Payload = z.infer<typeof payloadSchema>;
const attr = (
  key: z.infer<typeof attributeKey>,
  value: string | number,
): Span["attributes"][number] => ({
  key,
  value:
    typeof value === "number"
      ? { intValue: String(Math.max(0, Math.floor(value))) }
      : { stringValue: value },
});
function makeSpan(input: {
  traceId: string;
  id: string;
  parent?: string;
  name: Span["name"];
  start: number;
  end: number;
  status: string;
  attributes: Span["attributes"];
}): Span {
  return spanSchema.parse({
    traceId: input.traceId,
    spanId: input.id,
    ...(input.parent ? { parentSpanId: input.parent } : {}),
    name: input.name,
    kind: 1,
    startTimeUnixNano: String(BigInt(Math.floor(input.start)) * 1_000_000n),
    endTimeUnixNano: String(
      BigInt(Math.max(Math.floor(input.start), Math.floor(input.end))) * 1_000_000n,
    ),
    attributes: [...input.attributes, attr("langfuse.observation.metadata.status", input.status)],
    status: { code: input.status === "error" || input.status === "failed" ? 2 : 1 },
  });
}
async function enqueue(
  pool: Pool,
  org: string,
  run: string,
  key: string,
  payload: Payload,
  metadata: Record<string, string> = {},
) {
  // Stable primary key makes retries safe even after an ambiguous DB acknowledgement.
  await integrationQuery(
    pool,
    `insert into event_log (id, organization_id, event_type, entity_kind, entity_id, payload, metadata)
     values ($1,$2,'ai_integration.langfuse_export','ai_workbench_run',$3,$4::jsonb,$5::jsonb) on conflict (id) do nothing`,
    [
      eventId(`${org}:${key}`),
      org,
      run,
      JSON.stringify(payloadSchema.parse(payload)),
      JSON.stringify(metadata),
    ],
  );
}

/** No prompt, tool arguments/results, private continuation, exception text or actor PII crosses this seam. */
export async function beginLangfuseCall(pool: Pool, org: string, run: string | null | undefined) {
  if (!run || !integrationBinding(org, "langfuse")) return null;
  const binding = await enabledIntegration(pool, org, "langfuse");
  if (!binding) return null;
  const { rows } = await integrationQuery<{ parent_run_id: string | null }>(
    pool,
    "select parent_run_id from ai_workbench_runs where organization_id=$1 and id=$2",
    [org, run],
  );
  if (!rows[0]) return null;
  const root = rows[0].parent_run_id ?? run;
  const traceId = langfuseTraceId(org, root);
  const attempt = randomUUID();
  const callId = spanId(attempt);
  const startedAt = Date.now();
  const shared = [
    attr("langfuse.trace.name", "CRM Agent"),
    attr("langfuse.session.id", hash(`${org}:${root}`)),
    attr("langfuse.trace.metadata.crm_org", hash(org)),
    attr("langfuse.trace.metadata.crm_run", hash(run)),
    attr("langfuse.trace.metadata.crm_attempt", attempt),
  ];
  const spans: Span[] = [];
  return {
    onObservation(observation: RuntimeObservation) {
      spans.push(
        makeSpan({
          traceId,
          id: spanId(`${attempt}:${observation.kind}:${observation.id}`),
          parent: callId,
          name: observation.kind === "generation" ? "crm.model" : "crm.tool",
          start: observation.startedAt,
          end: observation.endedAt,
          status: observation.status,
          attributes: [
            ...shared,
            attr("langfuse.observation.type", observation.kind),
            ...(observation.kind === "tool"
              ? [attr("langfuse.observation.metadata.tool", safeName(observation.name))]
              : []),
            ...(observation.model
              ? [attr("langfuse.observation.model.name", safeName(observation.model))]
              : []),
            ...(observation.provider
              ? [attr("gen_ai.system", safeName(observation.provider))]
              : []),
            ...(observation.messageCount !== undefined
              ? [attr("langfuse.observation.metadata.message_count", observation.messageCount)]
              : []),
            ...(observation.usage
              ? [
                  attr("gen_ai.usage.input_tokens", observation.usage.inputTokens),
                  attr("gen_ai.usage.output_tokens", observation.usage.outputTokens),
                  attr(
                    "langfuse.observation.usage_details",
                    JSON.stringify({
                      input: observation.usage.inputTokens,
                      output: observation.usage.outputTokens,
                      cache_read_input_tokens: observation.usage.cacheReadTokens,
                      cache_creation_input_tokens: observation.usage.cacheWriteTokens,
                    }),
                  ),
                ]
              : []),
          ],
        }),
      );
    },
    async finish(status: "ok" | "error" | "cancelled") {
      if (status === "ok" && spans.some((span) => span.status.code === 2)) status = "error";
      spans.push(
        makeSpan({
          traceId,
          id: callId,
          parent: runSpanId(org, run),
          name: "crm.call",
          start: startedAt,
          end: Date.now(),
          status,
          attributes: [...shared, attr("langfuse.observation.type", "agent")],
        }),
      );
      // Bounded chunks remain the exact same bytes/IDs on delivery retry.
      for (let i = 0; i < spans.length; i += 400)
        await enqueue(pool, org, run, `call:${attempt}:${i}`, {
          version: 1,
          kind: "spans",
          spans: spans.slice(i, i + 400),
        });
    },
  };
}

/** Authoritative SQL lifecycle creates the parent observation, including specialist parentage. */
export async function projectLangfuseRun(pool: Pool, org: string, run: string) {
  if (!(await enabledIntegration(pool, org, "langfuse"))) return;
  const { rows } = await integrationQuery<{
    parent_run_id: string | null;
    started_at: string;
    completed_at: string;
    completion_key: string;
    status: string;
  }>(
    pool,
    "select parent_run_id,started_at,completed_at,completed_at::text as completion_key,status from ai_workbench_runs where organization_id=$1 and id=$2",
    [org, run],
  );
  const row = rows[0];
  if (!row?.started_at || !row.completed_at) return;
  const root = row.parent_run_id ?? run;
  const span = makeSpan({
    traceId: langfuseTraceId(org, root),
    id: runSpanId(org, run),
    ...(row.parent_run_id ? { parent: runSpanId(org, root) } : {}),
    name: row.parent_run_id ? "crm.specialist" : "crm.run",
    start: Date.parse(row.started_at),
    end: Date.parse(row.completed_at),
    status: row.status,
    attributes: [
      attr("langfuse.observation.type", "agent"),
      attr("langfuse.trace.name", "CRM Agent"),
      attr("langfuse.session.id", hash(`${org}:${root}`)),
      attr("langfuse.trace.metadata.crm_org", hash(org)),
      attr("langfuse.trace.metadata.crm_run", hash(run)),
    ],
  });
  await enqueue(
    pool,
    org,
    run,
    `run:${run}:${row.completed_at}`,
    { version: 1, kind: "spans", spans: [span] },
    { completion_key: row.completion_key },
  );
}

/** Scores mirror canonical CRM reports; never run an extra LLM judge in the exporter. */
export async function projectLangfuseEvaluation(
  pool: Pool,
  org: string,
  report: AgentEvalReport,
  fingerprint: string,
) {
  if (!(await enabledIntegration(pool, org, "langfuse"))) return;
  const { rows } = await integrationQuery<{ parent_run_id: string | null }>(
    pool,
    "select parent_run_id from ai_workbench_runs where organization_id=$1 and id=$2",
    [org, report.runId],
  );
  if (!rows[0]) return;
  const values = [
    ...report.dimensions.map((d) => ({ name: d.key, value: d.score })),
    { name: "overall", value: report.score },
    ...(report.semanticJudge.status === "completed"
      ? [{ name: "semantic", value: report.semanticJudge.score }]
      : []),
  ];
  const timestamp = new Date().toISOString();
  const scores = values
    .filter((v): v is { name: string; value: number } => typeof v.value === "number")
    .map((v) =>
      scoreSchema.parse({
        id: hash(`${org}:${report.runId}:${fingerprint}:${v.name}`),
        traceId: langfuseTraceId(org, rows[0]!.parent_run_id ?? report.runId),
        observationId: runSpanId(org, report.runId),
        name: `crm.${v.name}`,
        value: v.value,
        dataType: "NUMERIC",
        timestamp,
        metadata: {
          fingerprint,
          profile_revision: report.profileRevision,
          rubric_revision: report.semanticJudge.rubricRevision ?? null,
        },
      }),
    );
  // Duplicate projection keeps the first stored timestamp (required by Langfuse score deduplication).
  await enqueue(pool, org, report.runId, `scores:${report.runId}:${fingerprint}`, {
    version: 1,
    kind: "scores",
    scores,
  });
}

export async function exportLangfuseEvent(row: EventRow, pool: Pool, fetchImpl?: typeof fetch) {
  const binding = await enabledIntegration(pool, row.organization_id, "langfuse");
  if (!binding) return "disabled" as const;
  const payload = payloadSchema.parse(row.payload);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Basic ${Buffer.from(`${binding.public_key}:${binding.secret_key}`).toString("base64")}`,
    "x-langfuse-ingestion-version": "4",
  };
  if (payload.kind === "spans") {
    await integrationFetch(
      binding,
      "/api/public/otel/v1/traces",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [{ key: "service.name", value: { stringValue: "crm-agent" } }],
              },
              scopeSpans: [{ scope: { name: "crm.pi", version: "1" }, spans: payload.spans }],
            },
          ],
        }),
      },
      fetchImpl,
    );
  } else {
    const batch = payload.scores.map(({ timestamp, ...body }) => ({
      id: body.id,
      type: "score-create",
      timestamp,
      body,
    }));
    if (batch.length) {
      // Score-only ingestion remains supported in v4; the timestamp belongs to its envelope.
      const response = await integrationFetch(
        binding,
        "/api/public/ingestion",
        { method: "POST", headers, body: JSON.stringify({ batch }) },
        fetchImpl,
      );
      const receipt = z
        .object({
          successes: z.array(z.object({ id: z.string() }).passthrough()),
          errors: z.array(z.unknown()),
        })
        .parse(await response.json());
      if (
        receipt.errors.length ||
        batch.some((item) => !receipt.successes.some((success) => success.id === item.id))
      )
        throw new Error("langfuse_score_receipt_incomplete");
    }
  }
  return "delivered" as const;
}

export const langfuseExportHandler: EventHandler = {
  lane: "integration",
  key: "ai_integration.langfuse_v1",
  events: ["ai_integration.langfuse_export"],
  async handle(row) {
    try {
      const status = await exportLangfuseEvent(row, getRequestPool());
      return status === "disabled"
        ? {
            consumer_key: this.key,
            status: "retry",
            retry_at: new Date(Date.now() + 300_000).toISOString(),
            detail: "integration_disabled",
          }
        : { consumer_key: this.key, status: "ok" };
    } catch {
      return { consumer_key: this.key, status: "error", detail: "langfuse_export_failed" };
    }
  },
};

/** SQL transaction endings also reach this reconciliation path through the existing cron. */
export async function reconcileLangfuseRuns(pool: Pool) {
  const orgs = integrationBindings()
    .filter((item) => item.provider === "langfuse")
    .map((binding) => binding.organization_id);
  if (!orgs.length) return 0;
  const { rows } = await integrationQuery<{ id: string; organization_id: string }>(
    pool,
    `select r.id,r.organization_id from ai_workbench_runs r join ai_integration_settings s
     on s.organization_id=r.organization_id and s.provider='langfuse' and s.enabled=true
     where r.organization_id=any($1::uuid[]) and r.completed_at is not null and r.completed_at>=s.updated_at
     and not exists(select 1 from event_log e where e.organization_id=r.organization_id and e.entity_id=r.id
       and e.event_type='ai_integration.langfuse_export' and e.metadata->>'completion_key'=r.completed_at::text)
     order by r.completed_at limit 2`,
    [orgs],
  );
  for (const row of rows) await projectLangfuseRun(pool, row.organization_id, row.id);
  return rows.length;
}
