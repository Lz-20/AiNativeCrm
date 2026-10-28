import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ prepare: vi.fn(), channel: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: mock.prepare,
  createClient: () => ({ channel: mock.channel, removeChannel: mock.remove }),
}));
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

type Canal = { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>;
  message?: (p: unknown) => void; state?: (s: string) => void };
let canais: Canal[];
beforeEach(() => {
  vi.clearAllMocks(); canais = []; mock.prepare.mockResolvedValue(undefined);
  mock.channel.mockImplementation(() => {
    const canal: Canal = { on: vi.fn(), subscribe: vi.fn() };
    canal.on.mockImplementation((_kind, _filter, fn) => { canal.message = fn; return canal; });
    canal.subscribe.mockImplementation((fn) => { canal.state = fn; return canal; });
    canais.push(canal); return canal;
  });
  mock.remove.mockImplementation(async (canal: Canal) => { canal.state?.("CLOSED"); return "ok"; });
});
afterEach(() => vi.useRealTimers());

it("usa o topic exato do servidor, privado, compartilhado entre consumidores", async () => {
  const primeira = vi.fn(); const segunda = vi.fn();
  const a = renderHook(() => useRealtimeChannel({ name: "org:fixture:queue", broadcast: { event: "handoff_pending" }, onChange: primeira }));
  const b = renderHook(() => useRealtimeChannel({ name: "org:fixture:queue", broadcast: { event: "*" }, onChange: segunda }));
  await act(async () => {});
  expect(mock.channel).toHaveBeenCalledTimes(1);
  expect(mock.channel).toHaveBeenCalledWith("org:fixture:queue", { config: { private: true } });
  await act(async () => canais[0]?.state?.("SUBSCRIBED"));
  const event = { event: "handoff_pending", payload: {} };
  await act(async () => canais[0]?.message?.(event));
  expect(primeira).toHaveBeenCalledWith(event); expect(segunda).toHaveBeenCalledWith(event);
  a.unmount(); expect(mock.remove).not.toHaveBeenCalled();
  await act(async () => canais[0]?.message?.({ event: "other", payload: {} }));
  expect(primeira).toHaveBeenCalledTimes(1); expect(segunda).toHaveBeenCalledTimes(2);
  b.unmount(); expect(mock.remove).toHaveBeenCalledTimes(1);
});

it("retoma no MESMO topic, ignora CLOSED da remoção e pede refetch após o intervalo", async () => {
  vi.useFakeTimers(); const change = vi.fn();
  const hook = renderHook(() => useRealtimeChannel({ name: "alerts-platform", broadcast: { event: "*" }, onChange: change }));
  await act(async () => {});
  await act(async () => canais[0]?.state?.("CHANNEL_ERROR"));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mock.channel).toHaveBeenCalledTimes(2);
  expect(mock.channel.mock.calls.map((c) => c[0])).toEqual(["alerts-platform", "alerts-platform"]);
  await act(async () => canais[1]?.state?.("SUBSCRIBED"));
  expect(change).toHaveBeenCalledWith({ tipo: "reassinado" });
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mock.channel).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it("falha de autenticação não cria canal e desmontagem cancela a tentativa", async () => {
  vi.useFakeTimers(); mock.prepare.mockRejectedValue(new Error("sem sessão"));
  const hook = renderHook(() => useRealtimeChannel({ name: "alerts-platform", broadcast: { event: "*" }, onChange: vi.fn() }));
  await act(async () => {});
  expect(mock.channel).not.toHaveBeenCalled(); expect(hook.result.current.status).toBe("channel_error");
  hook.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mock.channel).not.toHaveBeenCalled();
});
