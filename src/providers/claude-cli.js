// Claude Code CLI provider. Runs the installed `claude` binary under Owner's Max login (user mastan).
// Two modes:
//  - one shot (jobs, extractor): one `claude -p` process per call.
//  - resident (chat turns, opts.sessionKey): one long-lived `claude -p --input-format stream-json`
//    process per chat, booted once and reused for every turn, so a turn costs model time only
//    (measured 26 Oct: 5.5 s wall per one-shot turn against 1.7 s resident, same model and prompt).
//    An idle resident exits after IDLE_MS; the next turn resumes the same session from disk.
// backend 'deepseek' (deepseek-cli.js) runs the same binary against DeepSeek, sandboxed (deepseek.js).
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {config} from '../config.js';
import {childEnv, killTree, mcpArgs} from './common.js';
import {chatCredentials} from '../chat-tokens.js';
import {deepseekLaunch, deepseekModelArg} from './deepseek.js';
import {mainLaunch} from './main-sandbox.js';

// An idle resident exits after IDLE_MS (default 4 h, MASTAN_ME_RESIDENT_IDLE_MIN overrides). Idle it costs
// about 250 MB and no tokens; the cold boot it saves costs about 1 s on the next turn (measured 26 Oct).
const IDLE_MS = Math.max(1, Number(process.env.MASTAN_ME_RESIDENT_IDLE_MIN) || 240) * 60_000;
const residents = new Map(); // sessionKey -> Resident

// mcp: 'main' gives the main agent its MCP servers (Smartsheet, browser); anything else runs with none.
// tools: a list of built-in tool names for this call; [] means none at all (--tools ""), for prompts that carry untrusted text.
function baseArgs({model, effort, systemFile, resume, stream, input, mcp, chat, backend, tools}) {
  const args = ['-p', '--output-format', stream ? 'stream-json' : 'json', '--model', backend === 'deepseek' ? deepseekModelArg(model) : model,
    '--permission-mode', 'bypassPermissions'];
  if (Array.isArray(tools)) args.push('--tools', tools.join(','));
  if (input) args.push('--input-format', 'stream-json');
  if (stream) args.push('--verbose', '--include-partial-messages');
  args.push(...mcpArgs(mcp, chat));
  if (effort) args.push('--effort', effort);
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  if (resume) args.push('--resume', resume);
  return args;
}

// The process to spawn: the claude binary itself, or for DeepSeek the sandbox around it (throws NO_KEY / NO_SANDBOX).
function launch(spec, args, env) {
  return spec.backend === 'deepseek' ? deepseekLaunch(spec.model, args, env) : mainLaunch(args, env);
}

// Splits stream-json stdout into events: init, text deltas, message starts, tool uses, result.
function lineParser(h) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'system' && ev.subtype === 'init') h.init?.(ev);
      else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') h.delta?.(ev.event.delta.text);
      else if (ev.type === 'stream_event' && ev.event?.type === 'message_start') h.messageStart?.();
      else if (ev.type === 'assistant') { for (const c of ev.message?.content || []) if (c.type === 'tool_use') h.tool?.(c); }
      else if (ev.type === 'result') h.result?.(ev);
    }
  };
}

function exitError(final, code, errTail) {
  const msg = final?.result ? String(final.result).slice(0, 300) : `claude exited ${code}${errTail ? ': ' + errTail.split('\n').filter(Boolean).at(-1) : ''}`;
  return Object.assign(new Error(msg), {exitCode: code, sessionId: final?.session_id});
}

export async function run(opts) {
  if (opts.sessionKey && opts.stream) return runResident(opts);
  return runOnce(opts);
}

function runOnce({model, effort, prompt, cwd, systemFile, resume, mcp, chat, backend, tools, stream = false, onEvent = () => {}, timeoutMs = 15 * 60_000, signal}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Stopped'), {code: 'ABORTED'}));
  const args = baseArgs({model, effort, systemFile, resume, stream, mcp, chat, backend, tools});
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const credentials = chatCredentials(chat);
    let l;
    try { l = launch({backend, model}, args, childEnv(credentials.env)); }
    catch (e) { credentials.revoke(); return reject(e); }
    const child = spawn(l.cmd, l.args, {cwd, env: l.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true});
    let raw = '', errTail = '', final = null, sessionId = resume || null, text = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, {once: true});
    const parse = lineParser({
      init: ev => { sessionId = ev.session_id; onEvent({kind: 'init', sessionId}); },
      delta: t => { text += t; onEvent({kind: 'delta', text}); },
      messageStart: () => { if (text && !text.endsWith('\n\n')) text += '\n\n'; },
      tool: c => onEvent({kind: 'tool', name: c.name, input: c.input}),
      result: ev => { final = ev; },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stream) parse(chunk); else raw += chunk; });
    child.stderr.on('data', c => { errTail = (errTail + c).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { credentials.revoke(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', code => {
      credentials.revoke();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!stream) { try { final = JSON.parse(raw); } catch { final = null; } }
      const durationMs = Date.now() - started;
      if (signal?.aborted) return reject(Object.assign(new Error('Stopped'), {code: 'ABORTED', durationMs}));
      if (timedOut) return reject(Object.assign(new Error('Timed out'), {code: 'TIMEOUT', durationMs}));
      if (!final || final.is_error) return reject(Object.assign(exitError(final, code, errTail), {durationMs, sessionId: final?.session_id || sessionId}));
      resolve({text: String(final.result ?? text), sessionId: final.session_id || sessionId, durationMs, exitCode: code, usage: final.usage, costUsd: final.total_cost_usd});
    });
    child.stdin.end(prompt);
  });
}

class Resident {
  constructor(key, spec) {
    this.key = key; this.spec = spec; // {model, effort, cwd, systemFile, systemText, resume, mcp, chat}
    this.sessionId = spec.resume || null;
    this.child = null; this.turn = null; this.errTail = ''; this.idle = null; this.exited = false; this.reason = null;
    this.bootedAt = 0; this.initAt = 0;
  }

  alive() { return Boolean(this.child) && !this.exited; }

  start() {
    this.bootedAt = Date.now();
    this.credentials = chatCredentials(this.spec.chat);
    let l;
    try { l = launch(this.spec, baseArgs({...this.spec, stream: true, input: true}), childEnv(this.credentials.env)); }
    catch (e) { this.credentials.revoke(); this.exited = true; if (residents.get(this.key) === this) residents.delete(this.key); throw e; }
    this.child = spawn(l.cmd, l.args, {cwd: this.spec.cwd, env: l.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', lineParser({
      init: ev => { this.sessionId = ev.session_id; if (!this.initAt) this.initAt = Date.now(); this.turn?.opts.onEvent({kind: 'init', sessionId: ev.session_id}); },
      delta: t => { const turn = this.turn; if (!turn) return; turn.text += t; turn.opts.onEvent({kind: 'delta', text: turn.text}); },
      messageStart: () => { const turn = this.turn; if (turn?.text && !turn.text.endsWith('\n\n')) turn.text += '\n\n'; },
      tool: c => this.turn?.opts.onEvent({kind: 'tool', name: c.name, input: c.input}),
      result: ev => this.finish(ev),
    }));
    this.child.stderr.on('data', c => { this.errTail = (this.errTail + c).slice(-2000); });
    this.child.stdin.on('error', () => {});
    this.child.on('error', e => this.close(-1, e));
    this.child.on('close', code => this.close(code));
    this.touch();
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.turn) this.kill('idle'); }, IDLE_MS);
    this.idle.unref?.();
  }

  kill(reason) {
    this.credentials?.revoke();
    this.reason = reason;
    clearTimeout(this.idle);
    if (residents.get(this.key) === this) residents.delete(this.key);
    if (this.alive()) killTree(this.child);
  }

  send(opts) {
    if (this.turn) return Promise.reject(Object.assign(new Error('Busy'), {code: 'BUSY'}));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const turn = this.turn = {opts, resolve, reject, text: '', started: Date.now()};
      turn.timer = setTimeout(() => this.kill('timeout'), opts.timeoutMs);
      turn.onAbort = () => this.kill('abort');
      opts.signal?.addEventListener('abort', turn.onAbort, {once: true});
      this.child.stdin.write(JSON.stringify({type: 'user', message: {role: 'user', content: opts.prompt}}) + '\n', err => { if (err) this.kill('stdin'); });
    });
  }

  settle(turn) {
    clearTimeout(turn.timer);
    turn.opts.signal?.removeEventListener('abort', turn.onAbort);
    if (this.turn === turn) this.turn = null;
  }

  finish(ev) {
    const turn = this.turn;
    if (!turn) return;
    this.settle(turn);
    this.touch();
    const durationMs = Date.now() - turn.started;
    if (ev.is_error) return turn.reject(Object.assign(exitError(ev, 0, ''), {durationMs}));
    turn.resolve({text: String(ev.result ?? turn.text), sessionId: ev.session_id || this.sessionId, durationMs, exitCode: 0,
      usage: ev.usage, costUsd: ev.total_cost_usd, bootMs: this.initAt ? this.initAt - this.bootedAt : null});
  }

  close(code, err) {
    this.credentials?.revoke();
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.idle);
    if (residents.get(this.key) === this) residents.delete(this.key);
    const turn = this.turn;
    if (!turn) return;
    this.settle(turn);
    const durationMs = Date.now() - turn.started;
    if (turn.opts.signal?.aborted || this.reason === 'abort') return turn.reject(Object.assign(new Error('Stopped'), {code: 'ABORTED', durationMs}));
    if (this.reason === 'timeout') return turn.reject(Object.assign(new Error('Timed out'), {code: 'TIMEOUT', durationMs}));
    turn.reject(Object.assign(err || exitError(null, code, this.errTail), {durationMs, sessionId: this.sessionId}));
  }
}

function specOf({model, effort, cwd, systemFile, resume, mcp, chat, backend}) {
  return {model, effort, cwd, systemFile, systemText: systemFile ? readFileSync(systemFile, 'utf8') : '', resume: resume || null, mcp: mcp || 'none',
    chat: chat ? {...chat} : undefined, backend: backend || 'claude'};
}
const sameChat = (a, b) => a?.user === b?.user && a?.channel === b?.channel && a?.chatId === b?.chatId && a?.simulation === b?.simulation
  && a?.kind === b?.kind && a?.taskId === b?.taskId && Boolean(a?.deepseek) === Boolean(b?.deepseek);
const fits = (r, s) => r.alive() && r.spec.backend === s.backend && r.spec.model === s.model && r.spec.effort === s.effort && r.spec.cwd === s.cwd
  && r.spec.systemText === s.systemText && r.spec.mcp === s.mcp && sameChat(r.spec.chat, s.chat) && s.resume === (r.sessionId || null);

// Open sessions are not capped, memory is: past this many residents the one unused longest exits. It comes back with --resume.
const MAX_RESIDENTS = 8;
function makeRoom() {
  if (residents.size < MAX_RESIDENTS) return;
  for (const r of residents.values()) if (!r.turn) { r.kill('evicted'); return; }
}

// The resident for this key that fits the spec, booted when there is none. busy: one is mid-turn (never replaced).
function resident(key, spec) {
  let r = residents.get(key);
  if (r) { residents.delete(key); residents.set(key, r); } // the Map stays ordered by last use
  if (r && r.alive() && r.turn) return {r, cold: false, busy: true};
  if (r && !fits(r, spec)) { r.kill('replaced'); r = null; }
  if (r) return {r, cold: false, busy: false};
  makeRoom();
  r = new Resident(key, spec); residents.set(key, r); r.start();
  return {r, cold: true, busy: false};
}

async function runResident(opts) {
  const {sessionKey: key, prompt, onEvent = () => {}, timeoutMs = 60 * 60_000, signal} = opts;
  const {r, cold, busy} = resident(key, specOf(opts));
  if (busy) throw Object.assign(new Error('Busy'), {code: 'BUSY'});
  const result = await r.send({prompt, onEvent, timeoutMs, signal});
  return {...result, log: cold ? {cold: 1, boot_ms: result.bootMs} : undefined};
}

// Boots the resident for a chat before the first turn, which then pays model time only. No prompt is
// sent, so no tokens. A no-op while a fitting resident is alive or mid-turn.
export function warm(opts) {
  const {cold, busy} = resident(opts.sessionKey, specOf(opts));
  return {warmed: cold && !busy};
}

export function dropSession(key) { residents.get(key)?.kill('dropped'); }
export function shutdownSessions() { for (const r of [...residents.values()]) r.kill('shutdown'); }
export const residentCount = () => residents.size;
