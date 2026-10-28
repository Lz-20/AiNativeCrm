import { randomUUID } from "node:crypto";
import type pg from "pg";
import { destinoEhLocal } from "../../../scripts/lib/env-de-teste";

type Destination = { url: string; dbUrl: string; appUrl: string };

// requestTurnDeps fornece uma chave interna apenas para Anthropic no modo
// controlado. A resolução de credencial e os gates continuam sendo os reais.
export const CONFIG_PREVIEW_CONTROLADO = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  pacing: { windowStartHour: 0, windowEndHour: 24 },
} as const;

export function afirmarDestinoDoPreviewControlado(destination: Destination, controlled: string | undefined) {
  if (controlled !== "true") throw new Error("A fixture exige o runtime controlado.");
  if ([destination.url, destination.dbUrl, destination.appUrl].some((url) => !url || !destinoEhLocal(url))) {
    throw new Error("O preview controlado exige API, banco e aplicação locais.");
  }
}

/** Só cria dados sintéticos próprios na organização local do seed. Nenhum
 * canal/Agent existente é alterado. A versão e a execução passam pelas rotas
 * autenticadas da aplicação, não por este helper de preparação.
 */
export async function prepararPreviewControlado(
  pool: pg.Pool,
  input: { destination: Destination; controlled: string | undefined; orgId: string; adminEmail: string },
) {
  afirmarDestinoDoPreviewControlado(input.destination, input.controlled);
  const { orgId } = input;
  const agentId = randomUUID(), channelId = randomUUID(), credentialId = randomUUID();
  const label = `qa-preview-controlado-${agentId}`;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `select u.id from auth.users u
       join user_organizations m on m.user_id=u.id and m.organization_id=$1
       join organizations o on o.id=m.organization_id
       where u.email=$2 and o.slug='e2e-test-org' and m.role='admin'
         and m.revoked_at is null and m.accepted_at is not null
         and not exists(select 1 from platform_admins p where p.user_id=u.id and p.revoked_at is null)`,
      [orgId, input.adminEmail],
    );
    const adminId = rows[0]?.id;
    if (rows.length !== 1 || !adminId) throw new Error("Organização ou identidade da fixture inesperada.");
    await client.query(
      `insert into channel_sessions(id,organization_id,waha_session_name,display_name,webhook_secret_encrypted)
       values($1,$2,$3,'Preview controlado local',decode('00','hex'))`,
      [channelId, orgId, label],
    );
    // Só a janela deste canal sintético. Opt-out, caps, promessas, RLS e todos
    // os outros gates ficam ativos; o preview jamais entrega mensagem ao canal.
    await client.query(
      `insert into channel_knobs(organization_id,channel_session_id,window_start_hour,window_end_hour)
       values($1,$2,$3,$4)`,
      [orgId, channelId, CONFIG_PREVIEW_CONTROLADO.pacing.windowStartHour, CONFIG_PREVIEW_CONTROLADO.pacing.windowEndHour],
    );
    // Mesmo contrato do seed-e2e-followup-agent: placeholder NÃO validado,
    // nunca decifrado. Não representa chave de provider externo. O runtime
    // controlado resolve a chave interna de requestTurnDeps após a consulta.
    await client.query(
      `insert into ai_provider_credentials(id,organization_id,provider,label,
         api_key_encrypted,api_key_iv,api_key_tag,api_key_last4,is_active,validated_at,created_by)
       values($1,$2,'anthropic',$3,decode('00','hex'),decode('00','hex'),decode('00','hex'),'test',true,null,$4)`,
      [credentialId, orgId, label, adminId],
    );
    await client.query(
      `insert into ai_agents(id,organization_id,name,kind,origin,model_binding_mode,system_prompt,model,created_by)
       values($1,$2,$3,'mcp_agent','user','pinned','Preview controlado local',$4,$5)`,
      [agentId, orgId, label, CONFIG_PREVIEW_CONTROLADO.model, adminId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return {
    agentId, channelId, credentialId,
    provider: CONFIG_PREVIEW_CONTROLADO.provider,
    model: CONFIG_PREVIEW_CONTROLADO.model,
    async cleanup() {
      const connection = await pool.connect();
      try {
        await connection.query("begin");
        // Runs referenciam versões/Agents com RESTRICT. Só os IDs desta corrida.
        await connection.query("delete from ai_agent_runs where organization_id=$1 and agent_id=$2", [orgId, agentId]);
        await connection.query("delete from ai_agent_versions where organization_id=$1 and agent_id=$2", [orgId, agentId]);
        await connection.query("delete from ai_agents where organization_id=$1 and id=$2", [orgId, agentId]);
        await connection.query("delete from channel_knobs where organization_id=$1 and channel_session_id=$2", [orgId, channelId]);
        await connection.query("delete from channel_sessions where organization_id=$1 and id=$2", [orgId, channelId]);
        await connection.query("delete from ai_provider_credentials where organization_id=$1 and id=$2", [orgId, credentialId]);
        await connection.query("commit");
      } catch (error) {
        await connection.query("rollback");
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
