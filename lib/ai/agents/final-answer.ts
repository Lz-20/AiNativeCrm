export const INTERNAL_DRAFT_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: "internal_final_answer_instruction", pattern: /\bnow produce (?:the )?final answer\b/i },
  { code: "internal_language_instruction", pattern: /\bwrite it in (?:chinese|english)\b/i },
  {
    code: "internal_style_instruction",
    pattern: /\bkeep (?:it|the answer) (?:concise|brief|reasonably concise|complete)\b/i,
  },
  {
    code: "internal_analysis_leak",
    pattern:
      /(?:^|\n)(?:let me (?:analyze|parse|think|structure|also|double-check|check|note|write)|now (?:i have|synthesize|draft|write)\b|i (?:should|need to)\b|wait\s*[—,-]|format:\s*report\b|structure the answer\b)/i,
  },
  {
    code: "internal_working_notes",
    pattern: /(?:^|\n)(?:key findings|priorities|impact scope|next steps \([^\n]*\)):\s*/i,
  },
];

export const UNSAFE_FINAL_ANSWER_PLACEHOLDER =
  "模型输出包含无法安全分离的内部组织稿；原始内容仅保留在受限运行状态中，请重新运行。";

export interface FinalAnswerInspection {
  internalDraftCodes: string[];
  likelyTruncated: boolean;
  truncationReasons: string[];
}

export function inspectProductFinalAnswer(text: string): FinalAnswerInspection {
  const trimmed = text.trim();
  const internalDraftCodes = INTERNAL_DRAFT_PATTERNS.filter((candidate) =>
    candidate.pattern.test(trimmed),
  ).map((candidate) => candidate.code);
  const truncationReasons: string[] = [];
  if (trimmed && /[,，、:：;；(（]$/.test(trimmed))
    truncationReasons.push("unfinished_punctuation");
  if (
    trimmed &&
    /(?:负责人为|归属为|因为|由于|因此|以及|并且|但|且|包括|例如|叠加|分别为)$/.test(trimmed)
  )
    truncationReasons.push("unfinished_connector");
  const fences = trimmed.match(/```/g)?.length ?? 0;
  if (fences % 2 !== 0) truncationReasons.push("unclosed_code_fence");
  const boldMarkers = trimmed.match(/\*\*/g)?.length ?? 0;
  if (boldMarkers % 2 !== 0) truncationReasons.push("unclosed_bold_marker");
  if (/(?:^|\n)\s*\d{1,2}[.)、]?\s*$/.test(trimmed))
    truncationReasons.push("unfinished_list_item");
  return {
    internalDraftCodes,
    likelyTruncated: truncationReasons.length > 0,
    truncationReasons,
  };
}

/**
 * Some OpenAI-compatible providers return private drafting prose in the same
 * assistant text block as the product answer. The raw message remains in the
 * service-only run state; only a clearly delimited Markdown answer is exposed.
 */
export function extractProductFinalAnswer(text: string): {
  text: string;
  sanitized: boolean;
  inspection: FinalAnswerInspection;
} {
  const trimmed = text.trim();
  let rawInspection = inspectProductFinalAnswer(trimmed);
  const heading = /^#{1,3}\s+\S.*$/gm;
  const matches = [...trimmed.matchAll(heading)];
  const boundary = matches.find((match) => (match.index ?? 0) > 0)?.index;
  const preamble = boundary === undefined ? "" : trimmed.slice(0, boundary);
  if (
    boundary !== undefined &&
    /^(?:now|let me|i (?:should|need to))\b/i.test(preamble.trim()) &&
    rawInspection.internalDraftCodes.length === 0
  )
    rawInspection = {
      ...rawInspection,
      internalDraftCodes: ["internal_english_draft_preamble"],
    };
  if (rawInspection.internalDraftCodes.length === 0)
    return { text: trimmed, sanitized: false, inspection: rawInspection };
  if (boundary === undefined)
    return {
      text: UNSAFE_FINAL_ANSWER_PLACEHOLDER,
      sanitized: false,
      inspection: rawInspection,
    };
  const extracted = trimmed.slice(boundary).trim();
  return {
    text: extracted,
    sanitized: true,
    inspection: inspectProductFinalAnswer(extracted),
  };
}
