import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient, prepareRealtimeAuthentication } from "@/lib/supabase/browser";

type Status = "connecting" | "subscribed" | "channel_error" | "timed_out" | "closed";
interface Listener {
  event: string;
  onMessage: (message: unknown) => void;
  onStatus: (status: Status) => void;
}
interface Subscription {
  listeners: Set<Listener>;
  channel: RealtimeChannel | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  attempts: number;
  status: Status;
}

// Broadcast uses the publisher's exact topic. A per-hook suffix makes delivery
// impossible; multiple consumers therefore share one channel and its lifecycle.
const subscriptions = new Map<string, Subscription>();
const removals = new Map<string, Promise<unknown>>();

export function subscribePrivateBroadcast(topic: string, listener: Listener): () => void {
  const existing = subscriptions.get(topic);
  if (existing) {
    existing.listeners.add(listener);
    listener.onStatus(existing.status);
    return () => release(topic, existing, listener);
  }
  const entry: Subscription = {
    listeners: new Set([listener]), channel: null, timer: null,
    stopped: false, attempts: 0, status: "connecting",
  };
  subscriptions.set(topic, entry);
  const client = createClient();
  const status = (value: Status) => {
    entry.status = value;
    for (const consumer of entry.listeners) consumer.onStatus(value);
  };
  const retry = () => {
    if (entry.stopped || entry.timer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** entry.attempts++);
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (entry.stopped) return;
      const old = entry.channel;
      entry.channel = null; // CLOSED during remove must not schedule another retry.
      if (old) await remove(topic, old);
      if (!entry.stopped) void mount();
    }, delay);
  };
  const mount = async () => {
    try {
      await removals.get(topic); // StrictMode unmount/remount must finish leaving first.
      await prepareRealtimeAuthentication();
      if (entry.stopped) return;
      const channel: RealtimeChannel = client.channel(topic, { config: { private: true } });
      entry.channel = channel;
      channel.on("broadcast", { event: "*" }, (message: { event: string; payload: unknown }) => {
        if (entry.stopped || entry.channel !== channel) return;
        for (const consumer of entry.listeners) {
          if (consumer.event === "*" || consumer.event === message.event) consumer.onMessage(message);
        }
      });
      channel.subscribe((value: string) => {
        if (entry.stopped || entry.channel !== channel) return;
        const mapped: Record<string, Status> = { SUBSCRIBED: "subscribed", CHANNEL_ERROR: "channel_error",
          TIMED_OUT: "timed_out", CLOSED: "closed" };
        status(mapped[value] ?? "connecting");
        if (value === "SUBSCRIBED") {
          if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
          if (entry.attempts > 0) {
            entry.attempts = 0;
            for (const consumer of entry.listeners) consumer.onMessage({ tipo: "reassinado" });
          }
        } else retry();
      });
    } catch {
      if (entry.stopped) return;
      status("channel_error"); retry();
    }
  };
  status("connecting");
  void mount();
  return () => release(topic, entry, listener);
}

function remove(topic: string, channel: RealtimeChannel): Promise<unknown> {
  const operation = Promise.resolve(createClient().removeChannel(channel)).catch(() => undefined);
  removals.set(topic, operation);
  void operation.then(() => { if (removals.get(topic) === operation) removals.delete(topic); });
  return operation;
}

function release(topic: string, entry: Subscription, listener: Listener): void {
  entry.listeners.delete(listener);
  if (entry.listeners.size > 0) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  if (subscriptions.get(topic) === entry) subscriptions.delete(topic);
  const channel = entry.channel;
  entry.channel = null;
  if (channel) void remove(topic, channel);
}
