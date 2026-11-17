/** Fixed public diagnostics. Never retain an upstream message, response, cause or SSE. */
export type ModelFailureCode =
  | "model_binding_unavailable"
  | "credential_provider_mismatch"
  | "credential_unavailable"
  | "credential_ambiguous"
  | "model_failed"
  | "model_aborted"
  | "model_empty_response"
  | "model_stream_invalid"
  | "model_http_401"
  | "model_http_403"
  | "model_http_404"
  | "credential_rejected"
  | "model_not_found"
  | "model_rate_limited"
  | "model_unavailable"
  | "model_http_429"
  | "model_http_5xx"
  | "model_http_error"
  | "model_network_error"
  | "checkpoint_invalid";

export class ModelCallError extends Error {
  constructor(
    readonly code: ModelFailureCode,
    readonly stage: "binding" | "credential" | "provider_http" | "runtime" | "checkpoint",
    readonly httpStatus: number | null = null,
    readonly stopReason: "error" | "aborted" | null = null,
  ) {
    super(code);
    this.name = code === "model_aborted" ? "AbortError" : "ModelCallError";
  }
}

export function modelHttpFailure(status: number): ModelCallError {
  const code =
    status === 401
      ? "model_http_401"
      : status === 403
        ? "model_http_403"
        : status === 404
          ? "model_http_404"
          : status === 429
            ? "model_http_429"
            : status >= 500
              ? "model_http_5xx"
              : "model_http_error";
  return new ModelCallError(code, "provider_http", status, "error");
}

export function safeModelFailure(error: unknown, aborted = false): ModelCallError {
  if (aborted || (error instanceof Error && error.name === "AbortError"))
    return new ModelCallError("model_aborted", "runtime", null, "aborted");
  if (error instanceof ModelCallError) return error;
  // Only a numeric status is accepted from third-party errors, never arbitrary text.
  const value = error as { status?: unknown; statusCode?: unknown } | null;
  const status = value?.statusCode ?? value?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
    return modelHttpFailure(status);
  // Text may inform a fixed category in memory, but is never retained or returned.
  const text = error instanceof Error ? error.message : "";
  if (/unauthor|invalid.*api.?key|authentication|incorrect api key/i.test(text))
    return new ModelCallError("credential_rejected", "runtime", null, "error");
  if (/model.*not.*found|does not exist/i.test(text))
    return new ModelCallError("model_not_found", "runtime", null, "error");
  if (/rate.?limit|quota|insufficient.*credit/i.test(text))
    return new ModelCallError("model_rate_limited", "runtime", null, "error");
  if (/timeout|ECONNREFUSED|fetch failed|network/i.test(text))
    return new ModelCallError("model_unavailable", "runtime", null, "error");
  return new ModelCallError("model_failed", "runtime", null, "error");
}
