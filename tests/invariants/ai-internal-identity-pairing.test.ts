import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  consumeFeishuBinding, getFeishuBindingStatus, issueFeishuBinding,
} from "@/lib/ai/internal-collaboration/feishu-binding";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
  ], { input: script, encoding: "utf8" }).trim();
}

const org = "a4020000-0000-4000-8000-000000000001";
const otherOrg = "b4020000-0000-4000-8000-000000000002";
const owner = "a4020000-1111-4000-8000-000000000001";
const member = "a4020000-1111-4000-8000-000000000002";
const other = "b4020000-1111-4000-8000-000000000002";
const tenantKey = "tenant-binding-test";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${owner}','binding-owner@invariant.test'),
      ('${member}','binding-member@invariant.test'),
      ('${other}','binding-other@invariant.test');
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${org}','identity-pair-a','Identity A','Identity A'),
      ('${otherOrg}','identity-pair-b','Identity B','Identity B');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
      ('${owner}','${org}','manager',now()),
      ('${member}','${org}','agent',now()),
      ('${other}','${otherOrg}','manager',now());
  `);
});
afterAll(async () => { await pool.end(); });

describe("Feishu identity pairing against the real schema", () => {
  it("requires configured org ownership, signed-DM identity and single-use challenge", async () => {
    await expect(issueFeishuBinding(pool, {
      organizationId: otherOrg, userId: other, kind: "tenant_owner",
      tenantKey, ownerOrganizationId: org,
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(issueFeishuBinding(pool, {
      organizationId: org, userId: member, kind: "member", tenantKey,
      ownerOrganizationId: org,
    })).rejects.toMatchObject({ code: "unavailable" });

    const issued = await issueFeishuBinding(pool, {
      organizationId: org, userId: owner, kind: "tenant_owner", tenantKey,
      ownerOrganizationId: org,
    });
    expect(issued.token).toHaveLength(43);
    expect(sql(`select count(*) from public.ai_internal_identity_challenges
      where token_hash='${issued.token}'`)).toBe("0");
    const event = { kind: "binding_request" as const, tenantKey,
      eventId: "bind-event-1", openId: "ou_owner", token: issued.token };
    expect(await consumeFeishuBinding(pool, event, tenantKey, org))
      .toMatchObject({ status: "bound", organizationId: org, userId: owner });
    expect(await consumeFeishuBinding(pool, event, tenantKey, org))
      .toMatchObject({ status: "replayed" });
    expect((await consumeFeishuBinding(pool, { ...event, eventId: "bind-event-2" },
      tenantKey, org)).status).toBe("unbound");
    expect((await consumeFeishuBinding(pool, { ...event, openId: "ou_other" },
      tenantKey, org)).status).toBe("unbound");
    expect(await getFeishuBindingStatus(pool, org, owner, tenantKey))
      .toEqual({ tenantBound: true, userBound: true });
    expect(await getFeishuBindingStatus(pool, otherOrg, other, tenantKey))
      .toEqual({ tenantBound: false, userBound: false });
  });

  it("blocks cross-user takeover, expired/revoked challenges and revoked members", async () => {
    const first = await issueFeishuBinding(pool, {
      organizationId: org, userId: member, kind: "member", tenantKey,
      ownerOrganizationId: org,
    });
    const replacement = await issueFeishuBinding(pool, {
      organizationId: org, userId: member, kind: "member", tenantKey,
      ownerOrganizationId: org,
    });
    const event = { kind: "binding_request" as const, tenantKey,
      eventId: "bind-event-member", openId: "ou_member", token: first.token };
    expect((await consumeFeishuBinding(pool, event, tenantKey, org)).status).toBe("unbound");
    expect((await consumeFeishuBinding(pool, { ...event, token: replacement.token,
      openId: "ou_owner" }, tenantKey, org)).status).toBe("unbound");
    expect((await consumeFeishuBinding(pool, { ...event, token: replacement.token },
      "another-tenant", org)).status).toBe("unbound");
    expect((await consumeFeishuBinding(pool, { ...event, token: replacement.token },
      tenantKey, org)).status).toBe("bound");

    const expired = await issueFeishuBinding(pool, {
      organizationId: org, userId: member, kind: "member", tenantKey,
      ownerOrganizationId: org,
    });
    sql(`update public.ai_internal_identity_challenges set expires_at=now()-interval '1 minute'
      where token_hash=encode(sha256(convert_to('${expired.token}','UTF8')),'hex')`);
    expect((await consumeFeishuBinding(pool, { ...event, eventId: "expired",
      token: expired.token }, tenantKey, org)).status).toBe("unbound");
    const revoked = await issueFeishuBinding(pool, {
      organizationId: org, userId: member, kind: "member", tenantKey,
      ownerOrganizationId: org,
    });
    sql(`update public.user_organizations set revoked_at=now()
      where organization_id='${org}' and user_id='${member}'`);
    expect((await consumeFeishuBinding(pool, { ...event, eventId: "revoked",
      token: revoked.token }, tenantKey, org)).status).toBe("unbound");
    expect(sql(`select active::text from public.ai_internal_platform_users
      where provider='feishu' and tenant_key='${tenantKey}'
        and external_user_id='ou_member'`)).toBe("true");
    // Existing mapping is harmless after membership revocation: downstream joins reject it.
    expect(sql(`select has_table_privilege('authenticated',
      'public.ai_internal_identity_challenges','select')::text`)).toBe("false");
  });
});
