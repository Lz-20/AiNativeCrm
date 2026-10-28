/* eslint-disable @typescript-eslint/no-require-imports -- CLI CommonJS sem dependências no standalone. */
"use strict";

// App/worker -> linhas completas -> stdout/stderr do Docker. Nunca emite um
// prefixo antes de conhecer a linha inteira: um token pode atravessar chunks.
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const { Transform } = require("node:stream");

const MASK = "[REDACTED]";
const MAX_LINE_BYTES = 64 * 1024;
const DROPPED = '{"level":"warn","event":"log_line_dropped","reason":"size_limit"}\n';
const FIELD = "(?:authorization|proxy[_-]?authorization|cookies?|set[_-]?cookie|x[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|x[_-]?amz[_-]?security[_-]?token|password|secret|token|signed[_-]?url|raw[_-]?headers)";
const SENSITIVE_FIELD = new RegExp(`^${FIELD}$`, "i");
const BLOCK_MASK = '{"event":"sensitive_log_value_redacted"}';

function secretPattern(env) {
  const values = new Set();
  function add(value) {
    if (typeof value !== "string" || value.length === 0) return;
    values.add(value);
    values.add(JSON.stringify(value).slice(1, -1));
    values.add(encodeURIComponent(value));
    for (const line of value.split(/\r?\n/)) if (line) values.add(line);
  }
  function strings(value) {
    if (typeof value === "string") add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(strings);
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (/secret|password|passwd|token|(?:^|_)key(?:s|_|$)|credential|authorization|cookie|private/i.test(name)) {
      add(value);
      // JWKS inclui componentes privados separados: mensagens de bibliotecas
      // podem imprimir só um componente, em vez do JSON original.
      try { strings(JSON.parse(value)); } catch { /* string simples */ }
    }
    try {
      const url = new URL(value);
      if (url.username || url.password) {
        add(value);
        add(url.password);
        try { add(decodeURIComponent(url.password)); } catch { /* URL inválida */ }
      }
    } catch { /* não é uma URL */ }
  }
  const escaped = [...values].sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.length ? new RegExp(escaped.join("|"), "g") : null;
}

let knownSecrets;
try { knownSecrets = secretPattern(process.env); }
catch {
  // Até uma falha de compilação da RegExp pode incluir o padrão (os segredos)
  // no erro. Falha fechada antes de criar o filho, com mensagem fixa.
  process.stderr.write('{"level":"error","event":"runtime_redaction_configuration_invalid"}\n');
  process.exit(78);
}
function redact(line) {
  // JSON estruturado: array/objeto de cookies é um valor secreto inteiro, não
  // apenas a primeira string. Reviver também cobre accessToken/refreshToken.
  try { line = JSON.stringify(JSON.parse(line, (key, value) => SENSITIVE_FIELD.test(key) ? MASK : value)); }
  catch { /* texto e util.inspect seguem pelos padrões abaixo */ }
  if (knownSecrets) line = line.replace(knownSecrets, MASK);
  // Tokens de sessão/URL assinada podem nascer depois do boot e não existir no
  // env. Remove o valor inteiro de campos conhecidos, inclusive cookies JSON.
  line = line.replace(new RegExp(`("${FIELD}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"), `$1"${MASK}"`);
  line = line.replace(/\b(?:https?|postgres(?:ql)?|redis(?:s)?):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi,
    (value) => `${value.slice(0, value.indexOf("://") + 3)}${MASK}@`);
  line = line.replace(/\bBearer\s+[^\s"',;}]+/gi, `Bearer ${MASK}`);
  line = line.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MASK);
  line = line.replace(/\b(?:sb_secret_|sk_(?:live|test)_|sk-)[A-Za-z0-9_-]{8,}\b/g, MASK);
  line = line.replace(/([?&](?:token|access_token|refresh_token|api[_-]?key|signature|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^\s&"'<>]*/gi, `$1${MASK}`);
  line = line.replace(new RegExp(`((?:^|[\\s{,])['"]?${FIELD}['"]?\\s*(?:=>|:|=)\\s*)(?!"\\[REDACTED\\]")[^\\r\\n]*`, "gi"), `$1${MASK}`);
  return line;
}

// Mantém contexto de arrays/objetos/strings de util.inspect entre LINHAS, além
// do buffering entre chunks. O scanner usa o original, nunca o texto redigido.
function scanValue(text, state = { stack: [], quote: null, escaped: false }) {
  if (state.invalid) return state;
  let input = state.quote || state.stack.length ? text : text.trimStart();
  if (!state.quote && !state.stack.length) {
    // Prefixos reais de util.inspect: [Object: null prototype] { ... },
    // Map(1) { ... }, SessionBag { ... }, Uint8Array(3) [ ... ].
    input = input.replace(/^\[[A-Za-z][^\]\r\n]{0,100}\]\s*(?=[{[]|$)/, "");
    if (input && !/^[{['"`]/.test(input)) {
      const start = input.search(/[{[]/);
      if (start !== -1) input = input.slice(start);
    }
  }
  if (!input) return state;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (state.quote) {
      if (state.escaped) state.escaped = false;
      else if (char === "\\") state.escaped = true;
      else if (char === state.quote) {
        state.quote = null;
        if (!state.stack.length) return input.slice(i + 1).trim().startsWith("+") ? { stack: [], quote: null, escaped: false } : null;
      }
    } else if (char === '"' || char === "'" || char === "`") state.quote = char;
    else if (char === "[" || char === "{") state.stack.push(char);
    else if (char === "]" || char === "}") {
      const open = state.stack.at(-1);
      if (!open || (open === "[" && char !== "]") || (open === "{" && char !== "}")) {
        state.invalid = true;
        return state; // estrutura inválida: permanece fechado até o EOF.
      }
      state.stack.pop();
      if (!state.stack.length) return null;
    } else if (!state.stack.length && !/\s/.test(char)) return null;
  }
  return state.stack.length || state.quote ? state : null;
}

function logStream() {
  let parts = [], size = 0, dropping = false, sensitiveValue = null, droppedTail = "";
  function updateContext(line) {
    if (sensitiveValue) sensitiveValue = scanValue(line, sensitiveValue);
    if (sensitiveValue) return;
    const fields = new RegExp(`(?:^|[\\s{,])['"]?${FIELD}['"]?\\s*(?:=>|:|=)\\s*`, "gi");
    for (const match of line.matchAll(fields)) {
      const state = scanValue(line.slice(match.index + match[0].length));
      if (state) { sensitiveValue = state; break; }
    }
  }
  function redactLine(line) {
    const continuing = !!sensitiveValue;
    updateContext(line);
    return continuing ? BLOCK_MASK : redact(line);
  }
  function scanDropped(text) {
    // Continua reconhecendo contexto no trecho DESCARTADO, sem armazenar a
    // linha inteira. A janela curta reconhece também um nome de campo que cruza
    // o limite dos chunks. Com valor já aberto, nenhum byte é reprocessado.
    updateContext(sensitiveValue ? text : droppedTail + text);
    droppedTail = (droppedTail + text).slice(-256);
  }
  function append(part) {
    if (dropping) { scanDropped(part.toString("utf8")); return; }
    size += part.length;
    if (size > MAX_LINE_BYTES) {
      // Classifica TODOS os bytes, inclusive o part que ultrapassou o teto.
      // Nenhum deles chega ao Docker; só o contexto atravessa a próxima linha.
      scanDropped(Buffer.concat(parts).toString("utf8"));
      scanDropped(part.toString("utf8"));
      parts = []; dropping = true;
    }
    else parts.push(part);
  }
  function emit(stream) {
    if (dropping) stream.push(DROPPED);
    else stream.push(redactLine(Buffer.concat(parts, size).toString("utf8").replace(/\r$/, "")) + "\n");
    parts = []; size = 0; dropping = false; droppedTail = "";
  }
  return new Transform({
    transform(chunk, _encoding, done) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        append(chunk.subarray(start, end));
        emit(this);
        start = end + 1;
      }
      if (start < chunk.length) append(chunk.subarray(start));
      done();
    },
    flush(done) { if (size || dropping) emit(this); done(); },
  });
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (!args.length) {
  process.stderr.write('{"level":"error","event":"runtime_command_missing"}\n');
  process.exitCode = 64;
} else {
  const child = spawn(args[0], args.slice(1), { stdio: ["inherit", "pipe", "pipe"], shell: false });
  child.stdout.pipe(logStream()).pipe(process.stdout, { end: false });
  child.stderr.pipe(logStream()).pipe(process.stderr, { end: false });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    // Não imprime erro.message: pode incluir argumentos, paths ou segredos.
    process.stderr.write('{"level":"error","event":"runtime_spawn_failed"}\n');
    process.exitCode = 127;
  });
  child.on("close", (code, signal) => {
    if (process.exitCode !== 127) process.exitCode = code ?? (128 + (constants.signals[signal] || 1));
  });
}
