import { allowlistedFetch, buildAllowlist } from "@/lib/agent-engine/edge/egress";
import type { IntegrationBinding } from "./config";

/** No redirects, no caller-selected hosts, no response bodies in errors/logs. */
export async function integrationFetch(
  binding: IntegrationBinding,
  path: string,
  init: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("integration_path_invalid");
  const url = new URL(path, binding.base_url);
  if (url.origin !== new URL(binding.base_url).origin)
    throw new Error("integration_origin_invalid");
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)])
    : AbortSignal.timeout(8000);
  const response = await allowlistedFetch(
    url,
    { ...init, signal, redirect: "error" },
    {
      allowlist: buildAllowlist([binding.base_url]),
      ...(fetchImpl ? { fetchImpl } : {}),
    },
  );
  if (!response.ok) throw new Error(`integration_http_${response.status}`);
  return response;
}
