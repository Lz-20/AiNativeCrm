import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FeishuWebhookPayload } from "@/lib/ai/internal-collaboration/feishu-webhook";

export type FeishuBindingKind = "tenant_owner" | "member";
type BindingEvent = Extract<FeishuWebhookPayload, { kind: "binding_request" }>;

export class FeishuBindingError extends Error {
  constructor(readonly code: "unavailable" | "forbidden" | "conflict") {
    super(code);
    this.name = "FeishuBindingError";
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** CRM-authenticated half of pairing. The raw secret is never stored or audited. */
export async function issueFeishuBinding(
  pool: Pool,
  input: {
    organizationId: string;
    userId: string;
    kind: FeishuBindingKind;
    tenantKey: string;
    ownerOrganizationId: string;
  },
): Promise<{ token: string; expiresAt: string }> {
  const { organizationId, userId, kind, tenantKey, ownerOrganizationId } = input;
  if (!tenantKey || tenantKey.length > 256)
    throw new FeishuBindingError("unavailable");
  if (kind === "tenant_owner" && ownerOrganizationId !== organizationId)
    throw new FeishuBindingError("forbidden");
  return transaction(pool, async (client) => {
    const { rows: memberships } = await client.query<{ role: string }>(
      `select role from public.user_organizations
       where organization_id=$1 and user_id=$2 and accepted_at is not null
         and revoked_at is null for update`,
      [organizationId, userId],
    );
    const role = memberships[0]?.role;
    if (!role || !["agent", "manager", "admin"].includes(role) ||
        (kind === "tenant_owner" && !["manager", "admin"].includes(role)))
      throw new FeishuBindingError("forbidden");

    const { rows: tenants } = await client.query<{ organization_id: string; active: boolean }>(
      `select organization_id,active from public.ai_internal_platform_tenants
       where provider='feishu' and tenant_key=$1 for update`, [tenantKey],
    );
    const tenant = tenants[0];
    if (tenant && (tenant.organization_id !== organizationId || !tenant.active))
      throw new FeishuBindingError("conflict");
    if (kind === "member" && !tenant)
      throw new FeishuBindingError("unavailable");

    await client.query(
      `update public.ai_internal_identity_challenges set revoked_at=now()
       where organization_id=$1 and user_id=$2 and provider='feishu'
         and consumed_at is null and revoked_at is null`,
      [organizationId, userId],
    );
    const token = randomBytes(32).toString("base64url");
    const { rows } = await client.query<{ expires_at: Date }>(
      `insert into public.ai_internal_identity_challenges
        (organization_id,user_id,provider,tenant_key,kind,token_hash,expires_at)
       values ($1,$2,'feishu',$3,$4,$5,now()+interval '10 minutes')
       returning expires_at`,
      [organizationId, userId, tenantKey, kind, digest(token)],
    );
    return { token, expiresAt: rows[0]!.expires_at.toISOString() };
  });
}

/** A signed private Feishu message supplies the other half; no text declares an identity. */
export async function consumeFeishuBinding(
  pool: Pool,
  event: BindingEvent,
  configuredTenantKey: string,
  ownerOrganizationId: string,
): Promise<{ status: "bound" | "replayed" | "unbound"; organizationId?: string; userId?: string }> {
  if (!configuredTenantKey || event.tenantKey !== configuredTenantKey)
    return { status: "unbound" };
  return transaction(pool, async (client) => {
    // Read only enough to identify the CRM member, then take the same lock
    // order as issuance: membership before challenge. The challenge is read
    // again under FOR UPDATE below so revocation/consumption cannot race us.
    const { rows: targets } = await client.query<{
      organization_id: string; user_id: string;
    }>(
      `select organization_id,user_id from public.ai_internal_identity_challenges
       where provider='feishu' and tenant_key=$1 and token_hash=$2`,
      [event.tenantKey, digest(event.token)],
    );
    const target = targets[0];
    if (!target) return { status: "unbound" as const };
    const { rows: memberships } = await client.query<{ role: string }>(
      `select role from public.user_organizations
       where organization_id=$1 and user_id=$2 and accepted_at is not null
         and revoked_at is null for update`,
      [target.organization_id, target.user_id],
    );
    const { rows } = await client.query<{
      organization_id: string; user_id: string; kind: FeishuBindingKind;
      expires_at: Date; revoked_at: Date | null; consumed_at: Date | null;
      consumed_event_id: string | null; external_user_id: string | null;
    }>(
      `select organization_id,user_id,kind,expires_at,revoked_at,consumed_at,
              consumed_event_id,external_user_id
       from public.ai_internal_identity_challenges
       where provider='feishu' and tenant_key=$1 and token_hash=$2 for update`,
      [event.tenantKey, digest(event.token)],
    );
    const challenge = rows[0];
    if (!challenge) return { status: "unbound" as const };
    if (challenge.consumed_at) {
      return challenge.consumed_event_id === event.eventId &&
        challenge.external_user_id === event.openId
        ? { status: "replayed" as const, organizationId: challenge.organization_id,
          userId: challenge.user_id }
        : { status: "unbound" as const };
    }
    if (challenge.revoked_at || challenge.expires_at.getTime() <= Date.now() ||
        (challenge.kind === "tenant_owner" &&
          challenge.organization_id !== ownerOrganizationId))
      return { status: "unbound" as const };

    const role = memberships[0]?.role;
    if (!role || !["agent", "manager", "admin"].includes(role) ||
        (challenge.kind === "tenant_owner" && !["manager", "admin"].includes(role)))
      return { status: "unbound" as const };

    const { rows: tenants } = await client.query<{ organization_id: string; active: boolean }>(
      `select organization_id,active from public.ai_internal_platform_tenants
       where provider='feishu' and tenant_key=$1 for update`, [event.tenantKey],
    );
    const tenant = tenants[0];
    if (tenant && (tenant.organization_id !== challenge.organization_id || !tenant.active))
      return { status: "unbound" as const };
    if (!tenant) {
      if (challenge.kind !== "tenant_owner") return { status: "unbound" as const };
      await client.query(
        `insert into public.ai_internal_platform_tenants
          (organization_id,provider,tenant_key) values ($1,'feishu',$2)`,
        [challenge.organization_id, event.tenantKey],
      );
    }

    const { rows: existing } = await client.query<{ user_id: string }>(
      `select user_id from public.ai_internal_platform_users
       where provider='feishu' and tenant_key=$1 and external_user_id=$2 for update`,
      [event.tenantKey, event.openId],
    );
    if (existing[0] && existing[0].user_id !== challenge.user_id)
      return { status: "unbound" as const };
    await client.query(
      `update public.ai_internal_platform_users set active=false
       where organization_id=$1 and provider='feishu' and tenant_key=$2
         and user_id=$3 and external_user_id<>$4 and active`,
      [challenge.organization_id, event.tenantKey, challenge.user_id, event.openId],
    );
    const { rows: boundUsers } = await client.query<{ user_id: string }>(
      `insert into public.ai_internal_platform_users
        (organization_id,provider,tenant_key,external_user_id,user_id,active)
       values ($1,'feishu',$2,$3,$4,true)
       on conflict (provider,tenant_key,external_user_id)
       do update set active=true
         where ai_internal_platform_users.user_id=excluded.user_id
       returning user_id`,
      [challenge.organization_id, event.tenantKey, event.openId, challenge.user_id],
    );
    if (!boundUsers[0]) throw new FeishuBindingError("conflict");
    await client.query(
      `update public.ai_internal_identity_challenges
       set consumed_at=now(),consumed_event_id=$2,external_user_id=$3
       where token_hash=$1`,
      [digest(event.token), event.eventId, event.openId],
    );
    return { status: "bound" as const, organizationId: challenge.organization_id,
      userId: challenge.user_id };
  });
}

export async function getFeishuBindingStatus(
  pool: Pool, organizationId: string, userId: string, tenantKey: string,
): Promise<{ tenantBound: boolean; userBound: boolean }> {
  if (!tenantKey) return { tenantBound: false, userBound: false };
  const { rows } = await pool.query<{ tenant_bound: boolean; user_bound: boolean }>(
    `select exists(select 1 from public.ai_internal_platform_tenants t
        where t.organization_id=$1 and t.provider='feishu' and t.tenant_key=$3 and t.active)
       as tenant_bound,
      exists(select 1 from public.ai_internal_platform_users u
        join public.ai_internal_platform_tenants t
          on t.organization_id=u.organization_id and t.provider=u.provider
         and t.tenant_key=u.tenant_key
        where u.organization_id=$1 and u.user_id=$2 and u.provider='feishu'
          and u.tenant_key=$3 and u.active and t.active)
       as user_bound`,
    [organizationId, userId, tenantKey],
  );
  return { tenantBound: rows[0]?.tenant_bound ?? false,
    userBound: rows[0]?.user_bound ?? false };
}
