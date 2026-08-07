#!/usr/bin/env node

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = process.env.INKOS_CODEX_BRIDGE_HOST?.trim() || "127.0.0.1";
const PORT = parsePositiveInt(process.env.INKOS_CODEX_BRIDGE_PORT, 43127);
const TIMEOUT_MS = parsePositiveInt(process.env.INKOS_CODEX_TIMEOUT_MS, 300_000);
const MAX_BODY_BYTES = parsePositiveInt(process.env.INKOS_CODEX_MAX_BODY_BYTES, 4 * 1024 * 1024);
const DEFAULT_MODEL = process.env.INKOS_CODEX_MODEL?.trim() || "gpt-5.6-sol";
const CODEX_BIN = process.env.INKOS_CODEX_BIN?.trim() || (process.platform === "win32" ? "codex.cmd" : "codex");
const MODEL_IDS = parseModelIds(process.env.INKOS_CODEX_MODELS, DEFAULT_MODEL);

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseModelIds(raw, defaultModel) {
  const values = (raw ?? "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(defaultModel)) values.unshift(defaultModel);
  return [...new Set(values)];
}

function isSafeModelId(model) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model);
}

function resolveModel(requested) {
  const model = typeof requested === "string" && requested.trim() ? requested.trim() : DEFAULT_MODEL;
  if (!isSafeModelId(model)) {
    throw new BridgeError("Invalid model id", "invalid_model", 400);
  }
  return model;
}

class BridgeError extends Error {
  constructor(message, code = "bridge_error", status = 500) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

function openAiError(error) {
  const status = error instanceof BridgeError ? error.status : 500;
  const code = error instanceof BridgeError ? error.code : "codex_cli_error";
  const message = error instanceof Error ? error.message : String(error);
  return {
    status,
    body: {
      error: {
        message,
        type: "codex_cli_error",
        code,
      },
    },
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new BridgeError(`Request body exceeds ${MAX_BODY_BYTES} bytes`, "request_too_large", 413);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError("Request body is not valid JSON", "invalid_json", 400);
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BridgeError("messages must be a non-empty array", "invalid_messages", 400);
  }
  return messages
    .map((message) => ({
      role: typeof message?.role === "string" ? message.role : "user",
      content: textFromContent(message?.content),
    }))
    .filter((message) => message.content.trim().length > 0);
}

function normalizeResponsesInput(body) {
  const messages = [];
  if (typeof body?.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body?.input;
  if (typeof input === "string" && input.trim()) {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const content = textFromContent(item?.content);
      if (content.trim()) {
        messages.push({
          role: typeof item?.role === "string" ? item.role : "user",
          content,
        });
      }
    }
  }
  if (messages.length === 0) {
    throw new BridgeError("input must contain text", "invalid_input", 400);
  }
  return messages;
}

function renderPrompt(messages) {
  const system = messages.filter((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  const sections = [
    "You are being used as a text-generation backend for InkOS.",
    "Do not inspect files, run shell commands, browse the web, edit the workspace, or discuss this bridge unless the user explicitly asks for those actions.",
    "For ordinary writing requests, answer directly with the requested final text and no wrapper commentary.",
  ];

  if (system.length > 0) {
    sections.push(
      "SYSTEM INSTRUCTIONS:",
      system.map((message, index) => `[system ${index + 1}]\n${message.content}`).join("\n\n"),
    );
  }

  sections.push(
    "CONVERSATION:",
    conversation
      .map((message, index) => `[${message.role} ${index + 1}]\n${message.content}`)
      .join("\n\n"),
    "Return only the assistant response that should follow this conversation.",
  );

  return sections.join("\n\n");
}

async function runCodex({ model, messages, signal }) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "inkos-codex-bridge-"));
  const outputPath = join(workspaceDir, "last-message.txt");
  const prompt = renderPrompt(messages);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
    "--model",
    model,
    "-",
  ];

  try {
    const result = await spawnCodex(args, prompt, workspaceDir, signal);
    let content = "";
    try {
      content = (await readFile(outputPath, "utf8")).trim();
    } catch {
      content = result.stdout.trim();
    }
    if (!content) {
      throw new BridgeError(
        `Codex returned no final message.${result.stderr ? ` stderr: ${truncate(result.stderr)}` : ""}`,
        "empty_codex_response",
        502,
      );
    }
    return content;
  } finally {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnCodex(args, prompt, cwd, externalSignal) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
      fn(value);
    };

    const terminate = () => {
      if (!child.killed) child.kill();
    };

    const timeout = setTimeout(() => {
      terminate();
      finish(reject, new BridgeError(`Codex timed out after ${TIMEOUT_MS} ms`, "codex_timeout", 504));
    }, TIMEOUT_MS);

    const onAbort = () => {
      terminate();
      finish(reject, new BridgeError("Request aborted", "request_aborted", 499));
    };

    if (externalSignal?.aborted) {
      onAbort();
      return;
    }
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      const detail = error?.code === "ENOENT"
        ? `Codex CLI was not found (${CODEX_BIN}). Install Codex and sign in with ChatGPT first.`
        : `Failed to start Codex CLI: ${error.message}`;
      finish(reject, new BridgeError(detail, "codex_not_available", 503));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const suffix = stderr.trim() || stdout.trim();
      finish(
        reject,
        new BridgeError(
          `Codex exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${suffix ? `: ${truncate(suffix)}` : ""}`,
          "codex_failed",
          502,
        ),
      );
    });

    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

function appendBounded(current, next, limit = 64 * 1024) {
  const combined = current + next;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function truncate(text, limit = 2000) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function writeChatStream(res, { id, created, model, content }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
  })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function writeResponsesStream(res, { id, created, model, content }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: content,
  })}\n\n`);
  res.end(`event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: {
      id,
      object: "response",
      created_at: created,
      model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  })}\n\n`);
}

async function handleChatCompletions(req, res, body) {
  const model = resolveModel(body?.model);
  const messages = normalizeChatMessages(body?.messages);
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  const content = await runCodex({ model, messages, signal: controller.signal });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body?.stream === true) {
    writeChatStream(res, { id, created, model, content });
    return;
  }

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function handleResponses(req, res, body) {
  const model = resolveModel(body?.model);
  const messages = normalizeResponsesInput(body);
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  const content = await runCodex({ model, messages, signal: controller.signal });
  const id = `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body?.stream === true) {
    writeResponsesStream(res, { id, created, model, content });
    return;
  }

  sendJson(res, 200, {
    id,
    object: "response",
    created_at: created,
    model,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: content }],
    }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
}

async function requestHandler(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
    sendJson(res, 200, {
      ok: true,
      service: "inkos-codex-bridge",
      default_model: DEFAULT_MODEL,
      models: MODEL_IDS,
    });
    return;
  }

  if (req.method === "GET" && (path === "/models" || path === "/v1/models")) {
    sendJson(res, 200, {
      object: "list",
      data: MODEL_IDS.map((id) => ({ id, object: "model", owned_by: "chatgpt-codex" })),
    });
    return;
  }

  if (req.method === "POST" && (path === "/chat/completions" || path === "/v1/chat/completions")) {
    await handleChatCompletions(req, res, await readJsonBody(req));
    return;
  }

  if (req.method === "POST" && (path === "/responses" || path === "/v1/responses")) {
    await handleResponses(req, res, await readJsonBody(req));
    return;
  }

  sendJson(res, 404, {
    error: {
      message: `Unsupported route: ${req.method ?? "UNKNOWN"} ${path}`,
      type: "invalid_request_error",
      code: "route_not_found",
    },
  });
}

async function runCheck() {
  const content = await runCodex({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: "Reply with exactly CODEX_BRIDGE_OK" }],
  });
  if (content.trim() !== "CODEX_BRIDGE_OK") {
    throw new BridgeError(`Codex bridge check returned unexpected text: ${truncate(content)}`, "check_failed", 502);
  }
  console.log("CODEX_BRIDGE_OK");
}

if (process.argv.includes("--check")) {
  runCheck().catch((error) => {
    const { body } = openAiError(error);
    console.error(body.error.message);
    process.exitCode = 1;
  });
} else {
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const { status, body } = openAiError(error);
      sendJson(res, status, body);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[inkos-codex-bridge] listening on http://${HOST}:${PORT}/v1`);
    console.log(`[inkos-codex-bridge] default model: ${DEFAULT_MODEL}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
