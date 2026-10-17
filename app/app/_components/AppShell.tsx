"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { BarraDeProgressoNavegacao } from "@/components/shell/BarraDeProgressoNavegacao";
import { useSinalDePresenca } from "@/hooks/atendimento/useSinalDePresenca";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useInboundCallAlerts } from "@/hooks/calls/useInboundCallAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";
import { estiloDaReserva, useOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";

interface AppShellProps {
  sidebarCollapsed: boolean;
  demoMode?: boolean;
  /**
   * A pessoa pode atender (agent+)? Vem do papel resolvido no layout, e não de
   * uma consulta desta casca.
   *
   * Só quem atende emite o sinal de presença: o roster que a tela Equipe mostra
   * é agent+, e a rota do sinal exige o mesmo papel. `viewer` batendo colheria
   * 403 a cada minuto em nome de ninguém.
   */
  podeAtender: boolean;
  children: ReactNode;
}

export function AppShell({
  sidebarCollapsed,
  demoMode = false,
  podeAtender,
  children,
}: AppShellProps) {
  const chatFirst = usePathname() === "/app/ai/workbench";
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chatFirst) return;
    const shell = shellRef.current;
    if (!shell) return;
    // Use the actual available viewport, including software-keyboard resize and
    // banners above the shell. All other routes retain their page-scroll layout.
    const measure = () => {
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
      shell.style.setProperty(
        "--workbench-viewport-height",
        `${Math.max(0, bottom - shell.getBoundingClientRect().top)}px`,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    // The branding parent uses display:contents, so observe its actual banner
    // children, not its nonexistent box. They can change height after hydration.
    const observeBanners = () => {
      if (!shell.parentElement) return;
      for (const sibling of shell.parentElement.children) {
        if (sibling !== shell) observer?.observe(sibling);
      }
      measure();
    };
    observeBanners();
    const mutations = new MutationObserver(observeBanners);
    if (shell.parentElement) mutations.observe(shell.parentElement, { childList: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      observer?.disconnect();
      mutations.disconnect();
      shell.style.removeProperty("--workbench-viewport-height");
    };
  }, [chatFirst]);
  useInboundMessageAlerts();
  useInboundCallAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  // O SINAL DE PRESENÇA (issue #996) sai daqui porque presença é "esta aba
  // está aberta" — não "a pessoa está na tela Equipe". Quem atende passa o dia
  // no Inbox e na Agenda; um emissor amarrado à tela de gestão diria que só o
  // gerente está presente.
  useSinalDePresenca(podeAtender);
  // O que as peças fixas do rodapé declararam ocupar agora (issue #1305). Sem
  // chamada nenhuma é ZERO, e aí o `<main>` fica exatamente como sempre foi —
  // o `p-6` inteiro é rodapé. Com o painel de chamada na tela, é ele que
  // decide a faixa que o conteúdo perde, e ninguém mais mede isso por fora.
  const ocupacaoDoRodape = useOcupacaoDoRodape();
  return (
    <div
      ref={shellRef}
      data-chat-first={chatFirst || undefined}
      className={
        chatFirst
          ? "flex h-[var(--workbench-viewport-height,100dvh)] min-h-0 w-full overflow-hidden bg-background"
          : "flex min-h-screen w-full bg-background"
      }
    >
      <BarraDeProgressoNavegacao />
      <div
        className={
          chatFirst ? "hidden min-h-0 overflow-hidden md:block [&>aside]:h-full" : "hidden md:block"
        }
      >
        <Sidebar collapsed={sidebarCollapsed} />
      </div>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa, e o
        conteúdo sumia sem nada indicando que existia.

        Medido em 390x844 no detalhe do agente, que tem seis abas: a página
        estourava 476px na horizontal; com esta classe, 212px — o que sobra é o
        cabeçalho, presente também em telas que não têm abas (a lista de agentes
        estoura 236px). Isolado ancestral por ancestral: é este o que decide.
      */}
      {/*
        Sem `md:ml-*`: a barra voltou a ocupar lugar na linha (ver o comentário
        em `Sidebar.tsx`), então o que sobra para esta coluna é exatamente o que
        ela não usou. A margem existia para compensar uma barra `fixed`, e era a
        SEGUNDA medida da mesma coisa — a que discordava e deixava a barra por
        cima da lista.
      */}
      <div
        className={
          chatFirst
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : "flex min-h-screen min-w-0 flex-1 flex-col"
        }
      >
        {chatFirst ? (
          <div className="shrink-0">
            <TopBar />
          </div>
        ) : (
          <TopBar />
        )}
        {demoMode ? (
          <div className="shrink-0 border-b border-accent/30 bg-accent-soft px-6 py-2 text-center text-xs text-foreground">
            演示模式 · 当前使用演示账号和示例数据，所有修改仅用于本地体验
          </div>
        ) : null}
        {/*
          O RODAPÉ DESCONTA O QUE AS PEÇAS FIXAS OCUPAM (issue #1305).

          `estiloDaReserva` devolve `undefined` quando não há peça registrada —
          nenhum estilo, o `p-6` de sempre —, e um `padding-bottom` que consome
          `--rodape-ocupado` quando há. O que ele descontou está também no
          atributo `data-rodape-ocupado`: é por ali que o gate mede esta faixa
          sem depender de o jsdom computar `var()` (ele não computa), e é o que
          aparece no inspetor quando alguém pergunta quanto o rodapé perdeu.
        */}
        <main
          className={
            chatFirst ? "min-h-0 flex-1 overflow-hidden p-2 md:p-4" : "flex-1 overflow-auto p-6"
          }
          style={estiloDaReserva(ocupacaoDoRodape)}
          data-rodape-ocupado={ocupacaoDoRodape}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
