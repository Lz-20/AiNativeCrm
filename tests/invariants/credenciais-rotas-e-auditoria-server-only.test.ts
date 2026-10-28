import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const FIX = readFileSync("supabase/migrations/20261027010000_0409_credenciais_e_auditoria_server_only.sql", "utf8");
const A = "40900000-0000-4000-8000-000000000001";
const B = "40900000-0000-4000-8000-000000000002";
const UA = "40900000-1111-4000-8000-000000000001";
const UB = "40900000-1111-4000-8000-000000000002";
const CODE = "40900000-2222-4000-8000-000000000001";
const seed = `
  insert into auth.users(id,email) values ('${UA}','a-0409@invariant.test'),('${UB}','b-0409@invariant.test');
  insert into public.organizations(id,slug,legal_name,display_name) values
    ('${A}','inv-0409-a','A 0409','A'),('${B}','inv-0409-b','B 0409','B');
  insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
    ('${UA}','${A}','admin',now()),('${UB}','${B}','admin',now());
  insert into public.user_recovery_codes(id,user_id,code_hash) values ('${CODE}','${UA}',decode('abcd','hex'));
  insert into public.phone_numbers(organization_id,number,trunk_endpoint,routing_mode,fallback_user_id) values
    ('${A}','+550000004091','fixture-a','human','${UA}'),
    ('${B}','+550000004092','fixture-b','human','${UB}');
  insert into public.api_audit_log(organization_id,actor_user_id,action) values
    ('${A}','${UA}','inv.0409.original'),('${B}','${UB}','inv.0409.other');
`;

function results(body: string): string[] {
  return sql(`begin; ${seed} ${body} rollback;`).split("\n")
    .filter((line) => line.startsWith("PROBE|"))
    .map((line) => line.slice(6));
}

function role(name: "anon" | "authenticated" | "service_role", user = UA, aal = "aal1"): string {
  return `set local role ${name}; select set_config('request.jwt.claims',
    '{"role":"${name}","sub":"${user}","aal":"${aal}"}',true);`;
}

/** A falha só vale se for 42501; FK, sintaxe ou uma fixture ausente reprovam. */
function denied(command: string): string {
  return `do $probe$ begin
    ${command};
    raise exception 'a operação protegida passou';
  exception when insufficient_privilege then null;
  end $probe$;`;
}

describe.each(["baseline", "forward reaplicado"])("0409 — %s", (mode) => {
  // Recria as permissões antigas antes do forward; aplicar o conserto somente
  // sobre um baseline já corrigido provaria idempotência, mas não o upgrade.
  const oldPermissions = `
    grant all on public.user_recovery_codes to anon, authenticated, service_role;
    drop policy if exists recovery_codes_self on public.user_recovery_codes;
    create policy recovery_codes_self on public.user_recovery_codes
      using (user_id=auth.uid()) with check (user_id=auth.uid());
    grant insert on public.api_audit_log to public, anon, authenticated;
    drop policy if exists audit_log_insert_tenant_member on public.api_audit_log;
    create policy audit_log_insert_tenant_member on public.api_audit_log for insert to authenticated
      with check (organization_id is null or organization_id in (select public.fn_user_org_ids()));
    grant execute on function public.fn_resolve_inbound_number(text) to public, anon, authenticated;
  `;
  const apply = mode === "baseline" ? "" : `${oldPermissions}\n${FIX}\n${FIX}`;

  for (const [name, user, aal] of [
    ["anon", UA, "aal1"], ["authenticated", UA, "aal1"],
    ["authenticated", UA, "aal2"], ["authenticated", UB, "aal2"],
  ] as const) {
    it(`${name}/${user === UA ? "dono" : "outro tenant"}/${aal} não lê nem fabrica/reabre/apaga códigos`, () => {
      expect(results(`
        ${apply} ${role(name, user, aal)}
        ${denied("perform 1 from public.user_recovery_codes")}
        ${denied(`insert into public.user_recovery_codes(user_id,code_hash) values ('${user}',decode('eeee','hex'))`)}
        ${denied(`update public.user_recovery_codes set code_hash=decode('eeee','hex'),used_at=null where id='${CODE}'`)}
        ${denied(`delete from public.user_recovery_codes where id='${CODE}'`)}
        reset role;
        select 'PROBE|' || count(*) || ':' || min(encode(code_hash,'hex')) || ':' || bool_and(used_at is null)
          from public.user_recovery_codes where user_id in ('${UA}','${UB}');
      `)).toEqual(["1:abcd:true"]);
    });
  }

  it("service_role mantém emissão, leitura, consumo único e rotação legítimos", () => {
    expect(results(`
      ${apply} ${role("service_role")}
      insert into public.user_recovery_codes(user_id,code_hash) values ('${UB}',decode('ffff','hex'));
      select 'PROBE|' || count(*) from public.user_recovery_codes where user_id in ('${UA}','${UB}');
      with consumed as (update public.user_recovery_codes set used_at=now()
        where id='${CODE}' and user_id='${UA}' and code_hash=decode('abcd','hex') and used_at is null returning id)
        select 'PROBE|' || count(*) from consumed;
      with consumed as (update public.user_recovery_codes set used_at=now()
        where id='${CODE}' and user_id='${UA}' and code_hash=decode('abcd','hex') and used_at is null returning id)
        select 'PROBE|' || count(*) from consumed;
      delete from public.user_recovery_codes where user_id='${UA}';
      insert into public.user_recovery_codes(user_id,code_hash) values ('${UA}',decode('eeee','hex'));
      select 'PROBE|' || encode(code_hash,'hex') from public.user_recovery_codes where user_id='${UA}';
    `)).toEqual(["2", "1", "0", "eeee"]);
  });

  for (const name of ["anon", "authenticated"] as const) {
    it(`${name} não resolve números de nenhum tenant`, () => {
      expect(results(`
        ${apply} ${role(name)}
        ${denied("perform * from public.fn_resolve_inbound_number('+550000004091')")}
        ${denied("perform * from public.fn_resolve_inbound_number('+550000004092')")}
        reset role;
        select 'PROBE|' || count(*) from public.phone_numbers where organization_id in ('${A}','${B}');
      `)).toEqual(["2"]);
    });
  }

  it("worker service_role ainda resolve cada número para a organização correta", () => {
    expect(results(`${apply} ${role("service_role")}
      select 'PROBE|' || organization_id || ':' || fallback_user_id
        from public.fn_resolve_inbound_number('+550000004091');
      select 'PROBE|' || organization_id || ':' || fallback_user_id
        from public.fn_resolve_inbound_number('+550000004092');
      select 'PROBE|' || count(*) from public.fn_resolve_inbound_number('+550000004099');
    `)).toEqual([`${A}:${UA}`, `${B}:${UB}`, "0"]);
  });

  for (const name of ["anon", "authenticated"] as const) {
    it(`${name} não acrescenta auditoria em nome de plataforma, outro ator ou tenant`, () => {
      expect(results(`
        ${apply} ${role(name, UA, "aal2")}
        ${["null", `'${A}'`, `'${B}'`].map((org) => denied(`
          insert into public.api_audit_log(organization_id,actor_user_id,action,acting_as_platform_admin,bypassed_rls,created_at)
          values (${org},'${UB}','inv.0409.forged',true,true,'2000-01-01')
        `)).join("\n")}
        reset role;
        select 'PROBE|' || count(*) from public.api_audit_log where action='inv.0409.forged';
        select 'PROBE|' || count(*) from public.api_audit_log where action='inv.0409.original';
      `)).toEqual(["0", "1"]);
    });
  }

  it("auditoria legítima conserva atribuição, leitura isolada e proteção append-only", () => {
    expect(results(`
      ${apply} ${role("service_role")}
      insert into public.api_audit_log(organization_id,actor_user_id,action)
        values ('${A}','${UA}','inv.0409.server');
      ${denied("update public.api_audit_log set action='forged' where action='inv.0409.server'")}
      ${denied("delete from public.api_audit_log where action='inv.0409.server'")}
      ${denied("truncate public.api_audit_log")}
      reset role; ${role("authenticated", UA, "aal2")}
      select 'PROBE|' || actor_user_id from public.api_audit_log where action='inv.0409.server';
      select 'PROBE|' || count(*) from public.api_audit_log where action='inv.0409.other';
    `)).toEqual([UA, "0"]);
  });
});

it("dois consumidores PostgreSQL concorrentes têm exatamente um vencedor", async () => {
  // Um caso fora do rollback local para que DUAS conexões enxerguem a mesma linha.
  // Namespace próprio; a limpeza usa postgres e só remove esta fixture.
  const user = "40900000-9999-4000-8000-000000000001";
  const id = "40900000-9999-4000-8000-000000000002";
  sql(`insert into auth.users(id,email) values ('${user}','concurrency-0409@invariant.test');
    insert into public.user_recovery_codes(id,user_id,code_hash) values ('${id}','${user}',decode('abcd','hex'));`);
  const script = `begin; set local role service_role;
    with consumed as (update public.user_recovery_codes set used_at=now()
      where id='${id}' and user_id='${user}' and code_hash=decode('abcd','hex') and used_at is null returning id)
      select 'PROBE|' || count(*) from consumed;
    select pg_sleep(0.1); commit;`;
  const run = async () => {
    const local = process.env.TEST_DB_PSQL;
    const args = local ? [process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres"]
      : ["exec", process.env.TEST_DB_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres"];
    const { stdout } = await promisify(execFile)(local ?? "docker", [...args, "-v", "ON_ERROR_STOP=1", "-tA", "-c", script]);
    return stdout.split("\n").find((line) => line.startsWith("PROBE|"));
  };
  try {
    expect((await Promise.all([run(), run()])).sort()).toEqual(["PROBE|0", "PROBE|1"]);
  } finally {
    sql(`delete from public.user_recovery_codes where user_id='${user}'; delete from auth.users where id='${user}';`);
  }
});
