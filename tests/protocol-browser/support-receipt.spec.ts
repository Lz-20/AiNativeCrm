import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";
import ts from "typescript";
import { mutationLifecycle } from "../e2e/helpers/mutation-lifecycle";

let server: Server, origin: string, writes: number;
let completeBodies: Array<() => void>;
const finishBodies = () => completeBodies.splice(0).forEach((finish) => finish());
const compiled = ts.transpileModule(readFileSync("lib/impersonate/end-support.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
test.beforeEach(async () => {
  writes = 0;
  completeBodies = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST") {
      writes++;
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      completeBodies.push(() => {
        if (url.searchParams.has("fail")) res.destroy();
        else res.end(JSON.stringify({ data: { ended: true, redirect_url: "/app/inbox" } }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      url.pathname === "/done"
        ? "<h1>done</h1>"
        : `<button id="end">end</button><output></output>
      <script>const exports={};${compiled}
      document.querySelector('button').onclick=async()=>{try{
        ${url.searchParams.has("old") ? "await fetch('/end',{method:'POST'})" : "await exports.endSupportRequest((path,init)=>fetch('/end'+location.search,init))"};
        location.assign('/done');
      }catch(e){document.querySelector('output').textContent='unknown';}};</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("reproduces the old header-only redirect with a server-completed but client-unknown write", async ({
  page,
}) => {
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(page.context());
  await page.goto(origin + "/?old=1");
  await page.click("button");
  await page.waitForURL(origin + "/done");
  await expect.poll(() => tracker.pending.size).toBe(1);
  // Navigation need not emit requestfailed (the original Trace also had no
  // failure text). Headers + missing completion are already an unknown write.
  expect(tracker.describe()[0]?.response_headers_status).toBe(200);
  expect(writes).toBe(1);
  expect(tracker.describe()[0]?.path).toBe("/end");
  finishBodies();
});
test("actual helper waits for a delayed body, then cleanup reaches zero without erasing a request", async ({
  page,
}) => {
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(page.context());
  await page.goto(origin);
  const headers = page.waitForResponse((response) => response.request().method() === "POST");
  await page.click("button");
  await headers;
  expect(page.url()).toBe(origin + "/");
  expect(tracker.pending.size).toBe(1);
  finishBodies();
  await page.waitForURL(origin + "/done");
  await expect.poll(() => tracker.pending.size).toBe(0);
  expect(writes).toBe(1);
});
test("failed body is unknown, does not navigate or auto retry, and prevents cleanup", async ({
  page,
}) => {
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(page.context());
  await page.goto(origin + "/?fail=1");
  const headers = page.waitForResponse((response) => response.request().method() === "POST");
  await page.click("button");
  await headers;
  finishBodies();
  await expect(page.locator("output")).toHaveText("unknown");
  expect(tracker.pending.size).toBe(1);
  expect(writes).toBe(1);
  expect(tracker.describe()[0]?.outcome).toBe("failed_after_send_unknown");
});
test("closing a page after send retains the unknown write", async ({ page }) => {
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(page.context());
  await page.goto(origin);
  const headers = page.waitForResponse((response) => response.request().method() === "POST");
  await page.click("button");
  await headers;
  await page.close();
  expect(tracker.pending.size).toBe(1);
  expect(writes).toBe(1);
  finishBodies();
});
test("concurrent freeze intercepts new writes before send but does not discard already-sent writes", async ({
  page,
}) => {
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(page.context());
  await page.goto(origin);
  await Promise.all([tracker.freeze([page.context()]), tracker.freeze([page.context()])]);
  await page.click("button");
  await expect(page.locator("output")).toHaveText("unknown");
  expect(writes).toBe(0);
  expect(tracker.pending.size).toBe(0);
});

test("concurrent cleanup cannot erase a write already sent before interception", async ({
  page,
}) => {
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(page.context());
  await page.goto(origin);
  const headers = page.waitForResponse((response) => response.request().method() === "POST");
  await page.click("button");
  await headers;
  await Promise.all([tracker.freeze([page.context()]), tracker.freeze([page.context()])]);
  expect(tracker.pending.size).toBe(1);
  expect(writes).toBe(1);
  finishBodies();
  await page.waitForURL(origin + "/done");
  await expect.poll(() => tracker.pending.size).toBe(0);
});

test("destroying a browser context after headers does not prove server rollback", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tracker = mutationLifecycle((request) => request.method() === "POST");
  tracker.observe(context);
  const page = await context.newPage();
  await page.goto(origin);
  const headers = page.waitForResponse((response) => response.request().method() === "POST");
  await page.click("button");
  await headers;
  await context.close();
  expect(tracker.pending.size).toBe(1);
  expect(writes).toBe(1);
  finishBodies();
});
