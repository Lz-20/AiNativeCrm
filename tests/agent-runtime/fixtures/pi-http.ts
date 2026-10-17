import type { RuntimeModelBinding } from "@/lib/agent-runtime";
import { normalizeContext } from "@earendil-works/pi-ai";
import { resolvePiModel } from "@/lib/agent-runtime/pi/model-adapter";

/** Execute one Pi provider request so provider routing tests observe the real Pi adapter. */
export async function invokePiProvider(binding: RuntimeModelBinding): Promise<void> {
  const resolved = await resolvePiModel(binding);
  try {
    const stream = await resolved.streamFn(
      resolved.model,
      normalizeContext({ messages: [{ role: "user", content: "oi", timestamp: Date.now() }] }),
      undefined,
    );
    for await (const _event of stream) {
      // The test intercepts fetch; response parsing is not part of these assertions.
    }
  } catch {
    // A stubbed provider response is expected to terminate this probe.
  }
}
