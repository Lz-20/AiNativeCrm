// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Valores sintéticos; só o transporte é substituído. Os clients canônicos e o
// SDK travado no lockfile executam de verdade, sem servidor, banco ou credenciais.
const projectUrl = "https://supabase-transport.invalid";
const internalProjectUrl = "http://supabase-api-gw:8000";
function jwt(role: string) {
  return (
    [
      { alg: "HS256", typ: "JWT" },
      { role, sub: "11111111-1111-4111-8111-111111111111", exp: 4_000_000_000 },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".") + ".fixture-signature"
  );
}
const userToken = jwt("authenticated");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "fixture@example.invalid",
};
const keyPairs = [
  {
    name: "publishable/secret",
    public: "sb_publishable_transport_fixture",
    secret: "sb_secret_transport_fixture",
  },
  { name: "anon/service_role JWT", public: jwt("anon"), secret: jwt("service_role") },
];

let requests: { url: URL; headers: Headers; method: string }[];
let clients: SupabaseClient[];
const cookieJar = new Map<string, string>();
let writtenCookieOptions: { httpOnly?: boolean; sameSite?: string; secure?: boolean }[];
let socketUrls: string[];
let socketFrames: unknown[][];

class FixtureWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: ((event: object) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: object) => void) | null = null;
  onerror: ((event: object) => void) | null = null;
  constructor(url: string | URL) {
    socketUrls.push(String(url));
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    const frame = JSON.parse(data) as unknown[];
    socketFrames.push(frame);
    const [joinRef, ref, topic] = frame;
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify([
          joinRef,
          ref,
          topic,
          "phx_reply",
          { status: "ok", response: { postgres_changes: [] } },
        ]),
      }),
    );
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

beforeEach(() => {
  vi.resetModules();
  requests = [];
  clients = [];
  socketUrls = [];
  socketFrames = [];
  cookieJar.clear();
  writtenCookieOptions = [];
  vi.stubGlobal("WebSocket", FixtureWebSocket);
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string, options: (typeof writtenCookieOptions)[number]) => {
        cookieJar.set(name, value);
        writtenCookieOptions.push(options);
      },
    }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "https://ui-fixture.invalid",
      );
      requests.push({
        url,
        headers: new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        ),
        method: init?.method ?? "GET",
      });
      if (url.pathname === "/api/v1/auth/realtime-token") {
        return Response.json({ data: { access_token: userToken, expires_at: 4_000_000_000 } });
      }
      if (![projectUrl, internalProjectUrl].includes(url.origin))
        throw new Error("O SDK tentou sair do transporte de teste.");
      if (url.pathname === "/auth/v1/token") {
        return Response.json({
          access_token: userToken,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          token_type: "bearer",
          user,
        });
      }
      if (url.pathname === "/auth/v1/user") return Response.json(user);
      if (url.pathname === "/auth/v1/admin/users")
        return Response.json({ users: [user], aud: "authenticated" });
      if (url.pathname.startsWith("/rest/v1/")) return Response.json([{ id: user.id }]);
      if (url.pathname.startsWith("/storage/v1/object/sign/"))
        return Response.json({
          signedURL: "/object/sign/fixture/file.txt?token=fixture-signature",
        });
      if (url.pathname.startsWith("/storage/v1/object/"))
        return Response.json({ Id: user.id, Key: "fixture/file.txt" });
      if (url.pathname.startsWith("/functions/v1/")) return Response.json({ fixture: true });
      throw new Error(`Caminho não previsto no transporte: ${url.pathname}`);
    }),
  );
});

afterEach(async () => {
  for (const client of clients) {
    await client.auth.stopAutoRefresh();
    await client.removeAllChannels();
    client.realtime.disconnect();
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/env");
  vi.doUnmock("next/headers");
});

function runtimeKeys(pair: (typeof keyPairs)[number], internalUrl = "") {
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: projectUrl,
      SUPABASE_INTERNAL_URL: internalUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: pair.public,
      SUPABASE_SERVICE_ROLE_KEY: pair.secret,
      NEXT_PUBLIC_APP_URL: "https://ui-fixture.invalid",
      NODE_ENV: "test",
    },
  }));
}

describe.each(keyPairs)("contrato de transporte do SDK: $name", (pair) => {
  it("login interno, proxy e browser público preservam o namespace canônico da sessão", async () => {
    runtimeKeys(pair, internalProjectUrl);
    const { createClient: createServer } = await import("./server");
    const server = await createServer();
    clients.push(server);
    expect(
      (await server.auth.signInWithPassword({ email: user.email, password: "fixture-password" }))
        .error,
    ).toBeNull();
    expect(Reflect.get(server.auth, "storageKey")).toBe("sb-pi-native-auth");
    expect([...cookieJar.keys()].length).toBeGreaterThan(0);
    expect([...cookieJar.keys()].every((key) => /^sb-pi-native-auth(?:\.\d+)?$/.test(key))).toBe(
      true,
    );

    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    requests.length = 0;
    const response = await proxy(
      new NextRequest("https://ui-fixture.invalid/app/contacts", {
        headers: { cookie: [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ") },
      }),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe(internalProjectUrl + "/auth/v1/user");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${userToken}`);

    vi.stubGlobal("window", {
      __PUBLIC_ENV__: {
        NEXT_PUBLIC_SUPABASE_URL: projectUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: pair.public,
      },
    });
    const { createClient: createBrowser } = await import("./browser");
    const browser = createBrowser();
    clients.push(browser);
    expect(Reflect.get(browser.auth, "storageKey")).toBe(Reflect.get(server.auth, "storageKey"));
    expect(Reflect.get(browser.auth, "storageKey")).not.toContain("api-gw");
    expect(
      writtenCookieOptions.every((options) => options.httpOnly && options.sameSite === "strict"),
    ).toBe(true);
  });

  it("server e admin usam a rede interna sem trocar a URL pública do navegador", async () => {
    runtimeKeys(pair, internalProjectUrl);
    const { createAdminClient } = await import("./admin");
    const { createClient } = await import("./server");
    const admin = createAdminClient();
    const server = await createClient();
    clients.push(admin, server);
    expect((await admin.from("organizations").select("id")).error).toBeNull();
    expect(
      (await server.auth.signInWithPassword({ email: user.email, password: "fixture-password" }))
        .error,
    ).toBeNull();
    expect((await server.auth.getUser()).data.user?.id).toBe(user.id);
    const { storageUrlForDelivery } = await import("./storage-url");
    const { data: signed } = await admin.storage.from("fixture").createSignedUrl("file.txt", 60);
    expect(signed?.signedUrl).toContain(internalProjectUrl);
    expect(storageUrlForDelivery(signed!.signedUrl)).toBe(
      projectUrl + "/storage/v1/object/sign/fixture/file.txt?token=fixture-signature",
    );
    expect(requests.every((request) => request.url.origin === internalProjectUrl)).toBe(true);
    expect(requests[0]?.headers.get("apikey")).toBe(pair.secret);
    expect(requests[1]?.headers.get("apikey")).toBe(pair.public);
    expect(requests[2]?.headers.get("authorization")).toBe(`Bearer ${userToken}`);
  });

  it("admin envia a chave em apikey para REST, Auth admin e Storage; Functions trata o formato", async () => {
    runtimeKeys(pair);
    const { createAdminClient } = await import("./admin");
    const client = createAdminClient();
    clients.push(client);
    expect((await client.from("organizations").select("id")).error).toBeNull();
    expect((await client.auth.admin.listUsers({ page: 1, perPage: 1 })).data.users[0]?.id).toBe(
      user.id,
    );
    expect((await client.storage.from("fixture").upload("file.txt", "fixture")).error).toBeNull();
    expect(
      (await client.storage.from("fixture").createSignedUrl("file.txt", 60)).data?.signedUrl,
    ).toContain("token=fixture-signature");
    expect((await client.functions.invoke("fixture")).error).toBeNull();
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.headers.get("apikey")).toBe(pair.secret);
      // 2.116.0 preserva o fallback Bearer para REST/Storage/Auth e o suprime
      // para Functions com chave nova. Isso mede o SDK; não simula validação Cloud.
      const functionsWithNewKey =
        request.url.pathname.startsWith("/functions/") && pair.secret.startsWith("sb_secret_");
      expect(request.headers.get("authorization")).toBe(
        functionsWithNewKey ? null : `Bearer ${pair.secret}`,
      );
    }
  });

  it("server separa apikey da sessão do usuário e conserva cookies HttpOnly", async () => {
    runtimeKeys(pair);
    const { createClient } = await import("./server");
    const client = await createClient();
    clients.push(client);
    expect((await client.from("organizations").select("id")).error).toBeNull();
    expect(requests[0]?.headers.get("apikey")).toBe(pair.public);
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${pair.public}`);
    expect(
      (await client.auth.signInWithPassword({ email: user.email, password: "fixture-password" }))
        .error,
    ).toBeNull();
    expect(cookieJar.size).toBeGreaterThan(0);
    expect(writtenCookieOptions).not.toHaveLength(0);
    for (const options of writtenCookieOptions) {
      expect(options).toMatchObject({ httpOnly: true, sameSite: "strict", secure: true });
    }
    requests.length = 0;
    expect((await client.auth.getUser()).data.user?.id).toBe(user.id);
    expect((await client.from("organizations").select("id")).error).toBeNull();
    expect((await client.storage.from("fixture").createSignedUrl("file.txt", 60)).error).toBeNull();
    expect((await client.functions.invoke("fixture")).error).toBeNull();
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.headers.get("apikey")).toBe(pair.public);
      expect(request.headers.get("authorization")).toBe(`Bearer ${userToken}`);
      expect(request.headers.get("authorization")).not.toContain(pair.secret);
    }
  });

  it("browser usa o runtime e o join Realtime leva JWT do usuário, nunca a API key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://build-only.invalid");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "build-fixture-key");
    // Sem DOM, o SSR SDK não mantém singleton/timers de navegador entre casos.
    // A fonte pública continua a mesma que o browser real recebe do servidor.
    vi.stubGlobal("window", {
      __PUBLIC_ENV__: {
        NEXT_PUBLIC_SUPABASE_URL: projectUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: pair.public,
      },
    });
    const { createClient, prepareRealtimeAuthentication } = await import("./browser");
    const client = createClient();
    clients.push(client);
    expect((await client.from("organizations").select("id")).error).toBeNull();
    expect(requests[0]?.url.origin).toBe(projectUrl);
    expect(requests[0]?.headers.get("apikey")).toBe(pair.public);
    await prepareRealtimeAuthentication();
    const channel = client.channel("tenant-fixture", { config: { private: true } });
    await new Promise<void>((resolve, reject) =>
      channel.subscribe((state: string) => {
        if (state === "SUBSCRIBED") resolve();
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") reject(new Error(state));
      }),
    );
    expect(new URL(socketUrls[0]!).searchParams.get("apikey")).toBe(pair.public);
    const join = socketFrames.find((frame) => frame[3] === "phx_join");
    expect(join?.[4]).toMatchObject({ access_token: userToken, config: { private: true } });
    expect(JSON.stringify(socketFrames)).not.toContain(pair.secret);
  });
});
