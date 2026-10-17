/** Print a minimized JSON recording from local demo SQL. Never writes or calls a model.
 * pnpm exec tsx --env-file=.env.e2e scripts/export-real-demo-trace.ts <run-uuid>
 * Review stdout before committing; never export production/customer runs.
 */
import pg from "pg";
import { z } from "zod";
import { parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { publicDemoText, publicDemoTools } from "@/lib/ai/agents/demo-trace";
import { inspectProductFinalAnswer } from "@/lib/ai/agents/final-answer";

async function main() {
  const id = z.string().uuid().parse(process.argv[2]);
  // A marker alone is not consent to publish arbitrary customer answers.
  // Public recordings require explicit curation and human review of stdout.
  if (!["614417da-04ad-49c6-9d0c-d3a3572bb631", "b825d92a-ec59-42c6-9db9-aa66b0cc954c",
    "77c6a3cd-0829-4c66-88d1-9d4781c159de", "aab97675-7364-4c1a-bded-4cbe3e580566",
    "977a7a88-41c1-4219-ba1f-9ea4e20e0b1f", "bda3c380-2184-496c-94a6-8a9e40919ec8"].includes(id))
    throw new Error("curated_public_recording_required");
  const url = new URL(process.env.SUPABASE_DB_URL ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("local_demo_only");
  const pool = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const { rows: runs } = await pool.query(`select r.id,r.organization_id,r.task,r.status,r.mode,r.final_text,r.started_at,r.completed_at
      from ai_workbench_runs r join organizations o on o.id=r.organization_id
      where r.id=$1 and o.slug='pi-native-demo' and r.mode='inspect'
      and (r.task like '[2026-10-03 memory regression]%' or r.task like '[2026-10-03 integrations live check]%')`, [id]);
    const run = runs[0];
    if (!run || !["completed", "partial", "failed"].includes(run.status)) throw new Error("ended_synthetic_demo_required");
    if (inspectProductFinalAnswer(run.final_text ?? "").internalDraftCodes.length) throw new Error("unsafe_answer_boundary");
    const org = run.organization_id;
    const state = await pool.query("select messages from ai_agent_run_states where organization_id=$1 and run_id=$2", [org, id]);
    const messages = parseRuntimeMessages(state.rows[0]?.messages);
    if (!messages) throw new Error("valid_persisted_state_required");
    const events = await pool.query("select sequence,event_type,payload,created_at from ai_agent_run_events where organization_id=$1 and run_id=$2 order by sequence", [org, id]);
    const calls = await pool.query(`select purpose,provider,model,status,input_tokens,output_tokens,cache_read_tokens,latency_ms,cost_cents
      from llm_calls where organization_id=$1 and workbench_run_id=$2 order by created_at`, [org, id]);
    const reports = await pool.query(`select report,input_fingerprint,created_at from ai_agent_eval_reports
      where organization_id=$1 and run_id=$2 order by created_at`, [org, id]);
    const receipt = await pool.query(`select count(*)::int as count from ai_customer_memories m
      join contacts c on c.id=m.contact_id and c.organization_id=m.organization_id
      where m.organization_id=$1 and c.source='demo' and c.is_anonymized=false and c.is_merged_into is null
        and c.id='6842302c-a864-4a4e-8dc5-a605f6c10827'
        and m.created_at<=$2 and (m.deleted_at is null or m.deleted_at>$3)`, [org, run.started_at, run.completed_at]);
    console.info(JSON.stringify({
      schemaVersion: 1, provenance: "recorded_real_model_synthetic_crm", date: "2026-10-03", runId: run.id,
      task: publicDemoText(run.task), status: run.status, mode: run.mode,
      startedAt: run.started_at, completedAt: run.completed_at,
      independentConfirmedMemoryCount: receipt.rows[0]?.count ?? null,
      modelCalls: calls.rows,
      tools: publicDemoTools(messages),
      events: events.rows.map(e => ({ sequence: e.sequence, type: e.event_type, at: e.created_at,
        ...(typeof e.payload?.tool === "string" ? { tool: publicDemoText(e.payload.tool) } : {}),
        ...(typeof e.payload?.status === "string" ? { status: publicDemoText(e.payload.status) } : {}),
      })),
      finalAnswer: publicDemoText(run.final_text ?? ""),
      evaluations: reports.rows.map(row => ({
        at: row.created_at, fingerprint: row.input_fingerprint,
        profileKey: row.report.profileKey, profileRevision: row.report.profileRevision,
        verdict: row.report.verdict, score: row.report.score,
        dimensions: row.report.dimensions.map((d: { key: string; verdict: string; score: number; findings: Array<{code: string}> }) => ({ key: d.key, verdict: d.verdict, score: d.score, findings: d.findings.map(f => f.code) })),
        semanticJudge: { status: row.report.semanticJudge.status, verdict: row.report.semanticJudge.verdict,
          score: row.report.semanticJudge.score, rubricRevision: row.report.semanticJudge.rubricRevision,
          judgeId: row.report.semanticJudge.judgeId,
        },
      })),
      boundaries: { syntheticCustomer: true, credentialsIncluded: false, hiddenReasoningIncluded: false,
        rawToolBodiesIncluded: false, mem0: "not_measured_by_export", weknora: "not_measured_by_export", langfuse: "not_measured_by_export" },
    }, null, 2));
  } finally { await pool.end(); }
}
void main().catch(() => { console.error("Cannot export: only a verified ended local synthetic demo is allowed."); process.exitCode = 1; });
