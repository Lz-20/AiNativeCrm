/* eslint-disable @typescript-eslint/no-require-imports -- Prova Node sem dependências, executável na imagem ARM64. */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const wrapper = join(__dirname, "../../docker/redacted-runtime.cjs");
for (const [signal, businessCode, signalCode] of [["SIGTERM", 23, 143], ["SIGINT", 24, 130]]) {
  for (const handled of [true, false]) {
    test(`${signal}: ${handled ? "código do negócio e última linha" : "código de término por sinal"}`, {
      skip: process.platform === "win32", timeout: 5000,
    }, async (t) => {
      const code = `
        ${handled ? `process.on('${signal}',()=>{process.stdout.write('terminou\\n');process.exit(${businessCode});});` : ""}
        process.stdout.write('pronto\\n');setInterval(()=>{},1000);
      `;
      const child = spawn(process.execPath, [wrapper, "--", process.execPath, "-e", code], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
      let out = "", err = "", sent = false;
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (!sent && out.includes("pronto\n")) { sent = true; child.kill(signal); }
      });
      child.stderr.on("data", (chunk) => { err += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(sent, true);
      assert.equal(exitCode, handled ? businessCode : signalCode);
      assert.equal(out, handled ? "pronto\nterminou\n" : "pronto\n");
      assert.equal(err, "");
    });
  }
}
