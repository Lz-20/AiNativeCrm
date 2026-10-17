import type { RuntimeMessage } from "@/lib/agent-runtime";

export type AgentEvalDimensionKey =
  | "task_completion"
  | "answer_quality"
  | "knowledge_grounding"
  | "tool_reliability"
  | "policy_compliance"
  | "efficiency"
  | "collaboration_quality";

export type AgentEvalVerdict = "pass" | "fail" | "needs_review" | "not_run";

export interface AgentEvalCriterion {
  key: AgentEvalDimensionKey;
  label: string;
  weight: number;
  required: boolean;
}

export interface AgentEvalProfile {
  key: string;
  revision: number;
  criteria: readonly AgentEvalCriterion[];
  knowledgeUse: "required" | "conditional" | "optional";
  maxToolCalls: number;
  collaborationUse: "conditional" | "disabled";
}

export interface AgentEvalEvent {
  id?: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface AgentEvalProposal {
  id: string;
  toolName: string;
  status: string;
}

export interface AgentEvalRunInput {
  runId: string;
  agentId: string;
  task: string;
  mode: "inspect" | "act";
  status: string;
  finalText: string | null;
  /** Untrusted model submission; deterministic checks parse it before use. */
  resultDocument?: unknown;
  events: AgentEvalEvent[];
  proposals: AgentEvalProposal[];
  /** Service-only execution state. Reports never expose these raw messages. */
  runtimeMessages: RuntimeMessage[];
  /** Independently scoped SQL existence receipts at run end; never model supplied. */
  confirmedMemoryExpectations?: Array<{
    contactId: string;
    memoryIds: string[];
    asOf: string;
  }>;
  collaborationRuns?: Array<{
    id: string;
    specialistKey: string | null;
    status: string;
    errorCode: string | null;
    claimCount?: number;
    evidenceCount?: number;
  }>;
}

export interface AgentEvalFinding {
  code: string;
  message: string;
  evidence?: Record<string, string | number | boolean | null>;
}

export interface AgentEvalDimensionResult {
  key: AgentEvalDimensionKey;
  label: string;
  verdict: AgentEvalVerdict;
  score: number | null;
  findings: AgentEvalFinding[];
}

export interface AgentEvalReport {
  runId: string;
  profileKey: string;
  profileRevision: number;
  verdict: AgentEvalVerdict;
  score: number | null;
  dimensions: AgentEvalDimensionResult[];
  summary: {
    toolCalls: number;
    toolErrors: number;
    knowledgeSearches: number;
    groundedEvidenceItems: number;
    specialistRuns: number;
    specialistFailures: number;
    structuredClaims: number;
  };
  semanticJudge: {
    status: "not_configured" | "not_run" | "completed" | "failed";
    judgeId?: string;
    verdict?: AgentEvalVerdict;
    score?: number;
    findings?: AgentEvalFinding[];
    rubricRevision?: number;
  };
}

export interface AgentSemanticJudgement {
  judgeId: string;
  rubricRevision: number;
  verdict: Exclude<AgentEvalVerdict, "not_run">;
  score: number;
  findings: AgentEvalFinding[];
  rubric: Array<{
    key: "task_fit" | "factual_support" | "missing_material_honesty" | "actionability";
    score: 0 | 1 | 2 | 3 | 4;
    rationale: string;
  }>;
}

/** Optional LLM-as-judge. It is deliberately not required for deterministic gates. */
export interface AgentSemanticJudgePort {
  judge(input: {
    profile: AgentEvalProfile;
    run: AgentEvalRunInput;
    deterministicReport: AgentEvalReport;
    signal: AbortSignal;
  }): Promise<AgentSemanticJudgement>;
}

/** Persistence can be Postgres, an external eval platform, or a test fixture. */
export interface AgentEvalStore {
  save(report: AgentEvalReport): Promise<void>;
  load(runId: string, profileKey: string, profileRevision: number): Promise<AgentEvalReport | null>;
}
