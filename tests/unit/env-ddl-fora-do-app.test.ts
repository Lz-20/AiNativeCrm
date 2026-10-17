import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/**
 * `SUPABASE_DB_ADMIN_URL` é a conexão de DDL do KIT (issue #192): num Supabase
 * próprio ela é o DONO do banco, enquanto `SUPABASE_DB_URL` é a role menor que
 * o app usa — a separação inteira existe para que o app NÃO tenha esse poder.
 *
 * Só que o `docker-compose.prod.yml` entrega o `.env` inteiro ao `app` e ao
 * `worker` (`env_file: .env`), e `lib/env.ts` a declara. Ou seja: a chave está
 * ao alcance da mão de qualquer código do app, e um `env.SUPABASE_DB_ADMIN_URL`
 * escrito por engano devolveria ao processo exatamente o privilégio que a
 * issue tirou dele — sem erro nenhum, porque funciona.
 *
 * O comentário em `lib/env.ts` pede que ninguém a use. Este arquivo é a guarda:
 * comentário não reprova build.
 */
const RAIZES = ["app", "components", "lib", "workers", "hooks"];
/** O único lugar que pode nomeá-la: a declaração do contrato de ambiente. */
const DECLARACAO = "lib/env.ts";

function arquivosVarridos(dir: string): string[] {
  const alvos: string[] = [];
  for (const entrada of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entrada.name);
    if (entrada.isDirectory()) alvos.push(...arquivosVarridos(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) alvos.push(rel);
  }
  return alvos;
}

describe("a conexão de DDL não vaza para o código do app", () => {
  const porRaiz = new Map(RAIZES.map((r) => [r, arquivosVarridos(r)]));
  const alvos = [...porRaiz.values()].flat();
  const citam = alvos.filter((f) =>
    fs.readFileSync(path.join(RAIZ, f), "utf8").includes("SUPABASE_DB_ADMIN_URL"),
  );

  it("a varredura alcança as cinco raízes e enxerga a chave onde ela está", () => {
    // Vacuidade em dois eixos: uma varredura que não descesse em lugar nenhum
    // devolveria a mesma lista vazia de infratores, e uma que descesse sem saber
    // procurar a string também. A declaração em lib/env.ts é o controle
    // positivo — se ela não aparecer, a sonda está cega e o resto não vale.
    for (const [raiz, arquivos] of porRaiz) {
      expect(arquivos.length, `${raiz}/ não devolveu arquivo nenhum`).toBeGreaterThan(0);
    }
    expect(citam).toContain(DECLARACAO);
  });

  it("nenhum arquivo além da declaração nomeia SUPABASE_DB_ADMIN_URL", () => {
    expect(citam.filter((f) => f !== DECLARACAO)).toEqual([]);
  });
});
