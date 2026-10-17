import { LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";
import { cn } from "@/lib/utils";

/**
 * A marca do PRODUTO desenhada em SVG inline — o que a tela mostra quando
 * ninguém configurou marca própria (`marcaEhADoProduto`, em `lib/branding.ts`).
 *
 * Inline, e não `<img src="/algo.svg">`, por três motivos:
 *  - as cores seguem o TEMA: sálvia mais clara e nome em creme no escuro, como
 *    a régua do produto já define — um arquivo estático teria uma cor só;
 *  - nada em `public/`: um `.svg` fixo ali seria servido na instalação de um
 *    revendedor que configurou a marca dele (ver `lib/branding/desenho.ts`);
 *  - a barra lateral já usa `<img>` para o logo CONFIGURADO, e o e2e
 *    `marca-logo.spec.ts` mede "barra sem `<img>`" como "sem logo do
 *    revendedor". Um `<img>` do produto ali faria a spec medir a coisa errada.
 *
 * O texto alternativo é o `nome` que a tela já resolveu — nunca uma string
 * fixa, para que a catraca de marca (`tests/unit/branding.test.ts`) continue
 * contando ZERO ocorrências fora de `lib/branding.ts`.
 */

type Props = {
  readonly nome: string;
  readonly className?: string;
  /** Use when the mark sits on the graphite application sidebar. */
  readonly superficieEscura?: boolean;
  /** `true` quando o texto ao lado já nomeia a marca — evita ler duas vezes. */
  readonly decorativo?: boolean;
};

const SIMBOLO_CLARO_ESCURO = "fill-[#934531] dark:fill-[#d79376]";
const NOME_CLARO_ESCURO = "fill-[#1c1814] dark:fill-[#f6f1ea]";
const SUFIXO_CLARO_ESCURO = "fill-[#5b5043] dark:fill-[#8a7e6b]";
const SIMBOLO_SUPERFICIE_ESCURA = "fill-[#d79376]";
const NOME_SUPERFICIE_ESCURA = "fill-[#f6f1ea]";
const SUFIXO_SUPERFICIE_ESCURA = "fill-[#c0b6a7]";

// As classes acima repetem os hexes de `CORES_DA_MARCA` porque o Tailwind só
// gera utilitário para valor LITERAL no fonte. Quem impede os dois de divergirem
// é `tests/unit/marca-do-produto.test.tsx`, que compara as classes à paleta —
// e não uma asserção em runtime: um throw aqui derrubaria a casca inteira.
export const CLASSES_DE_COR = {
  simbolo: SIMBOLO_CLARO_ESCURO,
  nome: NOME_CLARO_ESCURO,
  sufixo: SUFIXO_CLARO_ESCURO,
} as const;

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** O símbolo sozinho — para a barra recolhida, avatar e cantos apertados. */
export function SimboloDoProduto({ nome, className, decorativo = false, superficieEscura = false }: Props) {
  return (
    <svg
      viewBox={SIMBOLO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <g className={superficieEscura ? SIMBOLO_SUPERFICIE_ESCURA : SIMBOLO_CLARO_ESCURO} transform={SIMBOLO.transform}>
        <path d={SIMBOLO.d} />
        <rect {...SIMBOLO.modulo} />
      </g>
    </svg>
  );
}

/** Símbolo + nome — para a barra aberta e a fachada de entrada. */
export function LogotipoDoProduto({ nome, className, decorativo = false, superficieEscura = false }: Props) {
  return (
    <svg
      viewBox={LOGOTIPO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <g className={superficieEscura ? SIMBOLO_SUPERFICIE_ESCURA : SIMBOLO_CLARO_ESCURO} transform={LOGOTIPO.simbolo.transform}>
        <path d={LOGOTIPO.simbolo.d} />
        <rect {...LOGOTIPO.simbolo.modulo} />
      </g>
      <text
        className={superficieEscura ? NOME_SUPERFICIE_ESCURA : NOME_CLARO_ESCURO}
        x="270"
        y="145"
        fontFamily="Arial, sans-serif"
        fontSize="58"
        fontWeight="700"
        letterSpacing="-1"
      >
        Pi Native
      </text>
      <text
        className={superficieEscura ? SUFIXO_SUPERFICIE_ESCURA : SUFIXO_CLARO_ESCURO}
        x="273"
        y="192"
        fontFamily="Arial, sans-serif"
        fontSize="34"
        fontWeight="600"
        letterSpacing="3"
      >
        CRM
      </text>
    </svg>
  );
}
