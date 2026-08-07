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
const FAST_TEXT_MODE = process.env.INKOS_CODEX_FAST_TEXT_MODE !== '0';
const BASE_INSTRUCTIONS = [
  'You are a text-generation backend embedded in InkOS.',
  'Your job is writing, planning, editing, summarizing, and other text-only creative work.',
  'Do not inspect files, run shell commands, browse, call tools, edit files, or perform coding-agent work.',
  'Follow the supplied developer instructions and conversation context.',
  'Return only the assistant text requested by the user.'
].join(' ');
const effort = (m) => process.env.INKOS_CODEX_REASONING_EFFORT || (m.includes('sol') ? 'low' : 'none');
const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
const now = () => Date.now();

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  appServerRequests: 0,
  execFallbackRequests: 0,
  appServerFailures: 0,
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
  const s = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store'
  });
  res.end(s);
}

async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 8 * 1024 * 1024) throw new BridgeError('Request too large', 'request_too_large', 413);
    chunks.push(c);
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
  return content.map((x) => typeof x === 'string' ? x : (x?.text || x?.content || '')).filter(Boolean).join('\n');
}

function parseMessages(b) {
  if (!Array.isArray(b?.messages) || !b.messages.length) throw new BridgeError('messages required', 'invalid_messages', 400);
  return b.messages
    .map((m) => ({ role: m?.role || 'user', content: textContent(m?.content) }))
    .filter((m) => m.content.trim());
}

function splitContext(ms) {
  const system = ms.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const conversation = ms.filter((m) => m.role !== 'system');
  const prompt = conversation.map((m, i) => `[${m.role} ${i + 1}]\n${m.content}`).join('\n\n');
  return {
    system,
    prompt: `CONVERSATION:\n${prompt}\n\nReturn only the next assistant response.`
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
    const child = spawn(BIN, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, NO_COLOR: '1' }
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.line(line));
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-12000); });
    child.on('exit', (code, sig) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.fail(new BridgeError(`app-server exited ${code ?? '?'}${sig ? '/' + sig : ''}: ${compact(this.stderr)}`, 'app_server_exited', 503));
    });
    child.on('error', (e) => this.fail(new BridgeError(`app-server start failed: ${e.message}`, 'app_server_start_failed', 503)));

    const init = await this.req('initialize', {
      clientInfo: { name: 'inkos_codex_bridge', title: 'InkOS Codex Bridge', version: '0.3.0' },
      capabilities: { experimentalApi: true }
    }, 20000);
    this.note('initialized');
    return init;
  }

  req(method, params = {}, ms = TIMEOUT) {
    if (!this.child?.stdin?.writable) return Promise.reject(new BridgeError('app-server unavailable', 'app_server_unavailable', 503));
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`${method} timed out`, 'app_server_timeout', 504));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
    });
  }

  note(method, params) {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }

  line(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new BridgeError(msg.error.message || 'RPC error', 'app_server_rpc', 502));
      else pending.resolve(msg.result);
      return;
    }

    const p = msg.params || {};
    let tid = p.threadId || p.thread?.id;
    if (!tid && msg.method === 'turn/completed' && p.turn?.id) tid = this.byTurn.get(p.turn.id);
    const state = tid && this.turns.get(tid);
    if (!state) return;

    if (msg.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      state.text += p.delta;
      state.delta?.(p.delta);
    } else if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
      state.final = p.item.text;
    } else if (msg.method === 'error') {
      state.err = p.error?.message || p.message || 'Codex error';
    } else if (msg.method === 'turn/completed') {
      const turn = p.turn || {};
      this.turns.delete(tid);
      if (turn.id) this.byTurn.delete(turn.id);
      clearTimeout(state.timer);
      if (turn.status === 'completed') {
        state.resolve((state.final || state.text || turn.items?.find?.((x) => x.type === 'agentMessage')?.text || '').trim());
      } else {
        state.reject(new BridgeError(turn.error?.message || state.err || `turn ${turn.status}`, 'turn_failed', 502));
      }
    }
  }

  async generate(model, context, delta, signal) {
    await this.start();
    const cwd = await mkdtemp(join(tmpdir(), 'inkos-codex-text-'));
    let tid;
    let turnId;
    try {
      const threadParams = {
        model,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'readOnly',
        ephemeral: true,
        baseInstructions: BASE_INSTRUCTIONS,
        developerInstructions: context.system || 'Produce the requested text only.'
      };
      if (FAST_TEXT_MODE) {
        threadParams.environments = [];
        threadParams.dynamicTools = [];
        threadParams.selectedCapabilityRoots = [];
      }
      const started = await this.req('thread/start', threadParams, 30000);
      tid = started?.thread?.id;
      if (!tid) throw new BridgeError('No thread id', 'bad_thread', 502);

      const output = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.turns.delete(tid);
          reject(new BridgeError('Codex turn timed out', 'codex_timeout', 504));
        }, TIMEOUT);
        this.turns.set(tid, { resolve, reject, timer, text: '', final: '', err: '', delta });
      });

      const abort = () => {
        if (tid && turnId) this.req('turn/interrupt', { threadId: tid, turnId }, 5000).catch(() => {});
      };
      if (signal?.aborted) throw new BridgeError('Request aborted', 'request_aborted', 499);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const turn = await this.req('turn/start', {
          threadId: tid,
          input: [{ type: 'text', text: context.prompt }],
          model,
          effort: effort(model),
          approvalPolicy: 'never'
        }, 30000);
        turnId = turn?.turn?.id;
        if (turnId) this.byTurn.set(turnId, tid);
        return await output;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const s of this.turns.values()) { clearTimeout(s.timer); s.reject(error); }
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

async function execFallback(model, context, delta, signal) {
  const cwd = await mkdtemp(join(tmpdir(), 'inkos-codex-exec-'));
  const out = join(cwd, 'last.txt');
  try {
    const prompt = [BASE_INSTRUCTIONS, context.system ? `DEVELOPER INSTRUCTIONS:\n${context.system}` : '', context.prompt].filter(Boolean).join('\n\n');
    const args = [
      'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--color', 'never', '--sandbox', 'read-only', '--output-last-message', out,
      '--model', model, '-c', `model_reasoning_effort="${effort(model)}"`, '-'
    ];
    const result = await spawnExec(args, prompt, cwd, signal);
    let text = '';
    try { text = (await readFile(out, 'utf8')).trim(); } catch { text = result.stdout.trim(); }
    if (!text) throw new BridgeError(`No Codex output: ${compact(result.stderr)}`, 'empty_response', 502);
    delta?.(text);
    return text;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

async function generate(model, ms, delta, signal) {
  const context = splitContext(ms);
  if (APP_SERVER) {
    try {
      const text = await app.generate(model, context, delta, signal);
      consecutiveAppFailures = 0;
      stats.appServerRequests++;
      return { text, transport: 'persistent-app-server', context };
    } catch (e) {
      consecutiveAppFailures++;
      stats.appServerFailures++;
      console.warn(`[inkos-codex-bridge] app-server fallback: ${compact(e.message || e)}`);
      app.stop();
    }
  }
  stats.execFallbackRequests++;
  const text = await execFallback(model, context, delta, signal);
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

async function chat(req, res, b) {
  const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : DEF_MODEL;
  const ms = parseMessages(b);
  const ctl = new AbortController();
  req.once('aborted', () => ctl.abort());
  const id = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const started = now();
  let firstTokenAt = null;
  let outputChars = 0;
  const promptChars = ms.reduce((n, m) => n + m.content.length, 0);
  stats.requests++;

  const record = (transport, error) => {
    const ended = now();
    stats.last = {
      at: new Date().toISOString(),
      model,
      effort: effort(model),
      transport,
      fastTextMode: FAST_TEXT_MODE,
      inputMessages: ms.length,
      inputChars: promptChars,
      outputChars,
      ttftMs: firstTokenAt ? firstTokenAt - started : null,
      totalMs: ended - started,
      error: error ? compact(error.message || error) : null
    };
    console.log(`[inkos-codex-perf] model=${model} effort=${effort(model)} transport=${transport} input=${promptChars}ch output=${outputChars}ch ttft=${stats.last.ttftMs ?? '-'}ms total=${stats.last.totalMs}ms${error ? ' ERROR=' + stats.last.error : ''}`);
  };

  if (b.stream) {
    streamStart(res, id, model, created);
    let transport = 'unknown';
    try {
      const result = await generate(model, ms, (chunk) => {
        if (!firstTokenAt) firstTokenAt = now();
        outputChars += chunk.length;
        streamDelta(res, id, model, created, chunk);
      }, ctl.signal);
      transport = result.transport;
      streamEnd(res, id, model, created);
      record(transport, null);
    } catch (e) {
      record(transport, e);
      if (!res.writableEnded) res.destroy(e);
    }
    return;
  }

  try {
    const result = await generate(model, ms, null, ctl.signal);
    firstTokenAt = now();
    outputChars = result.text.length;
    json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
    record(result.transport, null);
  } catch (e) {
    record('unknown', e);
    throw e;
  }
}

async function handler(req, res) {
  const u = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const p = u.pathname.replace(/\/$/, '') || '/';
  if (req.method === 'GET' && (p === '/health' || p === '/v1/health' || p === '/diagnostics' || p === '/v1/diagnostics')) {
    return json(res, 200, {
      ok: true,
      service: 'inkos-codex-bridge',
      bridgeVersion: 3,
      defaultModel: DEF_MODEL,
      fastTextMode: FAST_TEXT_MODE,
      effortPolicy: 'Terra/Luna=none, Sol=low',
      appServerEnabled: APP_SERVER,
      appServerAlive: Boolean(app.child && app.child.exitCode === null),
      consecutiveAppFailures,
      models: MODELS,
      stats
    });
  }
  if (req.method === 'GET' && (p === '/models' || p === '/v1/models')) {
    return json(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'chatgpt-codex' })) });
  }
  if (req.method === 'POST' && (p === '/chat/completions' || p === '/v1/chat/completions')) {
    return chat(req, res, await body(req));
  }
  return json(res, 404, { error: { message: `Unsupported route: ${req.method} ${p}`, type: 'invalid_request_error', code: 'route_not_found' } });
}

async function check() {
  const started = now();
  const result = await generate(DEF_MODEL, [{ role: 'user', content: 'Reply with exactly CODEX_BRIDGE_OK' }], null);
  if (result.text.trim() !== 'CODEX_BRIDGE_OK') throw new Error('Unexpected: ' + compact(result.text));
  console.log(`CODEX_BRIDGE_OK transport=${result.transport} total=${now() - started}ms`);
}

if (process.argv.includes('--check')) {
  check().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => app.stop());
} else {
  const server = http.createServer((req, res) => handler(req, res).catch((e) => {
    if (res.headersSent) return res.destroy(e);
    json(res, e.status || 500, { error: { message: e.message || String(e), type: 'codex_cli_error', code: e.code || 'bridge_error' } });
  }));
  server.listen(PORT, HOST, () => {
    console.log(`[inkos-codex-bridge] v3 listening on http://${HOST}:${PORT}/v1`);
    console.log(`[inkos-codex-bridge] default=${DEF_MODEL}; fast-text=${FAST_TEXT_MODE}; effort Terra/Luna=none Sol=low`);
    console.log(`[inkos-codex-bridge] diagnostics: http://${HOST}:${PORT}/diagnostics`);
  });
  const stop = () => { app.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
