import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";

const root = fileURLToPath(new URL("../examples/chat-first-demo/dist/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const file = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": (types[extname(file)] ?? "application/octet-stream") + "; charset=utf-8",
      "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
}).listen(3008, "127.0.0.1", () => console.info("Agent demo: http://127.0.0.1:3008/#/app/ai/workbench"));
