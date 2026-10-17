import { integrationQuery } from "./db";
import { z } from "zod";
import type { Pool } from "pg";

export const integrationProviderSchema = z.enum(["mem0", "weknora", "langfuse"]);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
const endpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "")
    );
  });
const bindingSchema = z
  .object({
    organization_id: z.string().uuid(),
    provider: integrationProviderSchema,
    base_url: endpointSchema,
    allow_insecure_http: z.literal(true).optional(),
    api_key: z.string().min(1).optional(),
    public_key: z.string().min(1).optional(),
    secret_key: z.string().min(1).optional(),
    knowledge_base_ids: z.array(z.string().min(1).max(200)).min(1).optional(),
    visibility: z.literal("organization").optional(),
  })
  .strict();
export type IntegrationBinding = z.infer<typeof bindingSchema>;

/** Only a trusted installation operator can map a CRM org to an external tenant/project. */
export function integrationBindings(
  raw = process.env.AI_INTEGRATION_BINDINGS,
): IntegrationBinding[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = z.array(bindingSchema).max(1000).parse(JSON.parse(raw));
    const identities = new Set<string>();
    const projects = new Set<string>();
    for (const binding of parsed) {
      const endpoint = new URL(binding.base_url);
      if (
        endpoint.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
        !binding.allow_insecure_http
      )
        return [];
      const identity = `${binding.organization_id}:${binding.provider}`;
      if (identities.has(identity)) return [];
      identities.add(identity);
      if (binding.provider === "langfuse") {
        if (!binding.public_key || !binding.secret_key) return [];
        // Metadata is not ACL: disallow sharing one Langfuse project across CRM orgs.
        const project = `${new URL(binding.base_url).origin}:${binding.public_key}`;
        if (projects.has(project)) return [];
        projects.add(project);
      } else if (!binding.api_key) return [];
      if (
        binding.provider === "weknora" &&
        (!binding.knowledge_base_ids?.length || binding.visibility !== "organization")
      )
        return [];
    }
    return parsed;
  } catch {
    return [];
  } // Invalid optional configuration never takes down the CRM.
}

export function integrationBinding(organizationId: string, provider: IntegrationProvider) {
  return (
    integrationBindings().find(
      (item) => item.organization_id === organizationId && item.provider === provider,
    ) ?? null
  );
}

export async function enabledIntegration(
  pool: Pool,
  organizationId: string,
  provider: IntegrationProvider,
) {
  const binding = integrationBinding(organizationId, provider);
  if (!binding) return null; // Default off: no DB access or outbound call required.
  const { rows } = await integrationQuery<{ enabled: boolean }>(
    pool,
    "select enabled from ai_integration_settings where organization_id=$1 and provider=$2",
    [organizationId, provider],
  );
  return rows[0]?.enabled === true ? binding : null;
}
