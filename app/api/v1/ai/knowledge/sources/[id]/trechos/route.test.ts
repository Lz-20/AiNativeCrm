import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi
    .fn()
    .mockResolvedValue({ ok: true, org: { orgId: "org" }, user: { idioma: "pt-BR" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: mocks.from }) }));
import { GET } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const version = "22222222-2222-4222-8222-222222222222";
const chunk = "33333333-3333-4333-8333-333333333333";
function stub(active = true) {
  const filters: Array<[string, unknown]> = [];
  mocks.from.mockImplementation((table: string) => {
    const result = {
      data:
        table === "ai_knowledge_sources"
          ? {
              id,
              name: "Wiki",
              active_kb_version_id: "current",
              is_active: active,
              chunks_count: 4,
            }
          : [{ id: chunk, kb_version_id: version, content: "Historical quote" }],
      error: null,
    };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return builder;
  });
  return filters;
}
beforeEach(() => vi.clearAllMocks());
describe("exact knowledge index locators", () => {
  it("resolves the observed version/chunk while marking it as historical", async () => {
    const filters = stub();
    const response = await GET(
      new Request(`http://localhost/trechos?version_id=${version}&chunk_id=${chunk}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      index_version_id: version,
      is_current_index: false,
      total: 1,
    });
    expect(filters).toEqual(
      expect.arrayContaining([
        ["organization_id", "org"],
        ["knowledge_source_id", id],
        ["kb_version_id", version],
        ["id", chunk],
      ]),
    );
  });
  it("does not revive an archived source through an old version URI", async () => {
    stub(false);
    expect(
      (
        await GET(new Request(`http://localhost/trechos?version_id=${version}`), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(404);
    expect(mocks.from).not.toHaveBeenCalledWith("ai_chunks");
  });
  it("rejects malformed locations before reading tenant data", async () => {
    stub();
    expect(
      (
        await GET(new Request("http://localhost/trechos?version_id=bad"), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
