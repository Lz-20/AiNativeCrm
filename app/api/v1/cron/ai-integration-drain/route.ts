import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { drainEventLog } from "@/lib/event-log/drain";
import { reconcileLangfuseRuns } from "@/lib/ai/integrations/langfuse";
import { integrationBindings } from "@/lib/ai/integrations/config";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function handle(req: NextRequest) {
  const requestId = randomUUID();
  const supplied = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const valid = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].some(
    (secret) =>
      secret &&
      supplied &&
      Buffer.byteLength(secret) === Buffer.byteLength(supplied) &&
      timingSafeEqual(Buffer.from(secret), Buffer.from(supplied)),
  );
  if (!valid) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  if (!integrationBindings().length) return ok({ scanned: 0, projected: 0 }, { requestId });
  try {
    ensureHandlersRegistered();
    // Dedicated lane + single bounded remote operation prevent outages starving CRM business events.
    const summary = await drainEventLog(createAdminClient(), { lane: "integration", limit: 1 });
    const projected = await reconcileLangfuseRuns(getRequestPool()).catch(() => 0);
    if (summary.done || summary.dead || projected)
      await audit({
        action: "ai.integration_drain",
        resourceType: "event_log",
        requestId,
        metadata: { delivered: summary.done, dead: summary.dead, projected },
      });
    return ok({ ...summary, projected }, { requestId });
  } catch {
    return fail("internal_error", "Integration drain unavailable.", 503, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
