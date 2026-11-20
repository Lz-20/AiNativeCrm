import type { BrowserContext, Request } from "@playwright/test";

/** Test-only safety boundary: failed-after-send is unknown, not quiescent. */
export function mutationLifecycle(mutates: (request: Request) => boolean) {
  const pending = new Set<Request>();
  const blocked = new WeakSet<Request>();
  const started = new Map<Request, string>();
  const headers = new Map<Request, number>();
  function observe(context: BrowserContext) {
    context.on("request", (request) => {
      if (mutates(request) && !blocked.has(request)) {
        pending.add(request);
        started.set(request, new Date().toISOString());
      }
    });
    context.on("response", (response) => {
      if (pending.has(response.request())) headers.set(response.request(), response.status());
    });
    context.on("requestfinished", (request) => {
      pending.delete(request);
      started.delete(request);
      headers.delete(request);
    });
    context.on("requestfailed", (request) => {
      if (blocked.has(request)) pending.delete(request);
    });
  }
  async function freeze(contexts: BrowserContext[]) {
    await Promise.all(
      contexts.map((context) =>
        context.route("**/*", async (route) => {
          const request = route.request();
          if (mutates(request)) {
            // Route interception is BEFORE transmission. This is the only aborted
            // request we can prove never reached the server.
            blocked.add(request);
            pending.delete(request);
            await route.abort("aborted");
          } else await route.continue();
        }),
      ),
    );
  }
  function describe() {
    return [...pending].map((request) => ({
      method: request.method(),
      path: new URL(request.url()).pathname,
      started_at: started.get(request),
      response_headers_status: headers.get(request),
      outcome: request.failure()
        ? "failed_after_send_unknown"
        : "body_or_server_completion_unknown",
    }));
  }
  return { pending, blocked, observe, freeze, describe };
}
