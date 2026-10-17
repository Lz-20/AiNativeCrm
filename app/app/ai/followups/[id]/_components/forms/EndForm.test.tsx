/**
 * Os três `<SelectItem>` do nó final deixaram de ser literais e passaram a sair
 * de `opcoes(RESULTADOS_DO_FIM)`. Uma varredura de texto no arquivo não enxerga
 * item gerado em `.map()` — então a prova de que nada mudou na tela precisa ser
 * o DOM, aberto, e não o código-fonte.
 *
 * `tests/e2e/followup-journey.spec.ts` escolhe "Convertido" pelo nome exato.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import { EndForm } from "./EndForm";

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não implementa
  // nenhum dos dois e o clique no gatilho morre antes de abrir a lista.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

/**
 * `delay: null` mata a espera que o user-event insere entre cada evento de
 * ponteiro. Com o default, abrir este Select levou 16,6s e estourou o teto de
 * 15s do vitest — reprovação por lentidão, sem defeito nenhum, que é o jeito
 * mais rápido de ensinar o time a ignorar o gate.
 */
const usuario = () => userEvent.setup({ delay: null });

/**
 * Teto próprio, como o `vitest.config.ts` prevê para quem legitimamente precisa
 * de mais. Radix Select em jsdom é caro, e o custo varia demais com a carga da
 * máquina: medido no MESMO commit, 1,8s com a máquina livre e 15,7s com seis
 * worktrees compilando junto. 30s é o dobro do pior caso observado; abaixo
 * disso o gate reprovaria por contenção, que é ruído, não defeito.
 */
const TETO_MS = 30_000;

describe("EndForm — seletor de resultado", () => {
  it("oferece Convertido/Esgotado/Personalizado e grava o wire da escolha", { timeout: TETO_MS }, async () => {
    const gravados: Array<{ outcome: string }> = [];
    const user = usuario();
    render(
      <EndForm
        config={{ outcome: "exhausted" }}
        onChange={(c) => gravados.push(c as { outcome: string })}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Resultado" }));

    const itens = await screen.findAllByRole("option");
    expect(itens.map((i) => i.textContent)).toEqual(["Convertido", "Esgotado", "Personalizado"]);

    await user.click(screen.getByRole("option", { name: "Convertido" }));

    // O rótulo é português; o que desce para o grafo continua sendo o wire.
    expect(gravados).toEqual([{ outcome: "converted" }]);
  });
});
