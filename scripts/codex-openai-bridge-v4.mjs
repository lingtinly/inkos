#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const HOST = '127.0.0.1';
const PORT = +(process.env.INKOS_CODEX_BRIDGE_PORT || 43127);
const TIMEOUT = +(process.env.INKOS_CODEX_TIMEOUT_MS || 300000);
const DEF_MODEL = process.env.INKOS_CODEX_MODEL || 'gpt-5.6-terra';
const BIN = process.env.INKOS_CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const MODELS = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna'];
const APP_SERVER = process.env.INKOS_CODEX_APP_SERVER !== '0';
const BASE_INSTRUCTIONS = [
  'You are a text-generation backend embedded in InkOS.',
  'Your job is writing, planning, editing, summarizing, and other text-only creative work.',
  'Do not inspect files, run shell commands, browse, call tools, edit files, or perform coding-agent work.',
  'Follow the supplied developer instructions and conversation context.',
  'Return only the assistant text requested by the user.'
].join(' ');
const effort = (model) => process.env.INKOS_CODEX_REASONING_EFFORT || (model.includes('sol') ? 'low' : 'none');
const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
const now = () => Date.now();

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  appServerRequests: 0,
  execFallbackRequests: 0,
  appServerFailures: 0,
  appServerPrewarm: 'pending',
  lastAppServerError: null,
  lastAppServerStderr: null,
  last: null
};

class BridgeError extends Error {
  constructor(message, code = 'bridge_error', status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function json(res, status, value) {
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new BridgeError('Request too large', 'request_too_large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BridgeError('Invalid JSON', 'invalid_json', 400);
  }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : (part?.text || part?.content || '')).filter(Boolean).join('\n');
}

function parseMessages(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw new BridgeError('messages required', 'invalid_messages', 400);
  }
  return body.messages
    .map((m) => ({ role: m?.role || 'user', content: textContent(m?.content) }))
    .filter((m) => m.content.trim());
}

function splitContext(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const conversation = messages.filter((m) => m.role !== 'system');
  return {
    system,
    prompt: `CONVERSATION:\n${conversation.map((m, i) => `[${m.role} ${i + 1}]\n${m.content}`).join('\n\n')}\n\nReturn only the next assistant response.`
  };
}

class AppServer {
  constructor() {
    this.child = null;
    this.ready = null;
    this.id = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.byTurn = new Map();
    this.stderr = '';
  }

  async start() {
    if (this.ready && this.child?.exitCode === null) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  async _start() {
    this.stderr = '';
    const child = spawn(BIN, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, NO_COLOR: '1' }
    });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-16000);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.fail(new BridgeError(
        `app-server exited ${code ?? '?'}${signal ? '/' + signal : ''}: ${compact(this.stderr)}`,
        'app_server_exited',
        503
      ));
    });
    child.on('error', (e) => {
      this.fail(new BridgeError(`app-server start failed: ${e.message}`, 'app_server_start_failed', 503));
    });

    const initialized = await this.request('initialize', {
      clientInfo: { name: 'inkos_codex_bridge', title: 'InkOS Codex Bridge', version: '0.4.0' },
      capabilities: { experimentalApi: true }
    }, 20000);
    this.notify('initialized');
    return initialized;
  }

  request(method, params = {}, timeout = TIMEOUT) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new BridgeError('app-server unavailable', 'app_server_unavailable', 503));
    }
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`${method} timed out`, 'app_server_timeout', 504));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
    });
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new BridgeError(msg.error.message || JSON.stringify(msg.error), 'app_server_rpc', 502));
      else pending.resolve(msg.result);
      return;
    }

    const params = msg.params || {};
    let threadId = params.threadId || params.thread?.id;
    if (!threadId && msg.method === 'turn/completed' && params.turn?.id) {
      threadId = this.byTurn.get(params.turn.id);
    }
    const state = threadId && this.turns.get(threadId);
    if (!state) return;

    if (msg.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      state.text += params.delta;
      state.delta?.(params.delta);
      return;
    }
    if (msg.method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      state.final = params.item.text;
      return;
    }
    if (msg.method === 'error') {
      state.error = params.error?.message || params.message || 'Codex error';
      return;
    }
    if (msg.method === 'turn/completed') {
      const turn = params.turn || {};
      this.turns.delete(threadId);
      if (turn.id) this.byTurn.delete(turn.id);
      clearTimeout(state.timer);
      if (turn.status === 'completed') {
        state.resolve((state.final || state.text || turn.items?.find?.((x) => x.type === 'agentMessage')?.text || '').trim());
      } else {
        state.reject(new BridgeError(turn.error?.message || state.error || `turn ${turn.status}`, 'turn_failed', 502));
      }
    }
  }

  async generate(model, context, onDelta, signal) {
    await this.start();
    const cwd = await mkdtemp(join(tmpdir(), 'inkos-codex-text-'));
    let threadId;
    let turnId;
    try {
      // Use only stable thread/start fields here. Earlier bridge versions added
      // experimental environment/tool fields; some Windows CLI builds reject
      // those combinations before a turn begins.
      const started = await this.request('thread/start', {
        model,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'readOnly',
        ephemeral: true,
        baseInstructions: BASE_INSTRUCTIONS,
        developerInstructions: context.system || 'Produce the requested text only.'
      }, 30000);

      threadId = started?.thread?.id;
      if (!threadId) throw new BridgeError('No thread id returned by app-server', 'bad_thread', 502);

      const output = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.turns.delete(threadId);
          reject(new BridgeError('Codex turn timed out', 'codex_timeout', 504));
        }, TIMEOUT);
        this.turns.set(threadId, {
          resolve,
          reject,
          timer,
          text: '',
          final: '',
          error: '',
          delta: onDelta
        });
      });

      const abort = () => {
        if (threadId && turnId) {
          this.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => {});
        }
      };
      if (signal?.aborted) throw new BridgeError('Request aborted', 'request_aborted', 499);
      signal?.addEventListener('abort', abort, { once: true });

      try {
        const turn = await this.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: context.prompt }],
          model,
          effort: effort(model)
        }, 30000);
        turnId = turn?.turn?.id;
        if (turnId) this.byTurn.set(turnId, threadId);
        return await output;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const state of this.turns.values()) {
      clearTimeout(state.timer);
      state.reject(error);
    }
    this.turns.clear();
    this.byTurn.clear();
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

const app = new AppServer();
let consecutiveAppFailures = 0;

function spawnExec(args, input, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, NO_COLOR: '1' }
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new BridgeError('Codex exec timed out', 'codex_timeout', 504));
    }, TIMEOUT);
    const abort = () => {
      child.kill();
      finish(reject, new BridgeError('Request aborted', 'request_aborted', 499));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-131072); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-131072); });
    child.on('error', (e) => finish(reject, new BridgeError(e.message, 'codex_not_available', 503)));
    child.on('close', (code) => code === 0
      ? finish(resolve, { stdout, stderr })
      : finish(reject, new BridgeError(`Codex exec failed ${code}: ${compact(stderr)}`, 'codex_failed', 502)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function execFallback(model, context, onDelta, signal) {
  const cwd = await mkdtemp(join(tmpdir(), 'inkos-codex-exec-'));
  const outputFile = join(cwd, 'last.txt');
  try {
    const prompt = [
      BASE_INSTRUCTIONS,
      context.system ? `DEVELOPER INSTRUCTIONS:\n${context.system}` : '',
      context.prompt
    ].filter(Boolean).join('\n\n');
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--color', 'never',
      '--sandbox', 'read-only',
      '--output-last-message', outputFile,
      '--model', model,
      '-c', `model_reasoning_effort="${effort(model)}"`,
      '-'
    ];
    const result = await spawnExec(args, prompt, cwd, signal);
    let text = '';
    try { text = (await readFile(outputFile, 'utf8')).trim(); }
    catch { text = result.stdout.trim(); }
    if (!text) throw new BridgeError(`No Codex output: ${compact(result.stderr)}`, 'empty_response', 502);
    onDelta?.(text);
    return text;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

async function generate(model, messages, onDelta, signal) {
  const context = splitContext(messages);
  if (APP_SERVER) {
    try {
      const text = await app.generate(model, context, onDelta, signal);
      consecutiveAppFailures = 0;
      stats.appServerRequests++;
      stats.lastAppServerError = null;
      stats.lastAppServerStderr = app.stderr ? compact(app.stderr) : null;
      return { text, transport: 'persistent-app-server', context };
    } catch (error) {
      consecutiveAppFailures++;
      stats.appServerFailures++;
      stats.lastAppServerError = compact(error?.message || error);
      stats.lastAppServerStderr = app.stderr ? compact(app.stderr) : null;
      console.warn(`[inkos-codex-bridge] app-server fallback: ${stats.lastAppServerError}`);
      if (stats.lastAppServerStderr) console.warn(`[inkos-codex-bridge] app-server stderr: ${stats.lastAppServerStderr}`);
      app.stop();
    }
  }

  stats.execFallbackRequests++;
  const text = await execFallback(model, context, onDelta, signal);
  return { text, transport: 'exec-fallback', context };
}

function streamStart(res, id, model, created) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
}

function streamDelta(res, id, model, created, text) {
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
}

function streamEnd(res, id, model, created) {
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function chat(req, res, body) {
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEF_MODEL;
  const messages = parseMessages(body);
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const started = now();
  let firstTokenAt = null;
  let outputChars = 0;
  const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  stats.requests++;

  const record = (transport, error) => {
    const ended = now();
    stats.last = {
      at: new Date().toISOString(),
      model,
      effort: effort(model),
      transport,
      inputMessages: messages.length,
      inputChars,
      outputChars,
      ttftMs: firstTokenAt ? firstTokenAt - started : null,
      totalMs: ended - started,
      error: error ? compact(error?.message || error) : null
    };
    console.log(`[inkos-codex-perf] model=${model} effort=${effort(model)} transport=${transport} input=${inputChars}ch output=${outputChars}ch ttft=${stats.last.ttftMs ?? '-'}ms total=${stats.last.totalMs}ms${error ? ' ERROR=' + stats.last.error : ''}`);
  };

  if (body.stream) {
    streamStart(res, id, model, created);
    let transport = 'unknown';
    try {
      const result = await generate(model, messages, (chunk) => {
        if (!firstTokenAt) firstTokenAt = now();
        outputChars += chunk.length;
        streamDelta(res, id, model, created, chunk);
      }, controller.signal);
      transport = result.transport;
      streamEnd(res, id, model, created);
      record(transport, null);
    } catch (error) {
      record(transport, error);
      if (!res.writableEnded) res.destroy(error);
    }
    return;
  }

  try {
    const result = await generate(model, messages, null, controller.signal);
    firstTokenAt = now();
    outputChars = result.text.length;
    json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
    record(result.transport, null);
  } catch (error) {
    record('unknown', error);
    throw error;
  }
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'GET' && (path === '/health' || path === '/v1/health')) {
    return json(res, 200, {
      ok: true,
      service: 'inkos-codex-bridge',
      bridgeVersion: 4,
      transport: APP_SERVER && app.child?.exitCode === null ? 'persistent-app-server' : 'exec-fallback',
      defaultModel: DEF_MODEL
    });
  }

  if (req.method === 'GET' && (path === '/diagnostics' || path === '/v1/diagnostics')) {
    return json(res, 200, {
      ok: true,
      service: 'inkos-codex-bridge',
      bridgeVersion: 4,
      defaultModel: DEF_MODEL,
      effortPolicy: 'Terra/Luna=none, Sol=low',
      appServerEnabled: APP_SERVER,
      appServerAlive: Boolean(app.child && app.child.exitCode === null),
      consecutiveAppFailures,
      models: MODELS,
      stats
    });
  }

  if (req.method === 'GET' && (path === '/models' || path === '/v1/models')) {
    return json(res, 200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'chatgpt-codex' }))
    });
  }

  if (req.method === 'POST' && (path === '/chat/completions' || path === '/v1/chat/completions')) {
    return chat(req, res, await readBody(req));
  }

  return json(res, 404, {
    error: { message: `Unsupported route: ${req.method} ${path}`, type: 'invalid_request_error', code: 'route_not_found' }
  });
}

async function check() {
  const started = now();
  const result = await generate(DEF_MODEL, [{ role: 'user', content: 'Reply with exactly CODEX_BRIDGE_OK' }], null);
  if (result.text.trim() !== 'CODEX_BRIDGE_OK') throw new Error('Unexpected: ' + compact(result.text));
  console.log(`CODEX_BRIDGE_OK transport=${result.transport} total=${now() - started}ms`);
}

if (process.argv.includes('--check')) {
  check()
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => app.stop());
} else {
  const server = http.createServer((req, res) => handler(req, res).catch((error) => {
    if (res.headersSent) return res.destroy(error);
    json(res, error.status || 500, {
      error: { message: error.message || String(error), type: 'codex_cli_error', code: error.code || 'bridge_error' }
    });
  }));

  server.listen(PORT, HOST, () => {
    console.log(`[inkos-codex-bridge] v4 listening on http://${HOST}:${PORT}/v1`);
    console.log(`[inkos-codex-bridge] default=${DEF_MODEL}; effort Terra/Luna=none Sol=low`);
    console.log(`[inkos-codex-bridge] diagnostics: http://${HOST}:${PORT}/diagnostics`);

    // Prewarm the long-lived app-server while the user opens Studio. This removes
    // process initialization from the first writing request and also makes
    // startup failures visible before the first prompt is sent.
    if (APP_SERVER) {
      app.start().then(() => {
        stats.appServerPrewarm = 'ready';
        stats.lastAppServerError = null;
        stats.lastAppServerStderr = app.stderr ? compact(app.stderr) : null;
        console.log('[inkos-codex-bridge] app-server prewarm: READY');
      }).catch((error) => {
        stats.appServerPrewarm = 'failed';
        stats.appServerFailures++;
        stats.lastAppServerError = compact(error?.message || error);
        stats.lastAppServerStderr = app.stderr ? compact(app.stderr) : null;
        console.warn(`[inkos-codex-bridge] app-server prewarm FAILED: ${stats.lastAppServerError}`);
        if (stats.lastAppServerStderr) console.warn(`[inkos-codex-bridge] app-server stderr: ${stats.lastAppServerStderr}`);
        app.stop();
      });
    } else {
      stats.appServerPrewarm = 'disabled';
    }
  });

  const stop = () => {
    app.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
