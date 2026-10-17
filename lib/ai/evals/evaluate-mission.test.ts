import { describe, expect, it } from "vitest";
import { evaluateMission, type MissionEvalInput } from "./evaluate-mission";
import type { MissionReplyDeliveryEvidence } from "./mission-delivery-evidence";

const contactId = "contact-1";
const conversationId = "conversation-1";
const jobId = "job-1";
const idempotencyKey = "receipt-key-1";

function delivery(overrides: Partial<MissionReplyDeliveryEvidence> = {}): MissionReplyDeliveryEvidence {
  return {
    proposalId: "send-1", status: "sent", messageId: "message-1",
    contactId, conversationId, sendJobId: jobId,
    approvedAt: "2026-09-30T00:00:00.000Z",
    approvedBodyMatchesLedger: true,
    ledger: { idempotencyKey, jobId, status: "accepted", messageId: "message-1", contactId },
    message: {
      id: "message-1", idempotencyKey, contactId, conversationId, direction: "outbound",
      status: "sent", sentVia: "ai", sentAt: "2026-09-30T00:01:00.000Z",
      bodyMatchesLedger: true,
    },
    ...overrides,
  };
}

const base: MissionEvalInput = {
  mission: {
    id: "mission-1", leadId: "lead-1", status: "needs_review", acceptanceCriteria: "客户确认报价",
    acceptanceContract: null,
    resolutionReason: null, resolvedByUserId: null, maxRuns: 4, deadlineAt: null,
  },
  runs: [{ id: "run-1", status: "completed", errorCode: null }],
  specialists: [],
  proposals: [],
  replyDrafts: [],
  customerResponses: [],
  events: [],
  lead: { id: "lead-1", status: "open", stageId: "stage-1", contactId },
  budget: {
    missionId: "mission-1", maxTotalTokens: 72_000, maxTotalCostCents: 200,
    usedTokens: 12_000, usedCostCents: 15, unknownCostCalls: 0,
  },
  structuredOffer: {
    offerId: null, verdict: "not_issued", reason: "explicit_offer_missing",
    terms: null, outboundMessageId: null, inboundMessageId: null,
    structuredTermsAccepted: false,
  },
};

describe("mission outcome evaluation", () => {
  it("reports authenticated quote terms separately from full business acceptance", () => {
    const report = evaluateMission({
      ...base,
      structuredOffer: {
        offerId: "offer-1", verdict: "verified",
        reason: "exact_customer_channel_confirmation",
        terms: { description: "500 件设备", amountMinor: 123450, currency: "CNY",
          deliveryDate: "2026-10-15" },
        outboundMessageId: "message-1", inboundMessageId: "message-2",
        structuredTermsAccepted: true,
      },
    });
    expect(report.structuredOffer.structuredTermsAccepted).toBe(true);
    expect(report.businessOutcomeVerified).toBe(false);
    expect(report.findings).toContainEqual({
      code: "structured_offer_terms_confirmed_not_full_outcome", severity: "info",
    });
  });

  it("does not attest a completed Mission with an unsigned customer reply", () => {
    const report = evaluateMission({
      ...base,
      mission: { ...base.mission, status: "completed", resolutionReason: "负责人确认",
        resolvedByUserId: "user-1" },
      structuredOffer: { offerId: "offer-1", verdict: "unverified",
        reason: "customer_reply_signature_unverified", terms: null,
        outboundMessageId: "message-1", inboundMessageId: "message-2",
        structuredTermsAccepted: false },
    });
    expect(report.verdict).toBe("needs_review");
    expect(report.findings).toContainEqual({
      code: "structured_offer_channel_unverified", severity: "review",
    });
    expect(report.findings).toContainEqual({
      code: "completed_structured_offer_not_confirmed", severity: "review",
    });
  });

  it("fails closed on an internally inconsistent terms-confirmation signal", () => {
    const report = evaluateMission({
      ...base,
      structuredOffer: { ...base.structuredOffer, offerId: "offer-1",
        verdict: "verified", structuredTermsAccepted: true },
    });
    expect(report.structuredOffer).toMatchObject({
      verdict: "conflict", reason: "structured_offer_signal_inconsistent",
      structuredTermsAccepted: false,
    });
    expect(report.verdict).toBe("policy_failed");
  });

  it("does not mistake a completed Pi run for a completed business goal", () => {
    const report = evaluateMission(base);
    expect(report.verdict).toBe("needs_review");
    expect(report.businessOutcomeVerified).toBe(false);
    expect(report.summary.rootRuns).toBe(1);
  });

  it("checks user-selected observable facts without claiming free-text acceptance", () => {
    const contracted: MissionEvalInput = {
      ...base,
      mission: { ...base.mission, status: "completed", resolutionReason: "负责人确认", resolvedByUserId: "user-1",
        acceptanceContract: { revision: 1, checks: [
          { kind: "lead_status", equals: "won" },
          { kind: "customer_inbound_after_verified_send" },
        ] } },
      lead: { ...base.lead!, status: "won" },
    };
    const unmet = evaluateMission(contracted);
    expect(unmet.observableChecks).toMatchObject([
      { kind: "lead_status", verdict: "met" },
      { kind: "customer_inbound_after_verified_send", verdict: "unmet" },
    ]);
    expect(unmet.observableConditionsMet).toBe(false);
    expect(unmet.verdict).toBe("needs_review");
    expect(unmet.businessOutcomeVerified).toBe(false);

    const unverified = evaluateMission({ ...contracted, lead: null });
    expect(unverified.observableChecks[0]?.verdict).toBe("unverified");
    expect(unverified.observableConditionsMet).toBe(false);

    const crmOnly = evaluateMission({ ...contracted,
      mission: { ...contracted.mission,
        acceptanceContract: { revision: 1, checks: [{ kind: "lead_status", equals: "won" }] },
      },
    });
    expect(crmOnly.observableConditionsMet).toBe(true);
    expect(crmOnly.verdict).toBe("human_attested");
    expect(crmOnly.businessOutcomeVerified).toBe(false);
  });

  it("labels a documented human completion as attestation, never independent proof", () => {
    const report = evaluateMission({
      ...base,
      mission: {
        ...base.mission,
        status: "completed",
        resolutionReason: "客户在 CRM 会话中确认报价与交期。",
        resolvedByUserId: "user-1",
      },
    });
    expect(report.verdict).toBe("human_attested");
    expect(report.businessOutcomeVerified).toBe(false);
    expect(report.findings).toContainEqual({
      code: "human_attestation_not_independent_verification", severity: "info",
    });
  });

  it("flags a completion without its human evidence", () => {
    const report = evaluateMission({
      ...base, mission: { ...base.mission, status: "completed" },
    });
    expect(report.verdict).toBe("needs_review");
    expect(report.findings.some((finding) => finding.code === "completion_attestation_missing")).toBe(true);
  });

  it("keeps a human-attested mission under review when a run failed", () => {
    const report = evaluateMission({
      ...base,
      mission: {
        ...base.mission, status: "completed", resolutionReason: "客户确认了结果",
        resolvedByUserId: "user-1",
      },
      runs: [{ id: "run-1", status: "partial", errorCode: "tool_failed" }],
    });
    expect(report.verdict).toBe("needs_review");
    expect(report.businessOutcomeVerified).toBe(false);
  });

  it("keeps a human-attested mission under review when a specialist is partial", () => {
    const report = evaluateMission({
      ...base,
      mission: {
        ...base.mission, status: "completed", resolutionReason: "负责人已验收商机",
        resolvedByUserId: "user-1",
      },
      specialists: [{ id: "child-1", parentRunId: "run-1", status: "partial" }],
    });
    expect(report.verdict).toBe("needs_review");
    expect(report.summary.failedOrPartialSpecialists).toBe(1);
    expect(report.findings.some((finding) => finding.code === "specialist_failures_or_partial")).toBe(true);
  });

  it("separates a human-approved send from verified customer delivery", () => {
    const approved = {
      ...base,
      proposals: [{ id: "send-1", runId: "run-1", toolName: "send_message", status: "executed" }],
      events: [
        { runId: "run-1", sequence: 1, eventType: "human_confirmation_received", payload: { proposalId: "send-1", decision: "approve" } },
        { runId: "run-1", sequence: 2, eventType: "tool_started", payload: { proposalId: "send-1" } },
      ],
    } satisfies MissionEvalInput;
    const queued = evaluateMission({
      ...approved,
      replyDrafts: [delivery({ status: "approved", messageId: null, ledger: null, message: null })],
    });
    expect(queued.summary).toMatchObject({
      externalProposalsApproved: 1, customerMessagesSent: 0, customerMessagesNotSent: 1,
    });
    expect(queued.findings.some((finding) => finding.code === "customer_delivery_not_verified")).toBe(true);
    const sent = evaluateMission({
      ...approved,
      replyDrafts: [delivery()],
    });
    expect(sent.summary).toMatchObject({ customerMessagesSent: 1, customerMessagesNotSent: 0 });
    expect(sent.customerDeliveries).toMatchObject([{
      verdict: "verified", reason: "matching_ledger_and_crm_message",
    }]);
    const inconsistent = evaluateMission({
      ...approved,
      replyDrafts: [delivery({ messageId: null })],
    });
    expect(inconsistent.summary.customerMessagesNotSent).toBe(1);
  });

  it("does not count a sent draft without the accepted ledger and matching CRM message", () => {
    const withSend = {
      ...base,
      proposals: [{ id: "send-1", runId: "run-1", toolName: "send_message", status: "executed" }],
      events: [
        { runId: "run-1", sequence: 1, eventType: "human_confirmation_received", payload: { proposalId: "send-1", decision: "approve" } },
        { runId: "run-1", sequence: 2, eventType: "tool_started", payload: { proposalId: "send-1" } },
      ],
    } satisfies MissionEvalInput;
    const missing = evaluateMission({ ...withSend, replyDrafts: [delivery({ ledger: null })] });
    expect(missing.summary.customerMessagesSent).toBe(0);
    expect(missing.customerDeliveries[0]).toMatchObject({
      verdict: "unverified", reason: "ledger_or_message_missing",
    });
    const wrongContact = evaluateMission({ ...withSend, replyDrafts: [delivery({
      message: { ...delivery().message!, contactId: "contact-other" },
    })] });
    expect(wrongContact.summary.customerMessagesSent).toBe(0);
    expect(wrongContact.summary.customerDeliveryEvidenceConflicts).toBe(1);
    expect(wrongContact.verdict).toBe("policy_failed");
    const wrongReceipt = evaluateMission({ ...withSend, replyDrafts: [delivery({
      message: { ...delivery().message!, idempotencyKey: "unrelated-receipt" },
    })] });
    expect(wrongReceipt.customerDeliveries[0]).toMatchObject({
      verdict: "conflict", reason: "delivery_identity_mismatch",
    });
    const editedMessage = evaluateMission({ ...withSend, replyDrafts: [delivery({
      message: { ...delivery().message!, bodyMatchesLedger: false },
    })] });
    expect(editedMessage.customerDeliveries[0]).toMatchObject({
      verdict: "conflict", reason: "delivery_body_mismatch",
    });
    const redactedDraft = evaluateMission({ ...withSend, replyDrafts: [delivery({
      approvedBodyMatchesLedger: null,
    })] });
    expect(redactedDraft.customerDeliveries[0]).toMatchObject({
      verdict: "unverified", reason: "delivery_body_unavailable",
    });
    const beforeApproval = evaluateMission({ ...withSend, replyDrafts: [delivery({
      message: { ...delivery().message!, sentAt: "2026-09-29T23:59:00.000Z" },
    })] });
    expect(beforeApproval.customerDeliveries[0]).toMatchObject({
      verdict: "conflict", reason: "delivery_predates_approval",
    });
    const changedLead = evaluateMission({
      ...withSend,
      lead: { ...base.lead!, contactId: "contact-now-elsewhere" },
      replyDrafts: [delivery()],
    });
    expect(changedLead.customerDeliveries[0]).toMatchObject({
      verdict: "unverified", reason: "lead_contact_changed",
    });
  });

  it("requires a later inbound text on the same contact and conversation before reporting a reply", () => {
    const withSend = {
      ...base,
      proposals: [{ id: "send-1", runId: "run-1", toolName: "send_message", status: "executed" }],
      events: [
        { runId: "run-1", sequence: 1, eventType: "human_confirmation_received", payload: { proposalId: "send-1", decision: "approve" } },
        { runId: "run-1", sequence: 2, eventType: "tool_started", payload: { proposalId: "send-1" } },
      ],
      replyDrafts: [delivery()],
    } satisfies MissionEvalInput;
    const reply = {
      outboundMessageId: "message-1",
      reply: { id: "inbound-1", contactId, conversationId, sentAt: "2026-09-30T00:02:00Z" },
    };
    const observed = evaluateMission({ ...withSend, customerResponses: [reply] });
    expect(observed.summary.customerRepliesObserved).toBe(1);
    expect(observed.customerReplies[0]).toMatchObject({ verdict: "observed", inboundMessageId: "inbound-1" });
    expect(observed.businessOutcomeVerified).toBe(false);

    const noReply = evaluateMission({ ...withSend, customerResponses: [{ ...reply, reply: null }] });
    expect(noReply.customerReplies[0]?.verdict).toBe("not_observed");
    expect(noReply.summary.customerRepliesObserved).toBe(0);

    const missingLookup = evaluateMission({ ...withSend, customerResponses: [] });
    expect(missingLookup.customerReplies[0]?.verdict).toBe("unverified");
    expect(missingLookup.findings).toContainEqual({
      code: "customer_response_evidence_unavailable", severity: "review",
    });

    const wrongContact = evaluateMission({ ...withSend, customerResponses: [{
      ...reply, reply: { ...reply.reply, contactId: "other-contact" },
    }] });
    expect(wrongContact.customerReplies[0]?.verdict).toBe("conflict");
    expect(wrongContact.verdict).toBe("policy_failed");

    const beforeSend = evaluateMission({ ...withSend, customerResponses: [{
      ...reply, reply: { ...reply.reply, sentAt: "2026-09-30T00:00:30Z" },
    }] });
    expect(beforeSend.customerReplies[0]?.verdict).toBe("conflict");

    const unverifiedSend = evaluateMission({
      ...withSend,
      replyDrafts: [delivery({ ledger: null })],
      customerResponses: [reply],
    });
    expect(unverifiedSend.customerReplies[0]?.verdict).toBe("unverified");
  });

  it("fails a recorded external execution that lacks approval evidence", () => {
    const report = evaluateMission({
      ...base,
      proposals: [{ id: "proposal-1", runId: "run-1", toolName: "send_message", status: "executed" }],
    });
    expect(report.verdict).toBe("policy_failed");
    expect(report.findings.some((finding) =>
      finding.code === "external_action_without_prior_approval_evidence")).toBe(true);
  });

  it("fails when the approval event follows tool start", () => {
    const report = evaluateMission({
      ...base,
      proposals: [{ id: "proposal-1", runId: "run-1", toolName: "send_message", status: "executed" }],
      events: [
        { runId: "run-1", sequence: 4, eventType: "tool_started", payload: { proposalId: "proposal-1" } },
        { runId: "run-1", sequence: 5, eventType: "human_confirmation_received", payload: { proposalId: "proposal-1", decision: "approve" } },
      ],
    });
    expect(report.verdict).toBe("policy_failed");
  });

  it("surfaces multi-run customer touch and partial success for review", () => {
    const report = evaluateMission({
      ...base,
      runs: [...base.runs, { id: "run-2", status: "partial", errorCode: "tool_failed" }],
      proposals: [
        { id: "p1", runId: "run-1", toolName: "send_message", status: "executed" },
        { id: "p2", runId: "run-2", toolName: "send_message", status: "executed" },
      ],
      events: [
        { runId: "run-1", sequence: 1, eventType: "human_confirmation_received", payload: { proposalId: "p1", decision: "approve" } },
        { runId: "run-1", sequence: 2, eventType: "tool_started", payload: { proposalId: "p1" } },
        { runId: "run-2", sequence: 1, eventType: "human_confirmation_received", payload: { proposalId: "p2", decision: "approve" } },
        { runId: "run-2", sequence: 2, eventType: "tool_started", payload: { proposalId: "p2" } },
      ],
    });
    expect(report.verdict).toBe("needs_review");
    expect(report.summary).toMatchObject({
      failedOrPartialRuns: 1, crmChangesObserved: 0, crmChangeEvidenceConflicts: 0,
      externalProposalsApproved: 2, customerMessagesNotSent: 2, customerTouchRisk: true,
    });
  });

  it("only counts a CRM change that matches the executed proposal and this mission's lead", () => {
    const proposal = {
      id: "update-1", runId: "run-1", toolName: "crm_update_lead", status: "executed",
      preview: { resource: "crm_leads", resourceUuid: "lead-1", changedFields: ["title"] },
    };
    const completed = {
      runId: "run-1", sequence: 1, eventType: "tool_completed",
      payload: { proposalId: "update-1", tool: "crm_update_lead", status: "success" },
    };
    const change = {
      runId: "run-1", sequence: 2, eventType: "crm_state_changed",
      payload: {
        proposalId: "update-1", tool: "crm_update_lead", targetId: "lead-1",
        changedFields: ["title"],
      },
    };
    const valid = evaluateMission({
      ...base, proposals: [proposal], events: [completed, change],
    });
    expect(valid.summary).toMatchObject({
      crmChangesObserved: 1, crmChangeEvidenceConflicts: 0, crmChangesUnverified: 0,
    });
    const wrongLead = evaluateMission({
      ...base, proposals: [proposal], events: [completed, {
        ...change, payload: { ...change.payload, targetId: "another-lead" },
      }],
    });
    expect(wrongLead.summary).toMatchObject({
      crmChangesObserved: 0, crmChangeEvidenceConflicts: 1,
    });
    expect(wrongLead.verdict).toBe("policy_failed");
    const wrongPreview = evaluateMission({
      ...base, proposals: [{
        ...proposal,
        preview: { ...proposal.preview, resourceUuid: "another-lead" },
      }], events: [completed, change],
    });
    expect(wrongPreview.summary).toMatchObject({
      crmChangesObserved: 0, crmChangeEvidenceConflicts: 1,
    });
    const missingExecution = evaluateMission({
      ...base, proposals: [proposal], events: [change],
    });
    expect(missingExecution.summary).toMatchObject({
      crmChangesObserved: 0, crmChangesUnverified: 1,
    });
    const duplicate = evaluateMission({
      ...base, proposals: [proposal], events: [completed, change, { ...change, sequence: 3 }],
    });
    expect(duplicate.summary).toMatchObject({
      crmChangesObserved: 1, crmChangeEvidenceConflicts: 1,
    });
  });

  it("fails closed when cumulative model cost is unknown", () => {
    const report = evaluateMission({
      ...base, budget: { ...base.budget, unknownCostCalls: 1 },
    });
    expect(report.findings.some((finding) => finding.code === "mission_cost_unknown")).toBe(true);
    expect(report.verdict).toBe("needs_review");
  });
});
