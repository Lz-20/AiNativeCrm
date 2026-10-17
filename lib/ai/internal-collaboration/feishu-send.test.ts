import { describe, expect, it, vi } from "vitest";
import { sendFeishuDirectMessage } from "@/lib/ai/internal-collaboration/feishu-send";

describe("Feishu outbound transport", () => {
  it("sends a private text with a stable provider deduplication UUID", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: "tenant-token" }))
      .mockResolvedValueOnce(Response.json({ code: 0,
        data: { message_id: "om-question", chat_id: "oc-colleague" } }));
    await expect(sendFeishuDirectMessage({ appId: "cli-app", appSecret: "secret" }, {
      openId: "ou-colleague", text: "请确认 500 件交期", uuid: "request-uuid",
    }, fetcher)).resolves.toEqual({ messageId: "om-question", chatId: "oc-colleague" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[1]!;
    expect(url).toContain("receive_id_type=open_id");
    expect(JSON.parse(options.body)).toEqual({
      receive_id: "ou-colleague", msg_type: "text",
      content: JSON.stringify({ text: "请确认 500 件交期" }), uuid: "request-uuid",
    });
  });

  it("does not send when credentials or token acquisition fail", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 999 }));
    await expect(sendFeishuDirectMessage({ appId: "", appSecret: "" }, {
      openId: "ou-a", text: "question", uuid: "uuid",
    }, fetcher)).rejects.toMatchObject({ code: "config_missing" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(sendFeishuDirectMessage({ appId: "cli-app", appSecret: "secret" }, {
      openId: "ou-a", text: "question", uuid: "uuid",
    }, fetcher)).rejects.toMatchObject({ code: "token_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never treats an acknowledged response without receipt IDs as sent", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: "token" }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: {} }));
    await expect(sendFeishuDirectMessage({ appId: "cli-app", appSecret: "secret" }, {
      openId: "ou-a", text: "question", uuid: "uuid",
    }, fetcher)).rejects.toMatchObject({ code: "delivery_unconfirmed" });
  });
});
