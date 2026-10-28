/* eslint-disable @typescript-eslint/no-require-imports -- Prova sem dependências de curl real. */
"use strict";
const { createServer } = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");

// Só recebe dados sintéticos de scheduler-entrypoint.test.sh. Nenhum body,
// header, stdout/stderr do curl ou credencial aparece na saída deste helper.
let [config, expected] = process.argv.slice(2);
// MSYS não converte automaticamente certos argumentos com apóstrofo.
// Só adapta o caminho de fixture no Windows; curl continua sendo o binário real.
if (process.platform === "win32" && !existsSync(config)) {
  try { config = execFileSync("cygpath", ["-w", config], { encoding: "utf8" }).trim(); }
  catch { process.exit(1); }
}
let matched = false;
const server = createServer((request, response) => {
  matched = `Authorization: ${request.headers.authorization}` === expected;
  response.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const curl = spawn("curl", ["--config", config, "-fsS", "--max-time", "5", "--proxy", "", `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  curl.on("error", () => { process.exitCode = 1; server.close(); });
  curl.on("close", (code) => { process.exitCode = code === 0 && matched ? 0 : 1; server.close(); });
});
server.on("error", () => { process.exitCode = 1; });
