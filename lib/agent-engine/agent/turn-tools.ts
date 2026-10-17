import type pg from 'pg';

import type { AgentOperationContext } from '@/lib/ai/agents/operation';
import { DEFAULT_CHANNEL_PROVIDER, capabilitiesOf } from '@/lib/channels/capabilities';
import type { ChannelAdapter, ChannelSendResult } from '../channel-adapter';
import { claimOfJob } from '../queue/claim';
import type { JobRow } from '../queue/queue';
import type { Logger } from '../obs/logger';
import {
  getLeadContext,
  type LeadContext,
  type LeadContextResult,
} from '../edge/crm/get-lead-context';
import { buildMcpTurnTools } from '../edge/crm/mcp-tools';
import { applyLeadStateUpdate, type LeadStage } from './lead-state';
import { applySaveLeadNote, getLeadNoteBody } from './lead-notes';
import { applyScheduleFollowup } from './schedule-followup';
import { applyRequestHumanHandoff, buildHandoffSummary } from './human-handoff';
import {
  hasOpenCaseForContact,
  openCase,
  provideCaseUpdate,
  openHumanCaseInputSchema,
  provideCaseUpdateInputSchema,
} from './human-cases';
import { citationsFromHits, searchKnowledge } from './search-knowledge';
import {
  projetarContexto,
  projetarRetornoDeTool,
  turnoProjeta,
  type ContextoProjetado,
} from './projecao';
import { capacidadesEntreguesAoOperador, catalogoEntregueAoOperador } from './entrega-de-capacidade';
import { readSkillReference, skillHasReferences } from './skill-references';
import { loadChannelProvider, runBeforeSend } from '../guardrails/before-send';
import { claimsCurrentInboundIsEmpty } from './context-builder';
import { abreAvisoDoEspelhoRecusado, mirrorLeadStageToCrm } from '../edge/crm/move-lead-stage';
import { avisarLeadDaEscalacao } from './aviso-de-escalacao';
import { tool, type ToolSet } from '../edge/llm/run-model-call';
import { isStatusSendable } from '../../channels/meta/template-binding';
import { renderTemplateBody } from '@/lib/channels/meta/render-template';
import { esperarComoHumano } from './atraso-humano';
import { sendInBubbles, splitForSend } from './split-message';
import { decidePromise } from '../guardrails/promise/engine';
import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { READ_ONLY_TOOLS, wrapToolsWithBreaker } from './tool-breaker';
import { AGENT_TOOL_DEFS } from './tool-definitions';
import type { PromiseTable } from '../guardrails/promise/table';
import type { PromiseClassification } from '../guardrails/promise/semantic';
import type { LgpdInput } from '../guardrails/lgpd/legal-basis';
import type { SkillMatchResult } from './skills';
import type { TurnPreview } from './preview';
import type { LeadCheckpointRow } from './checkpoint-contract';
import type { TurnAgentResolution } from './resolve-turn-agent';
import type { InboundTurnDeps, AgentTurnInput } from './inbound-turn';

export interface TurnToolState {
  seq: number;
  confirmedStage: LeadStage | null;
  outOfTablePromiseAttempted: boolean;
  openedCaseThisTurn: boolean;
  casePromiseVetoCount: number;
  internalVocabularyVetoCount: number;
  falseEmptyInboundVetoCount: number;
  jaEsperouComoHumano: boolean;
  pacingCapVeto: { code: string; nextAllowedAt: Date } | null;
  agendaToolCalledThisTurn: boolean;
  outcomes: ChannelSendResult[];
  pendingCitations: ReturnType<typeof citationsFromHits>;
  runError: Error | null;
}

type AvisoDaEscalacaoFactory = () => {
  ids: Parameters<typeof import('./aviso-de-escalacao').avisarLeadDaEscalacao>[1] & {
    agentOperation?: AgentOperationContext;
  };
  base: Omit<
    Parameters<typeof import('./aviso-de-escalacao').avisarLeadDaEscalacao>[2],
    'motivo'
  >;
};

export interface BuildTurnToolsInput {
  pool: pg.Pool;
  deps: InboundTurnDeps;
  input: AgentTurnInput;
  preview?: TurnPreview;
  tenantId: string;
  leadId: string;
  job: JobRow | null;
  liveJob: () => JobRow;
  clock: () => Date;
  runLog: Logger;
  agentConfig: TurnAgentResolution['config'];
  agentOperation?: AgentOperationContext;
  fusoDaOrg: string;
  turnContextKnobs: { historyLimit: number; maxTokens: number };
  effectiveContext: LeadContext;
  previous: LeadCheckpointRow | null;
  inboundsPendentes: readonly string[];
  lgpd: LgpdInput | undefined;
  promiseTable: PromiseTable | null;
  semanticClassifier?: (candidate: string) => Promise<PromiseClassification>;
  optedOutThisTurn: boolean;
  liveChannel: () => ChannelAdapter;
  avisoDaEscalacao: AvisoDaEscalacaoFactory;
  moverParaHandoffBestEffort: (reason: string) => void;
  noteRunError: (err: Error) => void;
  avisarCapacidadesAusentes: (
    db: pg.Pool,
    tenantId: string,
    conversationId: string,
    detail: string,
    log: Logger,
  ) => Promise<void>;
  maxSendsPerTurn: number;
  maxFalseEmptyVetoes: number;
  maxInternalVocabularyVetoes: number;
  inicioDoProcessamento: number;
  mensagemDoJob: string;
  skillMatch: SkillMatchResult;
  agenda: {
    toolNames: ReadonlySet<string>;
    has: (toolIds: readonly string[]) => boolean;
    list: (toolIds: readonly string[]) => string[];
  };
  state: TurnToolState;
}

export interface BuildTurnToolsResult {
  rawTools: ToolSet;
  mcpCleanup: (() => Promise<void>) | null;
  entregues: readonly string[];
  mcpToolIdsDoTurno: string[];
}

export async function buildTurnTools(
  context: BuildTurnToolsInput,
): Promise<BuildTurnToolsResult> {
  const {
    pool,
    deps,
    input,
    preview,
    tenantId,
    leadId,
    job,
    liveJob,
    clock,
    runLog,
    agentConfig,
    agentOperation,
    fusoDaOrg,
    turnContextKnobs,
    effectiveContext,
    previous,
    inboundsPendentes,
    lgpd,
    promiseTable,
    semanticClassifier,
    optedOutThisTurn,
    liveChannel,
    avisoDaEscalacao,
    moverParaHandoffBestEffort,
    noteRunError,
    avisarCapacidadesAusentes,
    maxSendsPerTurn,
    maxFalseEmptyVetoes,
    maxInternalVocabularyVetoes,
    inicioDoProcessamento,
    mensagemDoJob,
    skillMatch,
    agenda,
    state,
  } = context;

  const mcpToolIdsDoTurno: string[] = [];

  const rawTools: ToolSet = {
    get_lead_context: tool({
      ...AGENT_TOOL_DEFS.get_lead_context,
      execute: async (): Promise<
        | LeadContextResult
        // A variante PROJETADA é um tipo próprio, não um `LeadContext` disfarçado
        // por cast: são payloads diferentes, e um `as` aqui faria o compilador
        // parar de vigiar exatamente a fronteira que este código existe para
        // manter. Note que `lgpd` não viaja nela — base legal e anonimização são
        // dado de conformidade que o runtime usa nos gates, e que o modelo nunca
        // precisou ler (no caminho não-projetado ele já ia junto; aqui para).
        | { ok: true; context: ContextoProjetado; tokenCount: number }
        | { ok: false; error: { code: string; message: string } }
      > => {
        try {
          const releitura = preview
            ? preview.context
            : await getLeadContext(
                pool,
                deps.crmCfg,
                { tenantId, leadId, conversationId: input.conversationId, fuso: fusoDaOrg },
                turnContextKnobs,
              );
          // Sem esta linha a projeção da abertura seria decorativa: bastaria o
          // modelo chamar esta ferramenta para receber o contexto CRU de volta,
          // com `lead_id`, `conversation_id` e caminho de mídia. A releitura é a
          // mesma superfície da abertura e tem de obedecer à mesma regra —
          // proteger só a porta da frente é não ter protegido.
          if (releitura.ok && turnoProjeta(mcpToolIdsDoTurno)) {
            return {
              ok: true,
              context: projetarContexto(releitura.context),
              tokenCount: releitura.tokenCount,
            };
          }
          return releitura;
        } catch (err) {
          // bug de programação: ensina o modelo a encerrar E derruba o job no fim
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao ler o contexto — encerre o turno agora.',
            },
          };
        }
      },
    }),
    send_template: tool({
      ...AGENT_TOOL_DEFS.send_template,
      execute: async ({ template_name, language, values }) => {
        if (state.seq >= maxSendsPerTurn) {
          return {
            ok: false,
            error: {
              code: 'max_sends_per_turn',
              message:
                `você já enviou ${state.seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
                'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
            },
          };
        }
        // O texto RENDERIZADO vai como `body` da cadeia: os gates de promessa,
        // spinning e disclosure avaliam exatamente o que o contato vai ler. Sem
        // isso, "usar template" seria a forma de escapar dos guardrails de conteúdo.
        const { rows } = await pool.query<{
          components: unknown;
          parameter_format: string;
          status: string;
        }>(
          `select components, parameter_format, status from meta_templates
            where organization_id = $1 and name = $2 and language = $3`,
          [tenantId, template_name, language],
        );
        const linha = rows[0];
        if (linha === undefined) {
          return {
            ok: false,
            error: {
              code: 'template_desconhecido',
              message:
                `não existe template "${template_name}" em ${language} nesta conta. ` +
                'Encerre o turno; um humano precisa configurá-lo.',
            },
          };
        }
        // "Existe" não é "pode ser disparado". A regra vive em template-binding.ts e
        // o caminho HUMANO já a respeitava (recusa `not_approved` no menu do composer);
        // este caminho não a consultava — e é o que age SEM humano olhando. Um template
        // PENDING ou REJECTED iria à Graph API, voltaria erro genérico, e o modelo
        // trataria como falha de infraestrutura em vez de configuração pendente.
        //
        // Erro SEPARADO de `template_desconhecido` de propósito: as duas causas pedem
        // ações humanas diferentes — criar o template, ou esperar/consertar a análise
        // da Meta. Colapsá-las manda o operador procurar no lugar errado.
        if (!isStatusSendable(linha.status)) {
          return {
            ok: false,
            error: {
              code: 'template_nao_aprovado',
              message:
                `o template "${template_name}" existe mas está ${linha.status} na Meta — ` +
                'só um template APPROVED pode ser disparado. Encerre o turno; ' +
                'um humano precisa resolver a aprovação.',
            },
          };
        }

        const rendered = renderTemplateBody(linha.components, values, {
          name: template_name,
          language,
          parameterFormat: linha.parameter_format,
        });

        const chain = await runBeforeSend({
          pool,
          log: runLog,
          agentOperation,
          tenantId,
          leadId,
          jobId: liveJob().id,
          channelSessionId: input.channelSessionId,
          body: rendered,
          // Só ESTE gate muda; stop, LGPD e pacing continuam valendo integralmente.
          isTemplate: true,
          optedOutThisTurn,
          crmDailyLimit: null,
          now: clock(),
          sleep: deps.sleep,
          lgpd,
          send: (finalBody: string) => {
            state.seq += 1;
            return liveChannel().send({
              tenantId,
              leadId,
              jobId: liveJob().id,
              jobClaim: claimOfJob(liveJob()),
              agentOperation,
              seq: state.seq,
              conversationId: input.conversationId,
              body: finalBody,
              template: { name: template_name, language, values },
            });
          },
        });

        if (chain.status === 'vetoed') {
          return { ok: false, error: { code: chain.code, message: chain.message } };
        }
        const outcome = chain.outcome;
        state.outcomes.push(outcome);
        if (outcome.kind === 'sent' || outcome.kind === 'already_sent') {
          return {
            ok: true,
            status: 'enviada',
            message_id: outcome.messageId,
            // Explícito: sem isso o modelo tende a emendar texto livre depois do
            // template — que a janela fechada recusaria.
            message: 'template enviado. Não escreva mais nada neste turno.',
          };
        }
        return { ok: true, status: 'aceita_aguardando_canal' };
      },
    }),
    search_knowledge: tool({
      ...AGENT_TOOL_DEFS.search_knowledge,
      execute: async ({ query }) => {
        const fontes = agentConfig?.knowledgeSourceIds ?? [];
        if (fontes.length === 0 && agentConfig?.activeKbVersionId == null) {
          return {
            ok: false,
            error: {
              code: 'no_knowledge_base',
              message: 'este agente não tem material de consulta habilitado — siga sem ele.',
            },
          };
        }
        const out = await searchKnowledge(
          pool,
          {
            organizationId: tenantId,
            knowledgeSourceIds: fontes,
            kbVersionId: agentConfig?.activeKbVersionId ?? null,
            query,
            topK: agentConfig?.ragTopK ?? 5,
            threshold: agentConfig?.ragSimilarityThreshold ?? 0.4,
            jobId: job?.id,
            agentId: agentConfig?.agentId ?? null,
          },
          { log: runLog, embed: deps.embed },
        );
        if (out.ok && out.results.length > 0) {
          // As citações são montadas AQUI, pelo código, a partir do resultado
          // cru — é por isso que os ids podem sair do que vai ao modelo sem
          // perder nada: quem precisa deles é esta linha, não o modelo.
          state.pendingCitations = citationsFromHits(out.results);
        }
        // `chunk_id` e `knowledge_source_id` viajavam CRUS para o modelo em toda
        // busca com RAG — dois UUIDs por resultado, sem uso nenhum do lado dele
        // (nenhuma ferramenta os aceita como argumento). UUID cru na resposta ao
        // cliente foi MEDIDO nesta base; esta era uma fonte silenciosa dele.
        return turnoProjeta(mcpToolIdsDoTurno) ? projetarRetornoDeTool(out) : out;
      },
    }),
    send_message: tool({
      ...AGENT_TOOL_DEFS.send_message,
      execute: async ({ body }) => {
        if (claimsCurrentInboundIsEmpty(body, mensagemDoJob)) {
          state.falseEmptyInboundVetoCount += 1;
          if (state.falseEmptyInboundVetoCount < maxFalseEmptyVetoes) {
            return {
              ok: false,
              error: {
                code: 'false_empty_inbound',
                message:
                  'O cliente enviou texto nesta mensagem. Não diga que ela veio vazia, em branco ou sem texto. ' +
                  `Responda ao pedido real agora: ${JSON.stringify(mensagemDoJob)}. ` +
                  `Esta é a tentativa de correção ${state.falseEmptyInboundVetoCount}.`,
              },
            };
          }
          // Não há segunda cadeia a re-rodar aqui (diferente do vocabulário
          // interno, que desarma um gate e chama `runBeforeSend` de novo): esta
          // barreira é local ao `execute`, então soltar é seguir para o resto do
          // caminho de envio, com a cadeia inteira ainda pela frente.
          runLog.warn('fail-safe do gate de falso-vazio: envio liberado após vetos seguidos', {
            vetos: state.falseEmptyInboundVetoCount,
          });
        }
        if (state.seq >= maxSendsPerTurn) {
          return {
            ok: false,
            error: {
              code: 'max_sends_per_turn',
              message:
                `você já enviou ${state.seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
                'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
            },
          };
        }
        // F4-04: sinaliza (independente do gate F4-01/F4-08) se ESTA candidata é uma
        // promessa fora de tabela — usado só para correlacionar com o jailbreak no fim do
        // turno. A detecção é determinística (decidePromise); sem tabela do tenant = no-op.
        if (
          promiseTable !== null &&
          !decidePromise({ candidate: body, table: promiseTable }).allow
        ) {
          state.outOfTablePromiseAttempted = true;
        }
        // Cadeia de guardrails (F2-13): stop/opt-out → anti-ban → spinning rodam
        // AQUI, entre a decisão do modelo e o adapter. Se um gate veta, o
        // channel.send NÃO acontece e a razão volta ao modelo como erro instrutivo;
        // state.seq só avança quando o envio é de fato tentado (gate veto não gasta state.seq
        // — preserva o alinhamento (job_id, state.seq) do ledger F2-06 entre re-runs).
        try {
          // Wave 4 (spec 15 §10.2): estado de caso lido FRESCO a cada tentativa de envio
          // (pode ter mudado dentro deste MESMO turno via open_human_case, chamado antes
          // deste send_message). casesEnabled false (tela não habilita) → sempre false,
          // sem query — o casePromiseGate já é no-op nesse caso de qualquer forma.
          const hasOpenCase =
            agentConfig?.casesEnabled === true
              ? await hasOpenCaseForContact(pool, tenantId, input.conversationId)
              : false;
          // Args reusados EXATAMENTE (mesmo objeto) no re-run do fail-safe abaixo — só
          // hasOpenCase/state.openedCaseThisTurn mudam depois do auto-abre-caso.
          const beforeSendArgs = {
            pool,
            log: runLog,
            agentOperation,
            tenantId,
            leadId,
            jobId: liveJob().id,
            channelSessionId: input.channelSessionId,
            body,
            optedOutThisTurn,
            // ponytail: channel_sessions.daily_message_limit do CRM ainda não é lido
            // no runtime — null cai nos degraus de warm-up (conservadores). Injetar
            // aqui quando o drain expuser o limite da sessão.
            crmDailyLimit: null,
            now: clock(),
            sleep: deps.sleep,
            lgpd,
            casesEnabled: agentConfig?.casesEnabled ?? false,
            hasOpenCase,
            openedCaseThisTurn: state.openedCaseThisTurn,
            // Nome(s) próprio(s) que o prompt do tenant usa pra retaguarda humana (ex.:
            // "Fulano") — o mesmo vocabulário que `matchesHandoffKeyword` já usa do lado
            // do CLIENTE, agora somado ao alvo genérico do `casePromiseGate` do lado do
            // que o MODELO promete. Ver `GateContext.humanPromiseExtraTargets`.
            humanPromiseExtraTargets: agentConfig?.handoffKeywords ?? [],
            // A rede contra vazamento de vocabulário interno arma AQUI e só aqui: este é
            // o único corpo escrito pelo MODELO, e o único caminho em que o veto vira
            // erro instrutivo que ele pode consertar no turno seguinte. O `send_template`
            // (mais acima) fica desarmado de propósito — o texto lá é do humano e já
            // aprovado pela Meta; vetá-lo devolveria ao modelo a culpa por uma frase que
            // não é dele, e a única saída seria o silêncio. O follow-up determinístico
            // idem (ver GateContext.internalVocabularyEnforced).
            enforceInternalVocabulary: true,
            // Mesmo padrão do vocabulário interno: só o `send_message` arma — é o único
            // corpo escrito pelo modelo. `active` é ter QUALQUER ferramenta de agenda:
            // um agente que só CONSULTA promete "vou verificar" igual, e enquanto a
            // condição era só `crm_book_appointment` ele ficava sem o gate. Quem não tem
            // ferramenta de agenda nenhuma segue desarmado — vetá-lo não teria cura.
            agenda: {
              active: agentConfig !== null && agenda.has(agentConfig.toolIds),
              ferramentas: agentConfig === null ? [] : agenda.list(agentConfig.toolIds),
              toolCalledThisTurn: state.agendaToolCalledThisTurn,
            },
            ...(deps.knobs.disclosureMode !== undefined
              ? { disclosureMode: deps.knobs.disclosureMode }
              : {}),
            // Gate 5 (F4-02): classificador semântico roteado pelo MESMO seam agnóstico (budget
            // da org checado nele). Closure com tenant/lead/job da ROW fechados — nunca do payload.
            ...(semanticClassifier !== undefined
              ? { classifyPromiseSemantic: semanticClassifier }
              : {}),
            // Pausa humana do turno, paga FORA do lock do número (issue #654). Antes ela
            // era paga dentro do `send` logo abaixo (via `antesDaPrimeira`), e o `send`
            // só acontece com o `pg_advisory_xact_lock` do canal na mão — cada turno
            // segurava a fila do NÚMERO por 1,2s–7,5s além do necessário. Agora o
            // guardrail a paga antes de tomar conexão: sem transação aberta durante a espera.
            //
            // O texto que dimensiona a pausa é a 1ª bolha do MESMO fatiamento que o
            // `sendInBubbles` usa (`splitForSend` é a fonte única da decisão) — a pausa
            // segue proporcional ao que o cliente lê primeiro, não ao corpo todo.
            //
            // Diferença declarada: aqui o texto é o `body` PRÉ-cadeia; o `finalBody`
            // pós-disclosure só existe do lado de dentro do guardrail. Um disclosure
            // prependado pelo gate F4-05 não entra na conta da espera (antes entrava,
            // porque o gancho recebia `finalBody`).
            esperaForaDoLock: async (): Promise<void> => {
              // Uma vez por TURNO — o flag impede que um re-run do fail-safe (veto de
              // promessa/vocabulário) cobre a espera de novo do mesmo cliente.
              if (state.jaEsperouComoHumano) return;
              state.jaEsperouComoHumano = true;
              // `liveChannel()`, não `channel`: o transporte é anulável (preview não tem
              // canal) e este é o MESMO acessor que o `send` logo abaixo usa. Resolver
              // antes da espera mantém o desfecho de preview idêntico ao de antes —
              // `preview_transport_forbidden` na hora, e não depois da pausa.
              const canal = liveChannel();
              const ms = await esperarComoHumano({
                texto:
                  splitForSend(
                    body,
                    agentConfig?.splitMessages ?? false,
                    agentConfig?.splitMaxChars ?? 600,
                  )[0] ?? body,
                // `processamentoMs` é a contribuição do #849 (contribuidor): a pausa humana desconta o
                // tempo que o turno JÁ gastou pensando, em vez de somar em cima dele. Sem este
                // argumento o `gasto` de `atraso-humano.ts` cai no `?? 0` e o desconto não acontece —
                // o cliente espera duas vezes. O ponto de chamada mudou de lugar com a #654 (a pausa
                // saiu de `antesDaPrimeira`, dentro do lock, para cá), e o desconto veio junto.
                processamentoMs: performance.now() - inicioDoProcessamento,
                sleep: deps.sleep ?? ((s) => new Promise((resolve) => setTimeout(resolve, s))),
                log: runLog,
                ...(canal.signalTyping
                  ? {
                      sinalizarDigitando: (): Promise<void> =>
                        canal.signalTyping!({ tenantId, conversationId: input.conversationId }),
                    }
                  : {}),
              });
              runLog.info('atraso humano antes da 1ª bolha', { atraso_ms: ms, fora_do_lock: true });
            },
            // `finalBody` = corpo após a cadeia (o disclosureGate F4-05 pode prependar o
            // disclosure via inject); é ELE que vai ao canal, não o `body` capturado da tool.
            send: (finalBody: string) =>
              sendInBubbles(finalBody, {
                enabled: agentConfig?.splitMessages ?? false,
                maxChars: agentConfig?.splitMaxChars ?? 600,
                sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                jitter: () => 1200 + Math.floor(Math.random() * 800), // piso no throttle anti-ban (1.2s) — bolhas são mensagens físicas
                // A pausa humana do turno NÃO mora mais aqui: ela subiu para
                // `esperaForaDoLock` (paga antes de o guardrail tomar o lock do número) —
                // issue #654. Neste ponto fica só o jitter anti-ban entre bolhas.
                send: (bubble): Promise<ChannelSendResult> => {
                  state.seq += 1;
                  return liveChannel().send({
                    tenantId,
                    leadId,
                    jobId: liveJob().id,
                    jobClaim: claimOfJob(liveJob()),
                    agentOperation,
                    seq: state.seq,
                    conversationId: input.conversationId,
                    body: bubble,
                  });
                },
              }),
          };
          let chain = await runBeforeSend(beforeSendArgs);
          if (chain.status === 'vetoed' && chain.code === 'case_promise_without_case') {
            // Wave 4 — fail-safe da invariante sagrada: o lead NUNCA recebe promessa-de-
            // humano sem caso aberto. 1ª vez no turno: erro-de-ensino (o modelo re-tenta —
            // abre o caso OU reformula sem prometer humano). Persistiu (2ª vez): o SISTEMA
            // abre um caso mínimo e libera o envio — nunca deixa a promessa passar sem caso.
            state.casePromiseVetoCount += 1;
            if (state.casePromiseVetoCount < 2) {
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            const auto = await openCase(
              pool,
              {
                tenantId,
                conversationId: input.conversationId,
                agentId: agentConfig?.agentId ?? null,
              },
              {
                title: 'Atendimento que precisa de um humano',
                summary: body, // a mensagem-promessa que a IA tentou enviar
                blocker:
                  'Aberto automaticamente: a IA prometeu envolver um humano e não abriu o caso (fail-safe do guardrail).',
                source: 'guardrail_autofallback',
                contextSnapshot: buildCaseContextSnapshot(),
              },
            );
            if (!auto.ok) {
              // openCase falhou (ex.: já existe outro caso aberto por corrida) — NÃO envie
              // prometendo humano sem caso; mantém a invariante com o erro de ensino original.
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            state.openedCaseThisTurn = true;
            moverParaHandoffBestEffort('case_promise_autofallback');
            // Re-roda a cadeia INTEIRA agora que há caso aberto — o send real acontece
            // DENTRO do runBeforeSend (via args.send); nunca chamamos o canal por fora
            // (perderia pacing/lgpd/stop). ponytail: re-roda a cadeia inteira no fail-safe
            // (raro) — pode reaplicar 1 espera de pacing; aceitável pelo caminho ser
            // excepcional.
            chain = await runBeforeSend({
              ...beforeSendArgs,
              hasOpenCase: true,
              openedCaseThisTurn: true,
            });
          }
          if (chain.status === 'vetoed' && chain.code === 'internal_vocabulary_leak') {
            // Fail-safe do gate de vazamento — O CLIENTE NUNCA FICA SEM RESPOSTA.
            //
            // Este gate é REDE, não invariante sagrada (ao contrário do case_promise, cuja
            // 2ª camada ABRE o caso antes de liberar). Aqui não há o que o sistema possa
            // fazer no lugar do modelo: ou ele reescreve, ou a escolha é entre uma frase
            // com um termo técnico e o silêncio. Silêncio é pior — some com o atendimento
            // sem sintoma, que é o oposto do invariante 4 do sistema vivo. Então: 1º veto
            // ensina (o modelo re-tenta); persistiu, o envio sai DESARMANDO só este gate —
            // todos os outros continuam valendo, porque o re-run passa pela cadeia inteira.
            //
            // O veto da 1ª tentativa já virou linha em `before_send_traces` (com a
            // categoria do vazamento) e atividade na timeline: a liberação não apaga a
            // medição, que é o produto deste gate.
            state.internalVocabularyVetoCount += 1;
            if (state.internalVocabularyVetoCount < maxInternalVocabularyVetoes) {
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            runLog.warn(
              'fail-safe do gate de vocabulário interno: envio liberado após vetos seguidos',
              {
                vetos: state.internalVocabularyVetoCount,
              },
            );
            // `state.openedCaseThisTurn` vai pelo valor VIVO (o fail-safe de casos acima pode
            // tê-lo mudado); reusar o do objeto capturado re-vetaria no case_promise.
            chain = await runBeforeSend({
              ...beforeSendArgs,
              openedCaseThisTurn: state.openedCaseThisTurn,
              hasOpenCase: hasOpenCase || state.openedCaseThisTurn,
              enforceInternalVocabulary: false,
            });
          }
          if (chain.status === 'vetoed') {
            // Cap de warm-up/diário: reescrever o texto não resolve (é rate limit, não
            // conteúdo) — ensinar o modelo a "tentar de novo" só gasta passo. Guardamos
            // pra reagendar o JOB inteiro depois que o turno terminar (mesmo padrão de
            // `rescheduleJob` já usado pra janela horária), em vez de deixar o lead sem
            // resposta até a próxima mensagem dele chegar (ou nunca).
            if (
              (chain.code === 'warmup_cap' || chain.code === 'daily_cap') &&
              chain.nextAllowedAt !== undefined
            ) {
              state.pacingCapVeto = { code: chain.code, nextAllowedAt: chain.nextAllowedAt };
            }
            // Erro de ENSINO pt-br (mesmo shape de get_lead_context/breaker): o
            // modelo o vê no turno seguinte. NÃO é exceção — não derruba o run.
            return { ok: false, error: { code: chain.code, message: chain.message } };
          }
          const outcome = chain.outcome;
          state.outcomes.push(outcome);
          if (outcome.kind === 'sent' && state.pendingCitations.length > 0) {
            try {
              await pool.query(
                `update messages
                 set metadata = coalesce(metadata, '{}'::jsonb)
                   || jsonb_build_object('citations', $3::jsonb, 'ai_generated', true)
                 where organization_id = $1 and id = $2`,
                [tenantId, outcome.messageId, JSON.stringify(state.pendingCitations)],
              );
            } catch (err) {
              // citação é enriquecimento, não invariante — falha só loga.
              runLog.warn('citações não anexadas à outbound', {
                message_id: outcome.messageId,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
              });
            }
            state.pendingCitations = [];
          }
          switch (outcome.kind) {
            case 'sent':
            case 'already_sent':
              return { ok: true, status: 'enviada', message_id: outcome.messageId };
            case 'queued':
              return {
                ok: true,
                status: 'aceita_aguardando_canal',
                message:
                  'o canal aceitou a mensagem e vai enviá-la quando a sessão voltar — não reenvie.',
              };
            case 'blocked':
              return {
                ok: false,
                error: {
                  code: 'contato_bloqueado',
                  message:
                    'o contato optou por não receber mensagens (bloqueio irrevogável) — não envie mais nada e encerre o turno.',
                },
              };
            case 'failed':
              return {
                ok: false,
                error: {
                  code: 'envio_falhou',
                  message:
                    'o canal falhou ao enviar — não tente de novo neste turno; o sistema fará retry.',
                },
              };
            case 'unavailable':
              // transiente (transporte/tool do canal): ensina o modelo a parar; o
              // job re-tenta com a MESMA idempotency_key (ledger ficou 'requested').
              noteRunError(
                new Error(
                  `canal indisponível no envio (${outcome.reason}) — job re-tentado pela fila`,
                ),
              );
              return {
                ok: false,
                error: {
                  code: 'envio_indisponivel',
                  message:
                    'não consegui enviar agora (canal indisponível) — encerre o turno; o sistema re-tentará.',
                },
              };
          }
        } catch (err) {
          // bug de programação no adapter: ensina o modelo a encerrar E derruba o job.
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno no envio — encerre o turno agora.',
            },
          };
        }
      },
    }),
    update_lead_state: tool({
      ...AGENT_TOOL_DEFS.update_lead_state,
      execute: async (raw) => {
        try {
          const update = await applyLeadStateUpdate(
            pool,
            { tenantId, leadId, jobId: liveJob().id },
            raw,
          );
          if (!update.ok) {
            return update; // erro de ensino (payload fora da whitelist / transição inválida)
          }
          if (update.transition !== null) {
            // Espelho no CRM. Falha NUNCA reverte o harness (fonte da verdade do
            // funil) nem falha o job: humano resolve via inbox_items. Os motivos
            // de MIRROR_WARN_ONLY (tenant sem mapa; humano moveu o card antes) são
            // só warn — estado legítimo do produto não é incidente. Os outros dois
            // merecem aviso PRÓPRIO, cada um no seu: `fora_do_escopo` (nada quebrou,
            // o dono decide se libera o funil) e `perda_sem_motivo` (#917 — o card
            // não anda porque a perda exige um motivo que só o humano pode dar).
            const mirror = await mirrorLeadStageToCrm(pool, deps.crmCfg, {
              tenantId,
              leadId,
              toStage: update.transition.to,
              ...(update.transition.reason !== undefined
                ? { reason: update.transition.reason }
                : {}),
            });
            if (!mirror.ok) {
              runLog.warn('espelho de stage no CRM falhou — harness mantido', {
                to_stage: update.transition.to,
                reason: mirror.reason,
              });
              // QUAL aviso cada recusa produz, e como ele deixa de se repetir, é
              // decisão de `move-lead-stage` — aqui só se passa o motivo e o
              // lead. Ver `abreAvisoDoEspelhoRecusado`: escrever o
              // `insertInboxItem` à mão neste ponto é o que deixava o `dedupe`
              // sem guarda.
              await abreAvisoDoEspelhoRecusado(pool, tenantId, {
                leadId,
                motivo: mirror.reason,
                detalhe: mirror.detail,
                etapaDeDestino: update.transition.to,
              });
            }
          }
          // F3-11: o estágio que o modelo confirmou (a máquina F2-10 gravou) — base da
          // comparação com a sugestão do classificador no fechamento do run.
          state.confirmedStage = update.state.stage;
          return {
            ok: true,
            status: 'estado_atualizado',
            stage: update.state.stage,
            message: update.message,
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao atualizar o estado do lead — encerre o turno agora.',
            },
          };
        }
      },
    }),
    // F3-05: memória durável por lead. save_lead_note é MUTANTE (fora de
    // READ_ONLY_TOOLS); tenant/lead vêm da ROW do job (closure), nunca do payload.
    // Hard cap do índice imposto AQUI na escrita (applySaveLeadNote) — estouro vira
    // ensino pedindo consolidação, sem gravar (padrão Hermes).
    save_lead_note: tool({
      ...AGENT_TOOL_DEFS.save_lead_note,
      execute: async (raw) => {
        try {
          const res = await applySaveLeadNote(
            pool,
            { tenantId, leadId },
            { budgetTokens: deps.knobs.notesIndexMaxTokens },
            raw,
          );
          if (!res.ok) {
            return res; // ensino (payload fora da whitelist / orçamento do índice estourado)
          }
          return {
            ok: true,
            status: 'nota_salva',
            superseded: res.superseded,
            message: res.message,
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao salvar a nota — encerre o turno agora.',
            },
          };
        }
      },
    }),
    // get_lead_note é READ-ONLY: relê o corpo de UMA nota do lead pelo id (sob demanda —
    // o índice só traz headline). Escopado por (tenant, lead) do closure.
    get_lead_note: tool({
      ...AGENT_TOOL_DEFS.get_lead_note,
      execute: async ({ note_id }) => {
        try {
          const noteId = note_id.trim();
          const body = noteId === '' ? null : await getLeadNoteBody(pool, tenantId, leadId, noteId);
          if (body === null) {
            return {
              ok: false,
              error: {
                code: 'note_not_found',
                message:
                  'não há nota com esse id na memória deste lead — confira o id no índice de memória.',
              },
            };
          }
          return { ok: true, note_id: noteId, body };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao ler a nota — encerre o turno agora.',
            },
          };
        }
      },
    }),
    // F4-06: handoff humano acionado pelo PRÓPRIO modelo (cidadão de 1ª classe). MUTANTE
    // (seta force_human no CRM + cancela crons + inbox), fora de READ_ONLY_TOOLS. tenant/
    // lead/conversation vêm da ROW do job (closure), nunca do payload do modelo.
    request_human_handoff: tool({
      ...AGENT_TOOL_DEFS.request_human_handoff,
      execute: async (raw) => {
        try {
          // ═══ O PISO: se o modelo não falou, o sistema fala ═══
          //
          // A descrição da tool manda avisar o lead ANTES de chamá-la, e a
          // mensagem de retorno repete. Mas capacidade que depende de o modelo
          // LEMBRAR é capacidade que não existe metade das vezes — a mesma
          // conclusão que fez `expectativaDeAtendimento` parar de esperar que
          // ele consultasse a disponibilidade sozinho.
          //
          // `state.seq` é o contador de mensagens FÍSICAS já enviadas neste turno. Zero
          // significa: o modelo decidiu passar a conversa sem dizer nada a
          // ninguém — e depois desta tool ele não consegue mais falar, porque
          // `force_human` arma o `stopGate`. Então o aviso determinístico sai
          // AGORA, antes do handoff.
          //
          // `state.seq > 0` significa que ele JÁ falou neste turno; mandar o aviso ali
          // em cima seria o robô dizendo duas vezes a mesma coisa, com palavras
          // diferentes. Confiamos na fala dele e registramos que o piso não foi
          // preciso.
          const aviso =
            state.seq === 0
              ? await avisarLeadDaEscalacao(pool, avisoDaEscalacao().ids, {
                  ...avisoDaEscalacao().base,
                  motivo: 'pediu_humano',
                })
              : ({ avisado: true } as const);
          // O contexto do TURNO vai junto, e sai da closure: `previous` é o
          // checkpoint durável e `inboundsPendentes` é o que o cliente disse e
          // ainda não foi respondido — os dois já estão em memória, então o
          // briefing enriquecido não custa uma consulta a mais.
          const res = await applyRequestHumanHandoff(
            pool,
            { tenantId, leadId, conversationId: input.conversationId },
            {
              conversationSummary: buildHandoffSummary(previous),
              contextoDoTurno: { checkpoint: previous, pendentesDoCliente: inboundsPendentes },
              avisoAoLead: aviso,
              log: runLog,
            },
            raw,
          );
          if (!res.ok) return res; // erro de ensino (payload fora da whitelist)
          return { ok: true, status: res.status, message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao acionar o handoff humano — encerre o turno agora.',
            },
          };
        }
      },
    }),
  };

  // F3-02: a tool de agendamento (schedule_followup) só entra quando sua janela
  // está configurada — main.ts sempre a preenche pelos knobs do env; tenant/lead
  // vêm da ROW do job (closure), nunca do payload do modelo. É MUTANTE (cria
  // cron_job), por isso fica fora de READ_ONLY_TOOLS.
  const followupKnobs = deps.knobs.followup;
  if (followupKnobs !== undefined) {
    rawTools.schedule_followup = tool({
      ...AGENT_TOOL_DEFS.schedule_followup,
      execute: async (raw) => {
        try {
          // agentId vai junto para a atividade da timeline nascer com AUTORIA: sem
          // ele a linha entra como "Sistema" e o humano não sabe qual agente
          // prometeu voltar — numa org com três agentes isso não responde nada.
          const res = await applyScheduleFollowup(
            pool,
            { clock, knobs: followupKnobs },
            { tenantId, leadId, agentId: agentConfig?.agentId ?? null },
            raw,
          );
          if (!res.ok) {
            return res; // erro de ensino (payload / data no passado / fora da janela)
          }
          return {
            ok: true,
            status: 'agendado',
            agendado_para: res.promisedAt.toISOString(),
            message: res.message,
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao agendar o retorno — encerre o turno agora.',
            },
          };
        }
      },
    });
  }

  // Fase 2 (Task 6): read_skill_reference só entra quando alguma skill CASADA neste
  // turno carrega references no manifesto (Task 3) — sem isso oferecer a tool seria
  // ruído. Read-only (tool-breaker.ts); tenant/matched skills vêm do closure
  // (skillMatch, calculado acima), nunca do payload do modelo.
  if (skillMatch.matched.some((s) => skillHasReferences(s))) {
    rawTools.read_skill_reference = tool({
      ...AGENT_TOOL_DEFS.read_skill_reference,
      execute: async ({ skill_name, ref_path }) => {
        try {
          return await readSkillReference(
            { admin: deps.crmCfg.supabase },
            {
              organizationId: tenantId,
              matchedSkills: skillMatch.matched,
              skillName: skill_name,
              refPath: ref_path,
            },
          );
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao ler a reference da skill — encerre o turno agora.',
            },
          };
        }
      },
    });
  }

  // Fase 2B: a tela pode DESLIGAR a tool de handoff do modelo (a detecção
  // determinística de pedido de humano continua ativa — guardrail nunca sai).
  if (agentConfig !== null && !agentConfig.handoffToolEnabled) {
    delete rawTools.request_human_handoff;
  }

  // Spec 15: snapshot mínimo do contexto disponível pro humano que for atender o
  // caso — campo de CONVENIÊNCIA pra UI, não load-bearing (nada aqui é relido pelo
  // agente). ponytail: snapshot mínimo; enriquecer se a UI precisar de mais.
  const buildCaseContextSnapshot = (): Record<string, unknown> => ({
    contact_name: effectiveContext.contact.name,
    last_messages: effectiveContext.messages
      .slice(-5)
      .map((m) => ({ direction: m.direction, body: m.body })),
  });

  // Spec 15 (Wave 3a): tools de caso humano (open_human_case/provide_case_update) só
  // entram quando a tela habilita (cases_enabled) — mesmo padrão do handoff acima.
  // Ids do closure (row do job), nunca do payload; payload inválido é erro de ENSINO
  // ({ok:false}), exceção real vira internal_error (mesma disciplina dos irmãos).
  if (agentConfig !== null && agentConfig.casesEnabled) {
    rawTools.open_human_case = tool({
      ...AGENT_TOOL_DEFS.open_human_case,
      execute: async (raw) => {
        const parsed = openHumanCaseInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'invalid_payload',
              message: 'campos do caso inválidos — informe title, summary e blocker (texto).',
            },
          };
        }
        try {
          const res = await openCase(
            pool,
            { tenantId, conversationId: input.conversationId, agentId: agentConfig.agentId },
            { ...parsed.data, contextSnapshot: buildCaseContextSnapshot() },
          );
          if (!res.ok) return res;
          state.openedCaseThisTurn = true;
          moverParaHandoffBestEffort('open_human_case');
          // ACH-03: a expectativa vai junto com a confirmação. Medido num turno
          // real: o agente abria o caso e prometia ao cliente que "alguém entra
          // em contato" sem nunca ter olhado se havia alguém — a capacidade de
          // consultar existia, estava ligada e montada no turno, e ele não a
          // usou. Capacidade que depende de o modelo lembrar não existe metade
          // das vezes; esta o sistema garante.
          const { frase } = await expectativaDeAtendimento(pool, tenantId, new Date());
          return {
            ok: true,
            case_id: res.caseId,
            message: `caso aberto; continue a conversa com o lead normalmente. ${frase}`,
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao abrir o caso — encerre o turno.',
            },
          };
        }
      },
    });
    rawTools.provide_case_update = tool({
      ...AGENT_TOOL_DEFS.provide_case_update,
      execute: async (raw) => {
        const parsed = provideCaseUpdateInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: { code: 'invalid_payload', message: 'informe case_id e info (texto).' },
          };
        }
        try {
          const res = await provideCaseUpdate(
            pool,
            { tenantId, conversationId: input.conversationId },
            { caseId: parsed.data.case_id, info: parsed.data.info },
          );
          if (!res.ok) return res;
          return {
            ok: true,
            message: 'informação enviada ao responsável; aguarde o retorno pelo caso.',
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao atualizar o caso — encerre o turno.',
            },
          };
        }
      },
    });
  }

  // A tool de conhecimento só entra quando o agente publicado tem material para
  // consultar. Desde a 0181 isso é a lista de materiais escolhida na tela; o
  // ponteiro legado (`activeKbVersionId`) segue valendo para o clone que ainda
  // não aplicou a migration. Ferramenta que só sabe responder "não tenho base"
  // não é neutra: gasta contexto e degrada a escolha do modelo.
  if (
    (agentConfig?.knowledgeSourceIds?.length ?? 0) === 0 &&
    agentConfig?.activeKbVersionId == null
  ) {
    delete rawTools.search_knowledge;
  }

  // A ferramenta de template só entra em canal que EXIGE template fora da janela.
  // Num canal que fala livre a qualquer hora ela nunca teria uso — e tool inútil no
  // prompt não é neutra: gasta contexto e degrada a escolha do modelo.
  {
    const provider =
      preview && !preview.channelId
        ? DEFAULT_CHANNEL_PROVIDER
        : await loadChannelProvider(pool, tenantId, input.channelSessionId);
    if (!capabilitiesOf(provider).requiresTemplates) {
      delete rawTools.send_template;
    }
  }

  // 2B-tools: tools do catálogo MCP habilitadas NA TELA entram no run (audit +
  // role/scope da ponte nativa; envio e handoff do catálogo são bloqueados —
  // ver edge/crm/mcp-tools.ts). As 8 tools do engine têm precedência de nome.
  let mcpCleanup: (() => Promise<void>) | null = null;
    if (agentConfig !== null && agentConfig.toolIds.length > 0) {
      try {
        // As de OPERAÇÃO saem antes de serem montadas, quando o Operador as tem.
        // Medido: são elas que carregavam 2 dos 3 vazamentos (o DADO que devolvem),
        // e tirá-las levou a taxa de 30% para 10% — ver RELATORIO-passo6.md.
        const catalogoEntregue = catalogoEntregueAoOperador({
          operadorLigado: agentConfig.operatorEnabled,
          ferramentasDoOperador: agentConfig.operatorToolIds,
          ferramentasDoConversador: agentConfig.toolIds,
        });
        const configDoTurno =
          catalogoEntregue.length === 0
            ? agentConfig
            : {
                ...agentConfig,
                toolIds: agentConfig.toolIds.filter((t) => !catalogoEntregue.includes(t)),
              };
        if (catalogoEntregue.length > 0) {
          runLog.info('capacidades de catálogo entregues ao operador', {
            entregues: catalogoEntregue,
          });
        }
        const mcp = await buildMcpTurnTools(
          deps.crmCfg,
          { organizationId: tenantId, jobId: preview?.runId ?? liveJob().id },
          configDoTurno,
          runLog,
          preview ? {
            readOnly: true,
            ...(preview.kind === "sandbox" ? { workbenchProposalTools: true } : {}),
          } : undefined,
        );
        if (mcp !== null) {
          mcpCleanup = mcp.cleanup;
          for (const [name, mcpTool] of Object.entries(mcp.tools)) {
            if (name in rawTools) continue;
            // Marca a EXECUÇÃO (não só a decisão de chamar) — é isso que o agendaStallGate
            // precisa saber para não vetar um turno que já checou a agenda de verdade.
            if (agenda.toolNames.has(name) && typeof mcpTool.execute === 'function') {
              const executeOriginal = mcpTool.execute.bind(mcpTool);
              rawTools[name] = {
                ...mcpTool,
                execute: (async (...args: Parameters<typeof executeOriginal>) => {
                  state.agendaToolCalledThisTurn = true;
                  return executeOriginal(...args);
                }) as typeof mcpTool.execute,
              };
            } else {
              rawTools[name] = mcpTool;
            }
          }
          mcpToolIdsDoTurno.push(...mcp.toolIds);
          runLog.info('tools MCP da tela montadas no turno', { mcp_tool_ids: mcp.toolIds });
        }
      } catch (err) {
        // Tool extra é privilégio, não invariante: falha no mint/montagem NÃO
        // derruba o turno — a conversa do cliente não pode morrer porque uma tool
        // extra falhou. Isso continua certo.
        //
        // O que estava errado era o DEPOIS. A versão anterior deste comentário
        // dizia "o humano vê o log". Não vê: o log sai no stdout do worker, num
        // contêiner de VPS que o dono do negócio nunca abre. Medido num turno
        // real — o agente atendeu sem NENHUMA das capacidades que o humano tinha
        // ligado na tela, e a única pista existia num log que ninguém lê. É
        // falha-em-verde: anunciada na tela, ausente na execução, nada contando.
        const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        runLog.error('tools MCP da tela não montadas — turno segue sem elas', { error: detalhe });
        if (preview)
          preview.result.impediments.push({
            code: 'capabilities_unavailable',
            message: 'Não foi possível carregar as capacidades configuradas.',
          });
        else await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
      }
    }

    // ── A CURA (spec 16, passo 6) ───────────────────────────────────────────────
    //
    // As ferramentas de escrita saem do Conversador quando o Operador as assumiu.
    // O gate de vazamento é rede — barra na saída e ensina; isto é a cura: o
    // modelo não pode repetir o nome de uma ferramenta que nunca viu, e foi pelo
    // NOME que o vazamento voltou depois de a descrição ser limpa.
    //
    // A remoção é CONDICIONAL a o novo dono existir (ver entrega-de-capacidade):
    // tirar de um lado sem garantir o outro não separa papéis, perde capacidade.
    const entregues = capacidadesEntreguesAoOperador({
      operadorLigado: agentConfig?.operatorEnabled ?? false,
      ferramentasDoOperador: agentConfig?.operatorToolIds ?? [],
    });
    for (const nome of entregues) delete rawTools[nome];
    if (entregues.length > 0) {
      runLog.info('capacidades entregues ao operador — fora do turno do conversador', {
        entregues,
      });
    }


  return { rawTools, mcpCleanup, entregues, mcpToolIdsDoTurno };
}
