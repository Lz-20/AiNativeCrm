# lib/ai/

Esta árvore contém serviços auxiliares de IA, RAG, skills, memória, handoff, catálogo e
compatibilidade de providers. O loop de agente de produção não mora aqui: ele usa o Pi Agent
Core em `lib/agent-runtime/pi/`, com governança no Model Gateway em
`lib/agent-engine/edge/llm/`.

Escopo previsto:

- `gateway.ts` — resolução compatível do Vercel AI SDK para embeddings e chamadas auxiliares
- `agents/` — configuração, publicação, roteamento e credenciais de agentes
- `rag/` — chunking, debounce, fontes e versões do acervo
- `embed.ts` — geração de embeddings para o acervo
- `handoff/` — política de transição bot → humano e avisos
- `skills/` — instalação e pacotes de skills CRM
- `pontos/` — resolução de provider/modelo por ponto de IA
- `runtime/` — utilitários de persistência/serialização do agente, sem loop de execução

## Strings de modelo (canônicas)

- `"anthropic/claude-sonnet-4-6"` — exemplo de agente principal
- `"anthropic/claude-haiku-4-5"` — exemplo de classificação auxiliar
- `"openai/text-embedding-3-small"` — embeddings RAG padrão

Chamadas de agente devem passar pelo Model Gateway e pelo Pi Agent Runtime. O Vercel AI SDK
continua permitido aqui para embeddings e operações auxiliares que não executam um loop de agente.
