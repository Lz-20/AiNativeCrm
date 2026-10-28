import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const forward = readFileSync("supabase/migrations/20261027010100_0410_lgpd_comandas_na_cascata.sql", "utf8");
const oldMigration = readFileSync("supabase/migrations/20260921030200_0370_prospeccao_anonimizacao.sql", "utf8");
// Somente a definição antiga, para simular um clone que recebeu 0370. Nenhum
// resto da migration histórica é aplicado a um banco que já está atualizado.
const oldStart = oldMigration.lastIndexOf('CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"');
const oldEnd = oldMigration.indexOf("$$;", oldStart) + 3;
if (oldStart < 0 || oldEnd < oldStart) throw new Error("definição 0370 ausente");
const oldFunction = oldMigration.slice(oldStart, oldEnd);

const A = "41000000-0000-4000-8000-000000000001";
const B = "41000000-0000-4000-8000-000000000002";
const ALVO = "41000000-1111-4000-8000-000000000001";
const VIZINHO = "41000000-1111-4000-8000-000000000002";
const OUTRO_TENANT = "41000000-1111-4000-8000-000000000003";
const seed = `
  insert into public.organizations(id,slug,legal_name,display_name) values
    ('${A}','lgpd-0410-a','LGPD A','A'),('${B}','lgpd-0410-b','LGPD B','B');
  insert into public.contacts(id,organization_id,display_name) values
    ('${ALVO}','${A}','Pessoa alvo'),('${VIZINHO}','${A}','Pessoa vizinha'),('${OUTRO_TENANT}','${B}','Pessoa de B');
  insert into public.sales(organization_id,number,contact_id,status,total_cents,notes,cancel_reason,reverse_reason) values
    ('${A}',1,'${ALVO}','cancelled',2500,'PII notes','PII cancel','PII reverse'),
    ('${A}',2,'${VIZINHO}','open',3500,'vizinho',null,null),
    ('${B}',1,'${OUTRO_TENANT}','open',4500,'outro tenant',null,null);
`;

function probe(body: string): string[] {
  return sql(`begin; ${seed} ${body} rollback;`).split("\n")
    .filter((line) => line.startsWith("PROBE|"))
    .map((line) => line.slice(6));
}

describe.each(["fresh baseline", "upgrade de 0370"])("0410 — %s", (mode) => {
  const apply = mode === "fresh baseline" ? "" : `${oldFunction}\n${forward}\n${forward}`;

  it("apaga texto pessoal sem perder valor, status ou vínculo financeiro; vizinhos ficam intactos", () => {
    const out = probe(`
      ${apply}
      select 'PROBE|' || notes || ':' || cancel_reason || ':' || reverse_reason
        from public.sales where organization_id='${A}' and number=1;
      set local role service_role;
      select public.fn_lgpd_cascade_redact_contact('${A}','${ALVO}',gen_random_uuid());
      reset role;
      select 'PROBE|' || (notes is null)::text || ':' || cancel_reason || ':' || reverse_reason || ':' || total_cents || ':' || status || ':' || contact_id
        from public.sales where organization_id='${A}' and number=1;
      select 'PROBE|' || notes || ':' || total_cents from public.sales where organization_id='${A}' and number=2;
      select 'PROBE|' || notes || ':' || total_cents from public.sales where organization_id='${B}' and number=1;
    `);
    expect(out[0]).toBe("PII notes:PII cancel:PII reverse");
    expect(out[1]).toBe(`true:[redigido]:[redigido]:2500:cancelled:${ALVO}`);
    expect(out.slice(2)).toEqual(["vizinho:3500", "outro tenant:4500"]);
  });

  it("anon e authenticated não invocam a cascata privilegiada", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(probe(`
        ${apply}
        set local role ${role};
        do $probe$ begin
          perform public.fn_lgpd_cascade_redact_contact('${A}','${ALVO}',gen_random_uuid());
          raise exception 'cascata pública';
        exception when insufficient_privilege then null; end $probe$;
        reset role;
        select 'PROBE|' || notes from public.sales where organization_id='${A}' and number=1;
      `)).toEqual(["PII notes"]);
    }
  });
});

it("controle: reinstalar somente a função 0370 reproduz a perda de anonimização da comanda", () => {
  expect(probe(`
    ${oldFunction}
    set local role service_role;
    select public.fn_lgpd_cascade_redact_contact('${A}','${ALVO}',gen_random_uuid());
    reset role;
    select 'PROBE|' || notes from public.sales where organization_id='${A}' and number=1;
  `)).toEqual(["PII notes"]);
});
