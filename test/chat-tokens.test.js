// Real child processes, a tiny fake Claude protocol, and boolean env observations only. No token is written or printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mm-chat-env-'));
const fake = join(dir, 'fake.mjs'), bin = join(dir, 'claude');
writeFileSync(fake, `import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
const e = process.env;
const result = JSON.stringify({rpc: e.MASTAN_ME_RPC === 'http://127.0.0.1:3100', chat: /^[A-Za-z0-9_-]{43}$/.test(e.MASTAN_ME_CHAT_TOKEN || ''),
  internal: Object.keys(e).some(k => /INTERNAL.*TOKEN/i.test(k)), secret: !!e.SESSION_SECRET, credentials: !!e.CREDENTIALS_DIRECTORY});
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (!process.argv.includes('--input-format')) {
  let prompt = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { prompt += c; });
  process.stdin.on('end', () => {
    if (prompt === 'hold') setInterval(() => {}, 1000);
    else if (prompt.startsWith("Owner's main chat turn is busy.")) {
      const mcp = process.argv[process.argv.indexOf('--mcp-config') + 1];
      const observed = {...JSON.parse(result), noMcp: process.argv.includes('--strict-mcp-config')
        && Object.keys(JSON.parse(readFileSync(mcp, 'utf8')).mcpServers).length === 0};
      out({type: 'result', result: JSON.stringify({reply: JSON.stringify(observed), queue: false}), session_id: 'busy-once'});
    } else out({type: 'result', result, session_id: 'once'});
  });
} else {
  out({type: 'system', subtype: 'init', session_id: String(process.pid)});
  createInterface({input: process.stdin}).on('line', () => out({type: 'result', result, session_id: String(process.pid)}));
}
`);
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(bin, 0o755);
process.env.MASTAN_ME_DATA = dir;
process.env.CLAUDE_BIN = bin;
process.env.AGENT_HOME = dir;
process.env.SESSION_SECRET = 'invented-service-value';
process.env.X_INTERNAL_TOKEN = 'invented-operator-value';
process.env.MASTAN_ME_CHAT_TOKEN = 'ambient-must-not-inherit';
process.env.MASTAN_ME_RPC = 'ambient-must-not-inherit';
process.env.CREDENTIALS_DIRECTORY = join(dir, 'absent-credentials');
delete process.env.SMARTSHEET_TOKEN_FILE;
const {run, warm, shutdownSessions, dropSession, residentCount} = await import('../src/providers/claude-cli.js');
const {childEnv} = await import('../src/providers/common.js');
const {chatCredentials, chatForToken} = await import('../src/chat-tokens.js');
const {BackgroundTasks} = await import('../src/agent/tasks.js');
const {busyReply} = await import('../src/agent/busy-reply.js');
const {config} = await import('../src/config.js');
const base = {model: 'fake', cwd: dir, prompt: 'invented', timeoutMs: 2000};
const chat = {user: 'owner', channel: 'telegram', chatId: '999'};
const check = (result, hasChat) => assert.deepEqual(JSON.parse(result.text), {rpc: hasChat, chat: hasChat, internal: false, secret: false, credentials: false});
test.after(() => { shutdownSessions(); rmSync(dir, {recursive: true, force: true}); });

test('one-shot chats get RPC and a chat credential; jobs and extractors inherit neither', async () => {
  check(await run({...base, chat}), true);
  check(await run({...base, chat, mcp: 'main'}), true);
  check(await run({...base, mcp: 'none'}), false);
  check(await run({...base, mcp: 'extractor'}), false);
  const env = childEnv({X_INTERNAL_TOKEN: 'invented', 'X-Internal-Token': 'invented', MASTAN_ME_INTERNAL_TOKEN: 'invented'});
  assert.equal(Object.keys(env).some(k => /INTERNAL.*TOKEN/i.test(k)), false);
  assert.equal(env.MASTAN_ME_CHAT_TOKEN, undefined); assert.equal(env.SESSION_SECRET, undefined);
});

test('warm and cold resident chats receive credentials, reuse a fitting child and replace a different chat or simulation', async () => {
  const opts = {...base, chat, stream: true, sessionKey: 'telegram:999'};
  assert.equal(warm(opts).warmed, true);
  const first = await run(opts); check(first, true); assert.equal(first.log, undefined);
  const again = await run({...opts, resume: first.sessionId}); check(again, true); assert.equal(again.sessionId, first.sessionId);
  const other = await run({...opts, resume: again.sessionId, chat: {...chat, chatId: '1', simulation: {calls: []}}});
  check(other, true); assert.notEqual(other.sessionId, again.sessionId); assert.equal(other.log.cold, 1);
  dropSession(opts.sessionKey);
  const cold = await run(opts); check(cold, true); assert.equal(cold.log.cold, 1);
  shutdownSessions();
});

test('credentials bind two chats independently and revocation removes only that credential', () => {
  const a = chatCredentials(chat), b = chatCredentials({...chat, chatId: '1', simulation: {calls: []}});
  try {
    assert.notEqual(a.env.MASTAN_ME_CHAT_TOKEN, b.env.MASTAN_ME_CHAT_TOKEN);
    assert.equal(chatForToken(a.env.MASTAN_ME_CHAT_TOKEN).chatId, '999');
    assert.equal(chatForToken(b.env.MASTAN_ME_CHAT_TOKEN).chatId, '1');
    a.revoke(); assert.equal(chatForToken(a.env.MASTAN_ME_CHAT_TOKEN), undefined);
    assert.equal(chatForToken(b.env.MASTAN_ME_CHAT_TOKEN).chatId, '1');
  } finally { a.revoke(); b.revoke(); }
});

test('background tasks run a real one-shot fake child with chat credentials and a task-marked token', async () => {
  mkdirSync(config.workspace, {recursive: true});
  const simulation = {calls: []}, tasks = new BackgroundTasks();
  const out = tasks.start({...chat, simulation}, {title: 'Invented child task', brief: 'invented'});
  assert.equal(out.status, 'running');
  try {
    await Promise.all([...tasks.running.values()].map(s => s.promise));
    const row = tasks.owned(chat, out.id);
    assert.equal(row.status, 'done');
    check({text: row.result}, true);
    assert.equal(row.session_id, 'once');
    assert.match(simulation.calls.at(-1).text, /^Done: Invented child task/);
    const c = chatCredentials({...chat, kind: 'task', taskId: out.id});
    try { assert.equal(chatForToken(c.env.MASTAN_ME_CHAT_TOKEN).kind, 'task'); }
    finally { c.revoke(); }
  } finally { tasks.shutdown(); }
});

test('one-shot calls reject an already aborted signal, abort a running child, and identify timeouts', async () => {
  await assert.rejects(run({...base, signal: AbortSignal.abort()}), {code: 'ABORTED'});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(run({...base, prompt: 'hold', signal: controller.signal}), {code: 'ABORTED'}); }
  finally { clearTimeout(timer); }
  await assert.rejects(run({...base, prompt: 'hold', timeoutMs: 100}), {code: 'TIMEOUT'});
});

test('busy replies use a real one-shot fake child with no chat credentials, MCP servers or resident', async () => {
  mkdirSync(config.workspace, {recursive: true});
  const before = process.env.MASTAN_ME_CONNECTORS;
  process.env.MASTAN_ME_CONNECTORS = 'on';
  try {
    assert.equal(residentCount(), 0);
    const out = await busyReply({running: {started: Date.now(), request: 'Invented deck.'}, message: 'How long?'});
    assert.equal(out.queue, false);
    assert.deepEqual(JSON.parse(out.reply), {rpc: false, chat: false, internal: false, secret: false, credentials: false, noMcp: true});
    assert.equal(residentCount(), 0);
  } finally {
    if (before === undefined) delete process.env.MASTAN_ME_CONNECTORS;
    else process.env.MASTAN_ME_CONNECTORS = before;
  }
});
