import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

/** Resumable SSE stream. Every event is first committed to the tenant event log. */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "run id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const rawAfter = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("after") ?? "0";
  const after = Number(rawAfter);
  if (!Number.isSafeInteger(after) || after < 0) return fail("invalid_request", "event sequence 无效。", 400, { requestId });
  const admin = createAdminClient();
  const { data: run } = await admin.from("ai_workbench_runs").select("id").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (!run) return fail("not_found", "run 不存在。", 404, { requestId });

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let sequence = after;
      let closed = false;
      const close = () => {
        if (closed || cancelled) return;
        closed = true;
        controller.close();
      };
      const emit = (line: string) => {
        if (!closed && !cancelled) controller.enqueue(encoder.encode(line));
      };
      void (async () => {
        const deadline = Date.now() + 25_000;
        while (!closed && !cancelled && Date.now() < deadline) {
          const { data, error } = await admin.from("ai_agent_run_events")
            .select("sequence, event_type, payload, created_at")
            .eq("organization_id", authz.org.orgId).eq("run_id", id)
            .gt("sequence", sequence).order("sequence", { ascending: true }).limit(100);
          if (error) { emit(`event: error\ndata: ${JSON.stringify({ code: "event_read_failed", request_id: requestId })}\n\n`); close(); return; }
          if (cancelled) return;
          for (const event of data ?? []) {
            sequence = event.sequence;
            emit(`id: ${event.sequence}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          if (cancelled) return;
          const { data: current } = await admin.from("ai_workbench_runs").select("status").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
          if (current && ["awaiting_confirmation", "completed", "partial", "failed", "cancelled"].includes(current.status) && (data?.length ?? 0) === 0) { close(); return; }
          if ((data?.length ?? 0) === 0) await new Promise((resolve) => setTimeout(resolve, 700));
        }
        if (!cancelled) emit(": heartbeat\n\n");
        close();
      })().catch(() => close());
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
