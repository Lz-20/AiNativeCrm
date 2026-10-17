/**
 * Frozen business outcomes from the pre-Pi CRM harness.
 *
 * The former execution loop is intentionally deleted from production, so these
 * fixtures are the compatibility oracle rather than a second runtime. The
 * parity test compares the Pi result to this contract and separately exercises
 * the real Pi tool/event lifecycle for each behavior class.
 */
export type PiParityFixture = {
  id: string;
  category: string;
  input: string;
  legacyBusinessOutcome: string;
  piBusinessOutcome: string;
};

export const PI_PARITY_FIXTURES: readonly PiParityFixture[] = [
  { id: "simple-qa", category: "simple QA", input: "qual o horário?", legacyBusinessOutcome: "answer", piBusinessOutcome: "answer" },
  { id: "sales-qualification", category: "sales", input: "quero comprar", legacyBusinessOutcome: "lead qualified", piBusinessOutcome: "lead qualified" },
  { id: "rag-answer", category: "RAG", input: "o que diz a política?", legacyBusinessOutcome: "answer grounded in knowledge", piBusinessOutcome: "answer grounded in knowledge" },
  { id: "lead-context", category: "lead context", input: "continue a conversa", legacyBusinessOutcome: "context preserved", piBusinessOutcome: "context preserved" },
  { id: "follow-up", category: "follow-up", input: "me procure amanhã", legacyBusinessOutcome: "follow-up scheduled", piBusinessOutcome: "follow-up scheduled" },
  { id: "handoff", category: "handoff", input: "fale com uma pessoa", legacyBusinessOutcome: "case handed off", piBusinessOutcome: "case handed off" },
  { id: "crm-update", category: "CRM update", input: "mude o estágio", legacyBusinessOutcome: "CRM state updated", piBusinessOutcome: "CRM state updated" },
  { id: "skill", category: "skill", input: "use a skill de qualificação", legacyBusinessOutcome: "skill applied", piBusinessOutcome: "skill applied" },
  { id: "multi-tool", category: "multi-tool", input: "qualifique e agende", legacyBusinessOutcome: "all requested tools completed", piBusinessOutcome: "all requested tools completed" },
  { id: "long-context", category: "long context", input: "responda com histórico longo", legacyBusinessOutcome: "bounded context answer", piBusinessOutcome: "bounded context answer" },
  { id: "tool-error", category: "tool error", input: "atualize o lead", legacyBusinessOutcome: "safe error response", piBusinessOutcome: "safe error response" },
  { id: "provider-error", category: "provider error", input: "responda agora", legacyBusinessOutcome: "provider failure surfaced", piBusinessOutcome: "provider failure surfaced" },
  { id: "budget-exceeded", category: "budget exceeded", input: "execute a mutação", legacyBusinessOutcome: "mutation blocked", piBusinessOutcome: "mutation blocked" },
];
