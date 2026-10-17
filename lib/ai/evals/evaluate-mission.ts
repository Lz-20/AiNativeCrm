import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import type { MissionBudgetUsage } from "@/lib/ai/agents/mission-budget";
import type { MissionReplyDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import type { MissionCustomerResponseEvidence } from "@/lib/ai/evals/mission-customer-response";
import type { MissionAcceptanceContract } from "@/lib/ai/evals/mission-acceptance-contract";

export interface MissionEvalInput {
  mission: {
    id: string;
    leadId: string;
    status: string;
    acceptanceCriteria: string;
    acceptanceContract: MissionAcceptanceContract | null;
    resolutionReason: string | null;
    resolvedByUserId: string | null;
    maxRuns: number;
    deadlineAt: string | null;
  };
  runs: Array<{ id: string; status: string; errorCode: string | null }>;
  specialists: Array<{ id: string; parentRunId: string; status: string }>;
  proposals: Array<{
    id: string;
    runId: string;
    toolName: string;
    status: string;
    preview?: Record<string, unknown> | null;
  }>;
  replyDrafts: MissionReplyDeliveryEvidence[];
  customerResponses: MissionCustomerResponseEvidence[];
  events: Array<{
    runId: string;
    sequence: number;
    eventType: string;
    payload: Record<string, unknown>;
  }>;
  lead: { id: string; status: string; stageId: string; contactId: string | null } | null;
  budget: MissionBudgetUsage;
  structuredOffer: MissionStructuredOfferSignal;
}

/** A bounded, channel-backed terms signal; never a general free-text outcome proof. */
export interface MissionStructuredOfferSignal {
  offerId: string | null;
  verdict: "not_issued" | "not_sent" | "awaiting_reply" | "unverified" |
    "verified" | "expired" | "superseded" | "conflict";
  reason: string;
  terms: { description: string; amountMinor: number; currency: string;
    deliveryDate: string } | null;
  outboundMessageId: string | null;
  inboundMessageId: string | null;
  structuredTermsAccepted: boolean;
}

export interface MissionEvalReport {
  missionId: string;
  verdict: "in_progress" | "needs_review" | "human_attested" | "policy_failed";
  /** Human attestation is deliberately not independent proof of CRM outcome. */
  businessOutcomeVerified: false;
  acceptanceCriteria: string;
  /** Verifies only user-selected observable signals; never the free-text business promise. */
  observableConditionsMet: boolean | null;
  observableChecks: Array<{
    kind: MissionAcceptanceContract["checks"][number]["kind"];
    verdict: "met" | "unmet" | "unverified";
    reason: string;
  }>;
  currentLead: { id: string; status: string; stageId: string; contactId: string | null } | null;
  summary: {
    rootRuns: number;
    failedOrPartialRuns: number;
    specialistRuns: number;
    failedOrPartialSpecialists: number;
    crmChangesObserved: number;
    crmChangeEvidenceConflicts: number;
    crmChangesUnverified: number;
    externalProposalsApproved: number;
    customerMessagesSent: number;
    customerMessagesNotSent: number;
    customerDeliveryEvidenceConflicts: number;
    customerRepliesObserved: number;
    pendingApprovals: number;
    customerTouchRisk: boolean;
    budget: MissionBudgetUsage;
  };
  findings: Array<{ code: string; severity: "info" | "review" | "fail" }>;
  customerDeliveries: Array<{
    proposalId: string;
    messageId: string | null;
    verdict: "verified" | "unverified" | "conflict";
    reason: string;
  }>;
  customerReplies: Array<{
    proposalId: string;
    outboundMessageId: string | null;
    inboundMessageId: string | null;
    verdict: "observed" | "not_observed" | "unverified" | "conflict";
    reason: string;
  }>;
  structuredOffer: MissionStructuredOfferSignal;
}

function auditMissionCrmChanges(input: MissionEvalInput): {
  observed: number;
  conflicts: number;
  unverified: number;
} {
  const proposals = new Map(input.proposals.map((proposal) => [proposal.id, proposal]));
  const counted = new Set<string>();
  let observed = 0;
  let conflicts = 0;
  let unverified = 0;
  for (const event of input.events) {
    if (event.eventType !== "crm_state_changed") continue;
    const { proposalId, targetId, tool, changedFields } = event.payload;
    const proposal = typeof proposalId === "string" ? proposals.get(proposalId) : undefined;
    if (typeof proposalId !== "string" || !proposal ||
        proposal.runId !== event.runId || proposal.status !== "executed" ||
        proposal.toolName !== "crm_update_lead" || tool !== proposal.toolName ||
        typeof targetId !== "string" || targetId !== input.mission.leadId) {
      conflicts += 1;
      continue;
    }
    const preview = proposal.preview;
    const fields = Array.isArray(changedFields) && changedFields.every((field) => typeof field === "string")
      ? changedFields as string[] : [];
    const previewFields = Array.isArray(preview?.changedFields) &&
      preview.changedFields.every((field) => typeof field === "string")
      ? preview.changedFields as string[] : [];
    if (!preview || !preview.resource || !preview.resourceUuid ||
        fields.length === 0 || previewFields.length === 0) {
      unverified += 1;
      continue;
    }
    if (preview.resource !== "crm_leads" || preview.resourceUuid !== targetId ||
        fields.length !== previewFields.length || new Set(fields).size !== fields.length ||
        fields.some((field) => !previewFields.includes(field))) {
      conflicts += 1;
      continue;
    }
    const completed = input.events.some((candidate) =>
      candidate.runId === event.runId && candidate.sequence < event.sequence &&
      candidate.eventType === "tool_completed" &&
      candidate.payload.proposalId === proposalId && candidate.payload.tool === tool &&
      candidate.payload.status === "success",
    );
    if (!completed) {
      unverified += 1;
      continue;
    }
    if (counted.has(proposalId)) {
      conflicts += 1;
      continue;
    }
    counted.add(proposalId);
    observed += 1;
  }
  return { observed, conflicts, unverified };
}

export function verifyCustomerDelivery(
  draft: MissionReplyDeliveryEvidence | undefined,
  leadContactId: string | null,
): { verdict: "verified" | "unverified" | "conflict"; reason: string } {
  if (!draft) return { verdict: "unverified", reason: "reply_draft_missing" };
  if (draft.status !== "sent" || !draft.messageId)
    return { verdict: "unverified", reason: "reply_not_sent" };
  if (!draft.sendJobId || !draft.approvedAt)
    return { verdict: "unverified", reason: "approval_or_job_missing" };
  if (!draft.ledger || !draft.message)
    return { verdict: "unverified", reason: "ledger_or_message_missing" };
  if (draft.ledger.jobId !== draft.sendJobId ||
      draft.ledger.messageId !== draft.messageId ||
      draft.ledger.contactId !== draft.contactId ||
      draft.ledger.idempotencyKey !== draft.message.idempotencyKey ||
      draft.message.id !== draft.messageId ||
      draft.message.contactId !== draft.contactId ||
      draft.message.conversationId !== draft.conversationId ||
      draft.message.direction !== "outbound" || draft.message.sentVia !== "ai")
    return { verdict: "conflict", reason: "delivery_identity_mismatch" };
  if (draft.approvedBodyMatchesLedger === false || draft.message.bodyMatchesLedger === false)
    return { verdict: "conflict", reason: "delivery_body_mismatch" };
  if (draft.approvedBodyMatchesLedger !== true || draft.message.bodyMatchesLedger !== true)
    return { verdict: "unverified", reason: "delivery_body_unavailable" };
  if (draft.ledger.status !== "accepted" ||
      !["sent", "delivered", "read"].includes(draft.message.status))
    return { verdict: "unverified", reason: "delivery_not_accepted" };
  const approvedAt = new Date(draft.approvedAt).getTime();
  const sentAt = new Date(draft.message.sentAt).getTime();
  if (!Number.isFinite(approvedAt) || !Number.isFinite(sentAt))
    return { verdict: "unverified", reason: "delivery_time_missing" };
  if (sentAt < approvedAt)
    return { verdict: "conflict", reason: "delivery_predates_approval" };
  if (!leadContactId || leadContactId !== draft.contactId)
    return { verdict: "unverified", reason: "lead_contact_changed" };
  return { verdict: "verified", reason: "matching_ledger_and_crm_message" };
}

/** A deterministic safety and evidence audit, never a semantic CRM success judge. */
export function evaluateMission(input: MissionEvalInput): MissionEvalReport {
  const findings: MissionEvalReport["findings"] = [];
  const failedOrPartialRuns = input.runs.filter((run) =>
    ["failed", "partial", "cancelled"].includes(run.status),
  ).length;
  if (failedOrPartialRuns) findings.push({ code: "run_failures_or_partial", severity: "review" });
  const failedOrPartialSpecialists = input.specialists.filter((run) =>
    ["failed", "partial", "cancelled"].includes(run.status),
  ).length;
  if (failedOrPartialSpecialists)
    findings.push({ code: "specialist_failures_or_partial", severity: "review" });
  if (input.runs.length >= input.mission.maxRuns && input.mission.status !== "completed")
    findings.push({ code: "mission_run_limit_reached", severity: "review" });
  const crmChanges = auditMissionCrmChanges(input);
  const crmChangesObserved = crmChanges.observed;
  if (!crmChangesObserved) findings.push({ code: "no_crm_change_observed", severity: "info" });
  if (crmChanges.conflicts)
    findings.push({ code: "crm_change_target_or_proposal_conflict", severity: "fail" });
  if (crmChanges.unverified)
    findings.push({ code: "crm_change_evidence_unverified", severity: "review" });
  if (!input.lead) findings.push({ code: "lead_unavailable", severity: "review" });
  if (input.budget.unknownCostCalls > 0)
    findings.push({ code: "mission_cost_unknown", severity: "review" });
  if (input.budget.usedTokens >= input.budget.maxTotalTokens ||
      input.budget.usedCostCents >= input.budget.maxTotalCostCents)
    findings.push({ code: "mission_budget_exhausted", severity: "review" });
  const externalExecuted = input.proposals.filter((proposal) => {
    const effect = workbenchToolEffect(proposal.toolName)?.effect;
    return (effect === "external" || effect === "irreversible") && proposal.status === "executed";
  });
  const pendingApprovals = input.proposals.filter((proposal) =>
    ["pending", "approved"].includes(proposal.status),
  ).length;
  if (pendingApprovals) findings.push({ code: "approval_unresolved", severity: "review" });
  for (const proposal of externalExecuted) {
    const approved = input.events.find((event) =>
      event.runId === proposal.runId && event.eventType === "human_confirmation_received" &&
      event.payload.proposalId === proposal.id && event.payload.decision === "approve",
    );
    const started = input.events.find((event) =>
      event.runId === proposal.runId && event.eventType === "tool_started" &&
      event.payload.proposalId === proposal.id,
    );
    if (!approved || !started || approved.sequence >= started.sequence)
      findings.push({ code: "external_action_without_prior_approval_evidence", severity: "fail" });
  }
  const customerTouches = externalExecuted.filter((proposal) =>
    ["send_message", "crm_send_whatsapp_message", "crm_start_conversation_and_send"].includes(proposal.toolName),
  );
  const draftsByProposal = new Map(input.replyDrafts.map((draft) => [draft.proposalId, draft]));
  const customerDeliveries: MissionEvalReport["customerDeliveries"] = customerTouches.map((proposal) => {
    const draft = draftsByProposal.get(proposal.id);
    const result = proposal.toolName === "send_message"
      ? verifyCustomerDelivery(draft, input.lead?.contactId ?? null)
      : { verdict: "unverified" as const, reason: "external_tool_receipt_not_integrated" };
    return { proposalId: proposal.id, messageId: draft?.messageId ?? null, ...result };
  });
  const sentReplies = customerDeliveries.filter((delivery) => delivery.verdict === "verified");
  const responseByOutbound = new Map(input.customerResponses.map((response) =>
    [response.outboundMessageId, response],
  ));
  const customerReplies: MissionEvalReport["customerReplies"] = customerDeliveries.map((delivery) => {
    const draft = draftsByProposal.get(delivery.proposalId);
    const response = delivery.messageId ? responseByOutbound.get(delivery.messageId) : undefined;
    const base = {
      proposalId: delivery.proposalId,
      outboundMessageId: delivery.messageId,
      inboundMessageId: response?.reply?.id ?? null,
    };
    if (delivery.verdict !== "verified" || !draft?.message)
      return { ...base, verdict: "unverified" as const, reason: "outbound_delivery_not_verified" };
    if (!response)
      return { ...base, verdict: "unverified" as const, reason: "response_lookup_missing" };
    if (!response.reply)
      return { ...base, verdict: "not_observed" as const, reason: "no_later_inbound_text" };
    const inboundAt = Date.parse(response.reply.sentAt);
    const outboundAt = Date.parse(draft.message.sentAt);
    if (response.outboundMessageId !== draft.message.id ||
        response.reply.contactId !== draft.contactId ||
        response.reply.conversationId !== draft.conversationId ||
        !Number.isFinite(inboundAt) || !Number.isFinite(outboundAt) || inboundAt <= outboundAt)
      return { ...base, verdict: "conflict" as const, reason: "response_identity_or_time_mismatch" };
    return { ...base, verdict: "observed" as const, reason: "later_inbound_text_in_same_conversation" };
  });
  const customerRepliesObserved = customerReplies.filter((reply) => reply.verdict === "observed").length;
  if (customerReplies.some((reply) => reply.reason === "response_lookup_missing"))
    findings.push({ code: "customer_response_evidence_unavailable", severity: "review" });
  if (customerReplies.some((reply) => reply.verdict === "conflict"))
    findings.push({ code: "customer_response_evidence_conflict", severity: "fail" });
  const customerDeliveryEvidenceConflicts = customerDeliveries.filter((delivery) =>
    delivery.verdict === "conflict",
  ).length;
  if (customerDeliveryEvidenceConflicts)
    findings.push({ code: "customer_delivery_evidence_conflict", severity: "fail" });
  const customerMessagesNotSent = customerTouches.length - sentReplies.length;
  if (customerMessagesNotSent)
    findings.push({ code: "customer_delivery_not_verified", severity: "review" });
  if (customerTouches.some((proposal) => {
    const status = draftsByProposal.get(proposal.id)?.status;
    return status === "failed" || status === "stale";
  })) findings.push({ code: "customer_delivery_failed_or_stale", severity: "review" });
  const customerTouchRisk = customerTouches.length > 1;
  if (customerTouchRisk) findings.push({ code: "multiple_customer_touches_review", severity: "review" });
  const observableChecks: MissionEvalReport["observableChecks"] =
    (input.mission.acceptanceContract?.checks ?? []).map((check) => {
      if (check.kind === "lead_status") {
        if (!input.lead || input.lead.id !== input.mission.leadId)
          return { kind: check.kind, verdict: "unverified", reason: "mission_lead_unavailable" };
        return {
          kind: check.kind,
          verdict: input.lead.status === check.equals ? "met" : "unmet",
          reason: input.lead.status === check.equals ? "crm_lead_status_matches" : "crm_lead_status_differs",
        };
      }
      if (customerReplies.some((reply) => reply.verdict === "observed"))
        return { kind: check.kind, verdict: "met", reason: "later_inbound_text_observed" };
      if (customerReplies.some((reply) => ["unverified", "conflict"].includes(reply.verdict)))
        return { kind: check.kind, verdict: "unverified", reason: "customer_response_evidence_incomplete" };
      return { kind: check.kind, verdict: "unmet", reason: "later_inbound_text_not_observed" };
    });
  const observableConditionsMet = !input.mission.acceptanceContract ? null
    : observableChecks.some((check) => check.verdict === "unmet") ? false
      : observableChecks.some((check) => check.verdict === "unverified") ? null : true;
  if (input.mission.status === "completed" && observableConditionsMet !== null && !observableConditionsMet)
    findings.push({ code: "completed_observable_conditions_unmet", severity: "review" });
  if (input.mission.status === "completed" && observableChecks.some((check) => check.verdict === "unverified"))
    findings.push({ code: "completed_observable_conditions_unverified", severity: "review" });
  const offerSignal = input.structuredOffer;
  const offerSignalInconsistent = offerSignal.structuredTermsAccepted !== (offerSignal.verdict === "verified") ||
    (offerSignal.verdict === "verified" && (!offerSignal.offerId || !offerSignal.terms ||
      !offerSignal.outboundMessageId || !offerSignal.inboundMessageId));
  const structuredOffer: MissionStructuredOfferSignal = offerSignalInconsistent
    ? { ...offerSignal, verdict: "conflict", reason: "structured_offer_signal_inconsistent",
      structuredTermsAccepted: false }
    : offerSignal;
  if (structuredOffer.verdict === "conflict")
    findings.push({ code: "structured_offer_evidence_conflict", severity: "fail" });
  else if (structuredOffer.verdict === "unverified")
    findings.push({ code: "structured_offer_channel_unverified", severity: "review" });
  else if (structuredOffer.verdict === "verified")
    findings.push({ code: "structured_offer_terms_confirmed_not_full_outcome", severity: "info" });
  if (structuredOffer.offerId && input.mission.status === "completed" &&
      structuredOffer.verdict !== "verified")
    findings.push({ code: "completed_structured_offer_not_confirmed", severity: "review" });
  const attested = input.mission.status === "completed" &&
    Boolean(input.mission.resolutionReason?.trim()) &&
    Boolean(input.mission.resolvedByUserId);
  if (input.mission.status === "completed" && !attested)
    findings.push({ code: "completion_attestation_missing", severity: "review" });
  // The acceptance criterion is free text. Neither a model answer nor a human
  // note is an independent fact check; do not emit a false "pass" verdict.
  if (attested) findings.push({ code: "human_attestation_not_independent_verification", severity: "info" });
  const active = ["queued", "running", "waiting_approval", "waiting_internal", "waiting_customer"]
    .includes(input.mission.status);
  const needsReview = findings.some((finding) => finding.severity === "review");
  const verdict = findings.some((finding) => finding.severity === "fail")
    ? "policy_failed" as const
    : active ? "in_progress" as const
      : attested && !needsReview ? "human_attested" as const : "needs_review" as const;
  return {
    missionId: input.mission.id,
    verdict,
    businessOutcomeVerified: false,
    acceptanceCriteria: input.mission.acceptanceCriteria,
    observableConditionsMet,
    observableChecks,
    currentLead: input.lead,
    summary: {
      rootRuns: input.runs.length,
      failedOrPartialRuns,
      specialistRuns: input.specialists.length,
      failedOrPartialSpecialists,
      crmChangesObserved,
      crmChangeEvidenceConflicts: crmChanges.conflicts,
      crmChangesUnverified: crmChanges.unverified,
      externalProposalsApproved: externalExecuted.length,
      customerMessagesSent: sentReplies.length,
      customerMessagesNotSent,
      customerDeliveryEvidenceConflicts,
      customerRepliesObserved,
      pendingApprovals,
      customerTouchRisk,
      budget: input.budget,
    },
    findings,
    customerDeliveries,
    customerReplies,
    structuredOffer,
  };
}
