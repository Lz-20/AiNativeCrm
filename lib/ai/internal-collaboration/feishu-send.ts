/** Narrow outbound transport. CRM owns authorization, idempotency and state. */
export interface FeishuSendConfig {
  appId: string;
  appSecret: string;
}

export interface FeishuSendRequest {
  openId: string;
  text: string;
  uuid: string;
}

export interface FeishuSendReceipt {
  messageId: string;
  chatId: string;
}

export class FeishuSendError extends Error {
  constructor(readonly code: "config_missing" | "token_unavailable" |
    "delivery_unavailable" | "delivery_rejected" | "delivery_unconfirmed") {
    super(`feishu_${code}`);
    this.name = "FeishuSendError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  try { return record(await response.json()); }
  catch { return null; }
}

export async function sendFeishuDirectMessage(
  config: FeishuSendConfig,
  request: FeishuSendRequest,
  fetcher: typeof fetch = fetch,
): Promise<FeishuSendReceipt> {
  if (!config.appId || !config.appSecret) throw new FeishuSendError("config_missing");
  if (!request.openId || !request.text || !request.uuid)
    throw new FeishuSendError("delivery_rejected");
  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch { throw new FeishuSendError("token_unavailable"); }
  const tokenBody = await jsonResponse(tokenResponse);
  const token = tokenBody?.tenant_access_token;
  if (!tokenResponse.ok || tokenBody?.code !== 0 ||
      typeof token !== "string" || !token)
    throw new FeishuSendError("token_unavailable");

  let sendResponse: Response;
  try {
    sendResponse = await fetcher(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: request.openId,
          msg_type: "text",
          content: JSON.stringify({ text: request.text }),
          uuid: request.uuid,
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch { throw new FeishuSendError("delivery_unavailable"); }
  const body = await jsonResponse(sendResponse);
  if (!sendResponse.ok || body?.code !== 0)
    throw new FeishuSendError("delivery_rejected");
  const data = record(body.data);
  const messageId = data?.message_id;
  const chatId = data?.chat_id;
  if (typeof messageId !== "string" || !messageId || messageId.length > 256 ||
      typeof chatId !== "string" || !chatId || chatId.length > 256)
    throw new FeishuSendError("delivery_unconfirmed");
  return { messageId, chatId };
}
