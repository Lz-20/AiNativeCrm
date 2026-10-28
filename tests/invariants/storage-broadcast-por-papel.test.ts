import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sql } from "./psql-transporte";

const FIX = readFileSync("supabase/migrations/20261027010200_0411_storage_e_broadcast_por_papel.sql", "utf8");
const A = "41100000-0000-4000-8000-000000000001";
const B = "41100000-0000-4000-8000-000000000002";
const user = (n: number) => `41100000-1111-4000-8000-${String(n).padStart(12, "0")}`;
const seed = `
  insert into auth.users(id,email) values ${[1, 2, 3, 4, 5, 6].map((n) => `('${user(n)}','u${n}-0411@invariant.test')`).join(",")};
  insert into public.organizations(id,slug,legal_name,display_name) values
    ('${A}','inv-0411-a','A 0411','A'),('${B}','inv-0411-b','B 0411','B');
  insert into public.user_organizations(user_id,organization_id,role,accepted_at,revoked_at) values
    ('${user(1)}','${A}','admin',now(),null),
    ('${user(2)}','${A}','manager',now(),null),
    ('${user(3)}','${A}','viewer',now(),null),
    ('${user(4)}','${A}','manager',null,null),
    ('${user(5)}','${B}','manager',now(),null),
    ('${user(6)}','${A}','manager',now(),now());
  -- Only the minimal native-Postgres fixture lacks platform Storage grants/RLS.
  -- Real Supabase already has RLS and this conditional changes nothing there.
  do $fixture$ begin
    if not (select relrowsecurity from pg_class where oid='storage.objects'::regclass) then
      alter table storage.objects enable row level security;
      grant select,insert,delete on storage.objects to authenticated;
    end if;
  end $fixture$;
  insert into storage.objects(bucket_id,name) values
    ('ai-policy','${A}/411-a.txt'),('ai-policy','${B}/411-b.txt'),
    ('lgpd-exports','${A}/411-a.json');
`;
function asUser(n: number, aal = "aal1", sessionId?: string): string {
  return `set local role authenticated; select set_config('request.jwt.claims',
    '${JSON.stringify({ role: "authenticated", sub: user(n), aal, ...(sessionId ? { session_id: sessionId } : {}) })}',true);`;
}
function probe(body: string, storageApiContext = true): string[] {
  // Supabase Storage #817 blocks direct SQL DELETE before RLS is evaluated.
  // Its API sets this transaction-local flag. These rollback-only fixtures
  // reproduce that API context to test RLS as authenticated, never service_role.
  // No physical objects exist here; upload/download/delete API acceptance is separate.
  const context = storageApiContext ? "set local storage.allow_delete_query = 'true';" : "";
  return sql(`begin; ${FIX} ${FIX} ${seed} ${context} ${body} rollback;`).split("\n")
    .filter((line) => line.startsWith("PROBE|")).map((line) => line.slice(6));
}
const deny = (statement: string) => `do $denied$ begin ${statement};
  raise exception 'unexpected write success'; exception when insufficient_privilege then null; end $denied$;`;

describe("0411: o papel e o vínculo aceito governam Storage direto", () => {
  it("Storage gerenciado recusa DELETE SQL sem o contexto da API", ({ skip }) => {
    const present = probe(`select 'PROBE|' || exists(select 1 from pg_trigger
      where tgrelid='storage.objects'::regclass and tgname='protect_objects_delete'
        and tgenabled='O');`, false);
    if (present[0] === "false") skip(); // Native-Postgres fixture has no managed Storage trigger.
    expect(present).toEqual(["true"]);
    expect(probe(`${asUser(2)}
      select 'PROBE|' || coalesce(nullif(current_setting('storage.allow_delete_query',true),''),'false');
      ${deny("delete from storage.objects where false")}
      select 'PROBE|direct_sql_denied';
    `, false)).toEqual(["false", "direct_sql_denied"]);
  });
  it("manager cria/lê/apaga conhecimento próprio; outro tenant fica invisível", () => {
    expect(probe(`${asUser(2)}
      insert into storage.objects(bucket_id,name) values ('ai-policy','${A}/411-new.txt');
      select 'PROBE|' || count(*) from storage.objects where name like '%/411-%';
      with d as (delete from storage.objects where name='${A}/411-new.txt' returning 1)
        select 'PROBE|' || count(*) from d;
      select 'PROBE|' || count(*) from storage.objects where name='${B}/411-b.txt';
    `)).toEqual(["2", "1", "0"]);
  });
  for (const n of [3, 4, 5, 6]) {
    it(`usuário ${n}: viewer/convite/outro tenant/revogado não escreve nem apaga conhecimento A`, () => {
      expect(probe(`${asUser(n)}
        ${deny(`insert into storage.objects(bucket_id,name) values ('ai-policy','${A}/411-forged.txt')`)}
        with d as (delete from storage.objects where name='${A}/411-a.txt' returning 1)
          select 'PROBE|' || count(*) from d;
        select 'PROBE|' || count(*) from storage.objects where name='${A}/411-a.txt';
      `)).toEqual(["0", n === 3 ? "1" : "0"]);
    });
  }
  for (const n of [1, 2, 3, 4, 5, 6]) {
    it(`LGPD só admin aceito do tenant lê o arquivo: usuário ${n}`, () => {
      expect(probe(`${asUser(n)} select 'PROBE|' || count(*) from storage.objects
        where bucket_id='lgpd-exports' and name='${A}/411-a.json';`)).toEqual([n === 1 ? "1" : "0"]);
    });
  }
});

describe("0411: autorização do topic de Broadcast", () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    it(`topic A confere vínculo aceito e org do usuário ${n}`, () => {
      expect(probe(`${asUser(n)}
        select 'PROBE|' || public.fn_broadcast_topic_permitido('org:${A}:queue');
        select 'PROBE|' || public.fn_broadcast_topic_permitido('alerts-platform');
        select 'PROBE|' || public.fn_broadcast_topic_permitido('tenant-health-${A}');
        select 'PROBE|' || public.fn_broadcast_topic_permitido('org:invalid:queue');
      `)).toEqual([n <= 3 ? "true" : "false", "false", "false", "false"]);
    });
  }
  it("nenhum helper novo é executável por anon; a publicação alcança as notas", () => {
    expect(probe(`select 'PROBE|' || has_function_privilege('anon','public.fn_membro_ativo_com_papel(uuid,text)','EXECUTE');
      select 'PROBE|' || has_function_privilege('anon','public.fn_broadcast_topic_permitido(text)','EXECUTE');
      select 'PROBE|' || exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
        and schemaname='public' and tablename='conversation_notes');
    `)).toEqual(["false", "false", "true"]);
  });
});

const platform = (required: boolean, revoked = false) => `
  insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason,revoked_at)
    values ('${user(1)}','${user(1)}','full',${required},'fixture 0411',${revoked ? "now()" : "null"});`;
const platformTopics = `
  select 'PROBE|' || public.fn_broadcast_topic_permitido('alerts-platform');
  select 'PROBE|' || public.fn_broadcast_topic_permitido('tenant-health-${A}');
  select 'PROBE|' || public.fn_broadcast_topic_permitido('tenant-agents-${B}');`;

describe("0411: Broadcast de plataforma exige a política MFA e a prova da sessão", () => {
  it("platform admin ativo sem MFA exigido/fator cadastrado lê os três topics", () => {
    expect(probe(`${platform(false)} ${asUser(1)} ${platformTopics}`))
      .toEqual(["true", "true", "true"]);
  });
  it("MFA exigido barra aal1 mesmo SEM fator cadastrado", () => {
    expect(probe(`${platform(true)} ${asUser(1)} ${platformTopics}`))
      .toEqual(["false", "false", "false"]);
  });
  it("MFA exigido com prova aal2 permite a leitura", () => {
    expect(probe(`${platform(true)} ${asUser(1, "aal2")} ${platformTopics}`))
      .toEqual(["true", "true", "true"]);
  });
  it("platform admin revogado continua negado mesmo com aal2", () => {
    expect(probe(`${platform(false, true)} ${asUser(1, "aal2")} ${platformTopics}`))
      .toEqual(["false", "false", "false"]);
  });
  it("admin somente de tenant continua sem acesso de plataforma com aal2", () => {
    expect(probe(`${asUser(1, "aal2")} ${platformTopics}`))
      .toEqual(["false", "false", "false"]);
  });
  for (const aal of ["aal1", "aal2"]) {
    it(`TOTP já verificado requer prova independente de mfa_required: ${aal}`, () => {
      // Both the native fixture and GoTrue use these four columns. GoTrue's
      // timestamps are required; add them only where the managed columns exist.
      const factor = `do $factor$ begin
        if exists(select 1 from pg_attribute where attrelid='auth.mfa_factors'::regclass
          and attname='created_at' and not attisdropped) then
          insert into auth.mfa_factors(id,user_id,status,factor_type,created_at,updated_at)
            values ('41100000-3333-4000-8000-000000000001','${user(1)}','verified','totp',now(),now());
        else
          insert into auth.mfa_factors(id,user_id,status,factor_type)
            values ('41100000-3333-4000-8000-000000000001','${user(1)}','verified','totp');
        end if;
      end $factor$;`;
      expect(probe(`${platform(false)} ${factor} ${asUser(1, aal)} ${platformTopics}`))
        .toEqual(Array(3).fill(aal === "aal2" ? "true" : "false"));
    });
  }
});

describe("0411: suporte tem org e papel próprios e não recebe Broadcast de plataforma", () => {
  const SESSION = "41100000-4444-4000-8000-000000000001";
  for (const scenario of [
    { name: "full ativo", mode: "full", expiry: "now()+interval '1 hour'", admin: true, revoked: false, read: "true", write: "true" },
    { name: "readonly ativo", mode: "support_readonly", expiry: "now()+interval '1 hour'", admin: true, revoked: false, read: "true", write: "false" },
    { name: "expirado", mode: "full", expiry: "now()-interval '1 hour'", admin: true, revoked: false, read: "false", write: "false" },
    { name: "plataforma revogada", mode: "full", expiry: "now()+interval '1 hour'", admin: true, revoked: true, read: "false", write: "false" },
    { name: "sem autoridade de plataforma", mode: "full", expiry: "now()+interval '1 hour'", admin: false, revoked: false, read: "false", write: "false" },
  ]) {
    it(scenario.name, () => {
      expect(probe(`
        ${scenario.admin ? platform(false, scenario.revoked) : ""}
        insert into auth.sessions(id,user_id,aal,not_after)
          values ('${SESSION}','${user(1)}','aal1',now()+interval '2 hours');
        insert into public.platform_support_sessions(organization_id,actor_user_id,auth_session_id,access_mode,expires_at)
          values ('${B}','${user(1)}','${SESSION}','${scenario.mode}',${scenario.expiry});
        ${asUser(1, "aal1", SESSION)}
        ${platformTopics}
        select 'PROBE|' || public.fn_broadcast_topic_permitido('org:${B}:queue');
        select 'PROBE|' || public.fn_broadcast_topic_permitido('org:${A}:queue');
        select 'PROBE|' || public.fn_membro_ativo_com_papel('${B}','manager');
      `)).toEqual(["false", "false", "false", scenario.read, "false", scenario.write]);
    });
  }
});
