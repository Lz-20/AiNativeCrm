import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  ASK_INTERNAL_COLLEAGUE_TOOL, LIST_INTERNAL_COLLEAGUES_TOOL,
  createMissionQuestionTools,
} from "./internal-question-tools";

const prior = {
  tenant: process.env.FEISHU_TENANT_KEY,
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    FEISHU_TENANT_KEY: prior.tenant,
    FEISHU_APP_ID: prior.appId,
    FEISHU_APP_SECRET: prior.appSecret,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("lists only the configured organization's mapped colleagues and stages without sending", async () => {
  process.env.FEISHU_TENANT_KEY = "tenant-a";
  process.env.FEISHU_APP_ID = "cli-test";
  process.env.FEISHU_APP_SECRET = "secret-test";
  const query = vi.fn().mockResolvedValue({ rows: [{ user_id: "user-a", full_name: "交付同事" }] });
  const recordProposal = vi.fn();
  const tools = createMissionQuestionTools({
    pool: { query } as unknown as Pool,
    organizationId: "org-a",
    leadId: "lead-a",
    recordProposal,
  });
  const list = tools[LIST_INTERNAL_COLLEAGUES_TOOL] as {
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  };
  const ask = tools[ASK_INTERNAL_COLLEAGUE_TOOL] as {
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  };
  expect(await list.execute({}, {})).toEqual({ available: true,
    recipients: [{ user_id: "user-a", full_name: "交付同事" }] });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("t.organization_id=$1"),
    ["org-a", "tenant-a"]);
  expect(await ask.execute({ recipientUserId: "not-a-uuid", question: "请核对交期" }, {}))
    .toEqual({ staged: false, reason: "invalid_arguments" });
  expect(recordProposal).not.toHaveBeenCalled();
  const args = { recipientUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    question: "请核对这笔商机的交期" };
  expect(await ask.execute(args, {})).toEqual({ staged: true,
    requiresHumanConfirmation: true, delivered: false });
  expect(recordProposal).toHaveBeenCalledOnce();
  expect(recordProposal).toHaveBeenCalledWith(args);
  expect(query).toHaveBeenCalledTimes(1);
});

it("does not advertise colleagues when the channel is unconfigured", async () => {
  delete process.env.FEISHU_APP_SECRET;
  const query = vi.fn();
  const tools = createMissionQuestionTools({
    pool: { query } as unknown as Pool,
    organizationId: "org-a", leadId: "lead-a", recordProposal: vi.fn(),
  });
  const list = tools[LIST_INTERNAL_COLLEAGUES_TOOL] as {
    execute: (args: unknown, options: unknown) => Promise<unknown>;
  };
  expect(await list.execute({}, {})).toEqual({ available: false, recipients: [] });
  expect(query).not.toHaveBeenCalled();
});
