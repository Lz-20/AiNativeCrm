/**
 * Product-owned knowledge contracts.
 *
 * A provider may be the local pgvector corpus, an organization wiki, a Skill,
 * or a future remote system. Agent code consumes this evidence shape and never
 * depends on a vendor response or on Pi types.
 */
export type AgentKnowledgeNamespace =
  | "crm_records"
  | "conversation_history"
  | "organization_memory"
  | "organization_wiki"
  | "skills"
  | "run_history"
  | "external_system";

export type KnowledgeSourceKind =
  | "crm_record"
  | "conversation"
  | "organization_memory"
  | "wiki_page"
  | "document"
  | "skill_reference"
  | "run_event"
  | "external_record";

export interface AgentKnowledgePolicy {
  namespaces: readonly AgentKnowledgeNamespace[];
  retrieval: "on_demand" | "required_before_answer";
  citationMode: "required_when_used" | "required_for_business_claims";
  minimumEvidenceItems: number;
  unavailableBehavior: "partial_result" | "report_missing" | "fail_run";
}

export interface KnowledgeLocator {
  provider: string;
  sourceId: string;
  revision?: string;
  uri?: string;
}

export interface KnowledgeEvidence {
  id: string;
  namespace: AgentKnowledgeNamespace;
  kind: KnowledgeSourceKind;
  title: string;
  excerpt: string;
  locator: KnowledgeLocator;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRetrievalRequest {
  organizationId: string;
  agentId: string;
  runId?: string;
  query: string;
  namespaces: readonly AgentKnowledgeNamespace[];
  sourceIds?: readonly string[];
  topK: number;
  minimumScore?: number;
  scope?: {
    contactId?: string;
    leadId?: string;
    conversationId?: string;
    pipelineId?: string;
  };
}

export interface KnowledgeRetrievalResult {
  status: "complete" | "partial" | "empty" | "unavailable";
  evidence: KnowledgeEvidence[];
  missingNamespaces: AgentKnowledgeNamespace[];
  warnings: string[];
}

/** Implemented by local RAG today and by wiki/remote connectors later. */
export interface AgentKnowledgePort {
  retrieve(
    request: KnowledgeRetrievalRequest,
    signal: AbortSignal,
  ): Promise<KnowledgeRetrievalResult>;
}

export interface KnowledgeCorpusSource {
  sourceId: string;
  namespace: AgentKnowledgeNamespace;
  kind: KnowledgeSourceKind;
  title: string;
  revision?: string;
  status: "ready" | "indexing" | "failed" | "disabled";
}

/** Inventory is separate from retrieval so an Agent can report missing data. */
export interface AgentKnowledgeCatalogPort {
  listSources(input: {
    organizationId: string;
    agentId: string;
    namespaces?: readonly AgentKnowledgeNamespace[];
  }): Promise<KnowledgeCorpusSource[]>;
}
