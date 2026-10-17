/**
 * A API KEY DO WAHA NOS DOIS COMPOSES USA O PREFIXO `sha512:`
 *
 * ── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * O WAHA compara o `X-Api-Key` recebido com `WAHA_API_KEY`. Sem o prefixo
 * `sha512:`, ele compara LITERALMENTE — e o app manda o plaintext, enquanto o
 * compose entrega o hash. Resultado: 401 em toda chamada, com o contêiner de
 * pé e saudável. Só aparece quando alguém sobe o ambiente e tenta conectar um
 * canal; nenhum caso de unidade pegava, porque não há requisição no caminho.
 *
 * O `docker-compose.prod.yml` já tinha o prefixo — e o comentário explicando o
 * modo de falha. O `docker-compose.yml` de desenvolvimento não, embora os dois
 * descrevam a mesma instalação.
 *
 * ── Por que os DOIS arquivos são lidos ─────────────────────────────────────
 *
 * Consertar um lado e esquecer o outro foi exatamente como o defeito nasceu.
 * O caso roda sobre os dois, então reinverter a correção em qualquer um deles
 * reprova.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

const COMPOSES = ["docker-compose.yml", "docker-compose.prod.yml"] as const;

/** A linha que entrega a chave ao contêiner do WAHA. */
function linhaDaChave(arquivo: string): string {
  const src = readFileSync(path.join(RAIZ, arquivo), "utf8");
  const linha = src.split("\n").find((l) => /^\s+WAHA_API_KEY:/.test(l));
  expect(linha, `${arquivo} não declara WAHA_API_KEY — a sonda ficou cega`).toBeDefined();
  return linha!;
}

describe("WAHA_API_KEY nos composes", () => {
  it.each(COMPOSES)("%s entrega a chave com o prefixo sha512:", (arquivo) => {
    expect(
      linhaDaChave(arquivo),
      `${arquivo}: sem o prefixo sha512: o WAHA compara o X-Api-Key LITERALMENTE — ` +
        "o app manda plaintext, o compose entrega hash, e toda chamada toma 401",
    ).toMatch(/WAHA_API_KEY:\s*"sha512:\$\{WAHA_API_KEY_SHA512\}"/);
  });

  it("a sonda enxerga a linha (controle positivo)", () => {
    // Instrumento que não acha nada devolve verde igual a instrumento que não
    // achou problema. Este caso falha se o nome da variável mudar e a varredura
    // acima passar por vacuidade.
    expect(linhaDaChave("docker-compose.yml")).toContain("WAHA_API_KEY_SHA512");
  });
});
