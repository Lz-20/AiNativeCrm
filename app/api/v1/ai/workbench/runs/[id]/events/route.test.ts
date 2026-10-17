import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "user-a" },
    org: { orgId: ORG_A, role: "manager" },
  } as never);
});

describe("GET /api/v1/ai/workbench/runs/:id/events", () => {
  it("replays only events after Last-Event-ID within the authorized tenant", async () => {
    const filters: Array<[string, unknown]> = [];
    let eventReads = 0;
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      }),
      gt: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      }),
      order: vi.fn(() => builder),
      limit: vi.fn(async () => ({
        data:
          eventReads++ === 0
            ? [
                {
                  sequence: 5,
                  event_type: "tool_completed",
                  payload: { tool: "crm_find_contacts" },
                  created_at: "2026-09-26T00:00:00Z",
                },
              ]
            : [],
        error: null,
      })),
      maybeSingle: vi.fn(async () => ({ data: { id: RUN_ID, status: "completed" }, error: null })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const { GET } = await import("./route");
    const req = new NextRequest(
      `http://localhost/api/v1/ai/workbench/runs/${RUN_ID}/events?after=2`,
      { headers: { "Last-Event-ID": "4" } },
    );
    const res = await GET(req, { params: Promise.resolve({ id: RUN_ID }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("id: 5\nevent: tool_completed");
    expect(body).toContain('"tool":"crm_find_contacts"');
    expect(filters).toContainEqual(["organization_id", ORG_A]);
    expect(filters).toContainEqual(["run_id", RUN_ID]);
    expect(filters).toContainEqual(["sequence", 4]);
  });

  it("rejects an invalid run id before reading any tenant data", async () => {
    const from = vi.fn();
    vi.mocked(createAdminClient).mockReturnValue({ from } as never);
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/v1/ai/workbench/runs/not-a-uuid/events"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("stops polling when the SSE consumer disconnects", async () => {
    let finishEventRead!: (value: { data: never[]; error: null }) => void;
    const limit = vi.fn(
      () => new Promise<{ data: never[]; error: null }>((resolve) => { finishEventRead = resolve; }),
    );
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit,
      maybeSingle: vi.fn(async () => ({ data: { id: RUN_ID, status: "running" }, error: null })),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: vi.fn(() => builder) } as never);

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/ai/workbench/runs/${RUN_ID}/events`),
      { params: Promise.resolve({ id: RUN_ID }) },
    );
    const reader = res.body!.getReader();
    await vi.waitFor(() => expect(limit).toHaveBeenCalledTimes(1));
    const cancellation = reader.cancel();
    finishEventRead({ data: [], error: null });
    await cancellation;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(limit).toHaveBeenCalledTimes(1);
    expect(builder.maybeSingle).toHaveBeenCalledTimes(1);
  });
});
