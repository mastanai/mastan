// Web chat: routes behind a session, threads per identity (cap, rename, archive), attachments into the inbox,
// streaming events with thread ids, queueing, stop and new session. The agent is a fake; nothing here talks to a model or to Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';

const base = existsSync('/private/tmp/claude-501') ? '/private/tmp/claude-501' : tmpdir();
const DATA = mkdtempSync(join(base, 'mastan-me-chat-test-'));
process.env.MASTAN_ME_DATA = DATA;
process.env.MASTAN_ME_HOSTNAME = 'me.example.com';
process.env.MASTAN_ME_RP_ID = 'mastan.ai';

const {config, today} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const A = await import('../src/web/auth.js');
mkdirSync(config.workspace, {recursive: true});

const logged = [];
for (const k of ['log', 'error', 'warn', 'info']) {
  const orig = console[k];
  console[k] = (...args) => { logged.push(args.join(' ')); if (process.env.WEB_TEST_VERBOSE) orig(...args); };
}

// --- fake agent: streams two deltas and a tool line, can be held open, stopped or made to fail
const agent = {
  calls: [], news: [], hold: false, fail: false, release: null, abort: false,
  async turn({channel, chatId, text, onDelta, onTool}) {
    agent.calls.push({channel, chatId, text});
    onTool('Grep', {pattern: 'x', path: 'memory/'});
    onDelta('Hel'); onDelta('Hello');
    await new Promise(r => setTimeout(r, 200)); // let the coalesced delta/tool event go out
    if (agent.hold) await new Promise(r => { agent.release = r; });
    if (agent.abort) { agent.abort = false; throw Object.assign(new Error('Stopped'), {code: 'ABORTED'}); }
    if (agent.fail) throw new Error('boom');
    return {text: `Hello back. You said: ${text.slice(0, 60)}`, durationMs: 5, sessionId: 's1', model: 'fake'};
  },
  stop(channel, chatId) {
    if (!agent.release) return false;
    agent.abort = true;
    const r = agent.release; agent.release = null; r();
    return true;
  },
  newSession(channel, chatId) { agent.news.push([channel, chatId]); },
};

const db = openDb();
const chat = new WebChat({agent, runBusy: async () => ({text: JSON.stringify({reply: 'I will take this right after the current request.', queue: true})})});
const handler = createWeb({config, db, atlas: null, brain: null, board: null, chat});
const server = http.createServer(handler);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
test.after(async () => { await new Promise(r => server.close(r)); rmSync(DATA, {recursive: true, force: true}); });

function req(path, {method = 'GET', body, cookie, csrf, headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {Host: 'me.example.com', 'X-Real-IP': '203.0.113.9', ...headers};
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = String(payload.length); }
    if (method !== 'GET' && method !== 'HEAD') h.Origin = 'https://me.example.com';
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    const r = http.request({host: '127.0.0.1', port, path, method, headers: h, setHost: false}, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({status: res.statusCode, headers: res.headers, text, json, body: Buffer.concat(parts)}); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
// Reads the event stream until `until(text)` is true, then closes it.
function stream(cookie, until, ms = 4000) {
  return new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port, path: '/api/chat/stream', headers: {Host: 'me.example.com', 'X-Real-IP': '203.0.113.9', Cookie: cookie}, setHost: false}, res => {
      let text = '';
      const timer = setTimeout(() => { r.destroy(); resolve({status: res.statusCode, headers: res.headers, text}); }, ms);
      res.on('data', c => { text += c; if (until(text)) { clearTimeout(timer); r.destroy(); resolve({status: res.statusCode, headers: res.headers, text}); } });
    });
    r.on('error', reject);
    r.end();
  });
}
const wait = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return fn(); };
const lastAssistant = who => db.prepare("SELECT * FROM web_messages WHERE who=? AND role='assistant' ORDER BY id DESC LIMIT 1").get(who);

A.addCredential(db, {id: 'Y2hhdC1maXh0dXJlLWNyZWQ', publicKey: new Uint8Array(40).fill(3), origin: 'local'});
const S = A.createSession(db, 'Y2hhdC1maXh0dXJlLWNyZWQ');
const SC = `${COOKIE}=${S.value}`;
const OP = A.createSession(db, A.OPERATOR, {ttl: A.OPERATOR_SESSION_TTL});
const OC = `${COOKIE}=${OP.value}`;
const get = (path, opts = {}) => req(path, {cookie: SC, ...opts});
const post = (path, body = {}, opts = {}) => req(path, {method: 'POST', body, cookie: SC, csrf: S.csrf, ...opts});

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('chat needs a session; the page is the my.example.com client', async () => {
  assert.equal((await req('/api/chat/history')).status, 401);
  assert.equal((await req('/api/chat/stream')).status, 401);
  assert.equal((await req('/chat')).status, 303);
  const page = await get('/chat');
  assert.equal(page.status, 200);
  assert.match(page.text, /id="approvals"/);
  assert.match(page.text, /chat\/app\.js\?v=/);
  assert.match(page.headers['content-security-policy'], /media-src 'self' blob:/);
  assert.doesNotMatch(page.text, /<style/);
  assert.equal((await get('/static/chat/app.js')).status, 200);
  assert.equal((await req('/static/chat/app.js')).status, 401);
  assert.equal((await get('/chat/s/12')).status, 200);
  assert.equal((await get('/chat/s/x')).status, 404);
});

test('empty thread, then a text message streams and lands in history', async () => {
  const h0 = await get('/api/chat/history');
  assert.equal(h0.status, 200);
  assert.equal(h0.json.thread.title, 'General', 'the first visit gets a General thread');
  assert.equal(h0.json.thread.id, 1);
  assert.deepEqual({...h0.json, thread: undefined}, {who: 'owner', operator: false, messages: [], more: false, live: null, thread: undefined});

  const open = stream(SC, t => /event: done/.test(t));
  await new Promise(r => setTimeout(r, 50));
  const sent = await post('/api/chat/send', {text: 'hi there'});
  assert.equal(sent.status, 200);
  assert.equal(sent.json.queued, 0);
  const ev = await open;
  assert.equal(ev.status, 200);
  assert.match(ev.headers['content-type'], /text\/event-stream/);
  assert.equal(ev.headers['x-accel-buffering'], 'no');
  assert.match(ev.text, /event: hello\ndata: \{"who":"owner","lives":\{\}/);
  assert.match(ev.text, /event: start\ndata: \{"who":"owner","type":"start","thread":1,/);
  assert.equal(agent.calls.at(-1).chatId, 'owner#1');
  assert.match(ev.text, /event: user\ndata: .*"text":"hi there"/);
  assert.match(ev.text, /event: start/);
  assert.match(ev.text, /event: (delta|tool)\ndata: .*"status":"Looking in memory\.\.\."/);
  assert.match(ev.text, /event: done\ndata: .*"text":"Hello back\. You said: hi there"/);
  assert.equal(agent.calls.at(-1).channel, 'web');
  assert.equal(agent.calls.at(-1).chatId, 'owner#1');

  const h1 = await get('/api/chat/history');
  assert.equal(h1.json.messages.length, 2);
  assert.equal(h1.json.messages[0].role, 'user');
  assert.equal(h1.json.messages[1].role, 'assistant');
  assert.equal(h1.json.messages[1].status, 'done');
  assert.equal(h1.json.live, null);
});

test('a screenshot is written to the inbox, named to the agent, and served back; other files are not served', async () => {
  const sent = await post('/api/chat/send', {text: 'what is this', files: [{name: 'Screenshot 2026-10-26 at 11.40.12.png', type: 'image/png', data: PNG.toString('base64')}, {name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64')}]});
  assert.equal(sent.status, 200, sent.text);
  await wait(() => lastAssistant('owner')?.status === 'done');
  const prompt = agent.calls.at(-1).text;
  assert.match(prompt, new RegExp(String.raw`^what is this\n\n\[Attached: .*\/inbox\/\d{4}-\d{2}-\d{2}\/web-\d{6}-1-Screenshot_2026-10-26_at_11\.40\.12\.png \(image\/png, ${PNG.length} bytes\)\]\n\[Attached: .*web-\d{6}-2-notes\.txt \(text\/plain, 5 bytes\)\]$`));
  const path = prompt.match(/\[Attached: (\S+\.png)/)[1];
  assert.ok(existsSync(path));
  assert.deepEqual(readFileSync(path), PNG);
  const h = await get('/api/chat/history');
  const msg = h.json.messages.find(m => m.text === 'what is this');
  assert.equal(msg.files.length, 2);
  assert.equal(msg.files[0].mime, 'image/png');
  assert.match(msg.files[0].rel, new RegExp(`^${today()}/web-\\d{6}-1-Screenshot_2026-10-26_at_11\\.40\\.12\\.png$`));
  const img = await get(`/api/chat/file/${msg.files[0].rel}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.deepEqual(img.body, PNG);
  assert.equal((await get(`/api/chat/file/${msg.files[1].rel}`)).status, 404, 'text files are for the agent only');
  assert.equal((await get(`/api/chat/file/${today()}/..%2F..%2FSOUL.md`)).status, 404);
  assert.equal((await get('/api/chat/file/2026-10-26/../../../etc/passwd')).status, 404);
  assert.equal((await get(`/api/chat/file/${today()}/missing.png`)).status, 404);
  assert.equal((await req(`/api/chat/file/${msg.files[0].rel}`)).status, 401);
});

test('validation: empty, bad lists, bad base64, unknown keys, CSRF', async () => {
  assert.equal((await post('/api/chat/send', {text: '   '})).status, 400);
  assert.equal((await post('/api/chat/send', {text: 'x', files: 'nope'})).status, 400);
  assert.equal((await post('/api/chat/send', {text: 'x', files: [{name: 'a', type: 'image/png', data: '!!not base64!!'}]})).status, 400);
  assert.equal((await post('/api/chat/send', {text: 'x', files: [{name: 'a', type: 'image/png', data: ''}]})).status, 400);
  assert.equal((await post('/api/chat/send', {text: 'x', files: Array.from({length: 7}, () => ({name: 'a', type: 'image/png', data: 'AA=='}))})).status, 400);
  assert.equal((await post('/api/chat/send', {text: 'x', extra: 1})).status, 400);
  assert.equal((await post('/api/chat/send', {text: 'x'.repeat(20_001)})).status, 400);
  assert.equal((await req('/api/chat/send', {method: 'POST', body: {text: 'x'}, cookie: SC})).status, 403, 'no CSRF token');
  assert.equal((await get('/api/chat/send')).status, 405);
  assert.equal((await get('/api/chat/nope')).status, 404);
  assert.equal(agent.calls.filter(c => c.text === 'x').length, 0);
});

test('busy thread queues the next message; stop aborts the running turn', async () => {
  agent.hold = true;
  const first = await post('/api/chat/send', {text: 'long one'});
  assert.equal(first.json.queued, 0);
  await wait(() => agent.release);
  const h = await get('/api/chat/history');
  assert.ok(h.json.live);
  assert.equal(h.json.live.text, 'Hello');
  assert.equal(h.json.live.status, 'Looking in memory...');
  const second = await post('/api/chat/send', {text: 'next one'});
  assert.equal(second.json.queued, 1);
  assert.equal((await get('/api/chat/history')).json.live.queued, 1);
  agent.hold = false;
  const stopped = await post('/api/chat/stop');
  assert.deepEqual(stopped.json, {stopped: true});
  if (agent.release) { const r = agent.release; agent.release = null; r(); }
  await wait(() => agent.calls.at(-1)?.text === 'next one' && lastAssistant('owner')?.status === 'done');
  const h2 = await get('/api/chat/history');
  const tail = h2.json.messages.slice(-5).map(m => [m.role, m.status]);
  assert.deepEqual(tail, [['user', 'done'], ['assistant', 'stopped'], ['user', 'done'], ['assistant', 'done'], ['assistant', 'done']]);
  assert.match(h2.json.messages.at(-4).text, /Hello\n\nStopped\./);
  assert.equal(h2.json.messages.at(-2).text, 'I will take this right after the current request.');
  assert.deepEqual((await post('/api/chat/stop')).json, {stopped: false});
});

test('a failed turn is recorded with the partial text', async () => {
  agent.fail = true;
  await post('/api/chat/send', {text: 'break'});
  await wait(() => lastAssistant('owner')?.status === 'failed');
  agent.fail = false;
  const row = lastAssistant('owner');
  assert.match(row.text, /^Hello\n\nThat failed \(boom\)\./);
});

test('new session marks the thread and resets the agent session', async () => {
  const r = await post('/api/chat/new');
  assert.equal(r.status, 200);
  assert.deepEqual(agent.news, [['web', 'owner#1']]);
  const h = await get('/api/chat/history');
  assert.equal(h.json.messages.at(-1).role, 'system');
  assert.match(h.json.messages.at(-1).text, /New session/);
});

test('operator sessions get their own thread and session key', async () => {
  const h = await req('/api/chat/history', {cookie: OC});
  assert.equal(h.status, 200);
  assert.equal(h.json.who, 'operator');
  assert.equal(h.json.operator, true);
  assert.deepEqual(h.json.messages, []);
  const sent = await req('/api/chat/send', {method: 'POST', body: {text: 'op test', files: [{name: 'x.png', type: 'image/png', data: PNG.toString('base64')}]}, cookie: OC, csrf: OP.csrf});
  assert.equal(sent.status, 200, sent.text);
  await wait(() => lastAssistant('operator')?.status === 'done');
  assert.match(agent.calls.at(-1).chatId, /^operator#\d+$/);
  assert.match(agent.calls.at(-1).text, /web-\d{6}-1-operator-x\.png/);
  assert.equal((await req('/api/chat/history', {cookie: OC})).json.messages.length, 2);
  assert.ok(!(await get('/api/chat/history')).json.messages.some(m => m.text === 'op test'));
  await req('/api/chat/new', {method: 'POST', body: {}, cookie: OC, csrf: OP.csrf});
  assert.match(agent.news.at(-1)[1], /^operator#\d+$/);
});

test('threads: create, cap, rename, per-thread history and sessions, archive and restore', async ctx => {
  chat.threadCap = 5; ctx.after(() => { chat.threadCap = 200; });
  const before = (await get('/api/chat/threads')).json;
  assert.equal(before.cap, 5);
  assert.equal(before.open, 1);
  assert.equal(before.threads[0].title, 'General');
  assert.ok(before.threads[0].last, 'the list carries the last message');
  const made = [];
  for (const name of ['Team dashboard', 'Harness design', 'Work SLA', 'Trip']) {
    const r = await post('/api/chat/threads', {title: name});
    assert.equal(r.status, 200, r.text);
    made.push(r.json.thread.id);
  }
  const full = await post('/api/chat/threads', {title: 'one too many'});
  assert.equal(full.status, 409);
  assert.match(full.json.error, /5 threads are open/);
  assert.equal((await post('/api/chat/threads', {title: 'x', extra: 1})).status, 400);
  // a message in one thread stays there and runs on that thread's agent session
  const t = made[0];
  const sent = await post('/api/chat/send', {text: 'dashboard question', thread: t});
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.thread, t);
  await wait(() => agent.calls.at(-1)?.text === 'dashboard question' && lastAssistant('owner')?.status === 'done');
  assert.equal(agent.calls.at(-1).chatId, `owner#${t}`);
  const h = (await get(`/api/chat/history?thread=${t}`)).json;
  assert.equal(h.thread.id, t);
  assert.deepEqual(h.messages.map(m => [m.role, m.thread]), [['user', t], ['assistant', t]]);
  assert.ok(!(await get('/api/chat/history?thread=1')).json.messages.some(m => m.text === 'dashboard question'));
  assert.equal((await get('/api/chat/history?thread=999')).status, 404);
  assert.equal((await get('/api/chat/history?thread=abc')).status, 400);
  // without a thread, history and send go to the thread used last
  assert.equal((await get('/api/chat/history')).json.thread.id, t);
  // rename
  const ren = await post(`/api/chat/threads/${t}/rename`, {title: '  Team  dashboard v2 '});
  assert.equal(ren.json.thread.title, 'Team dashboard v2');
  assert.equal((await post(`/api/chat/threads/${t}/rename`, {title: '   '})).status, 400);
  // new session is per thread
  await post('/api/chat/new', {thread: t});
  assert.deepEqual(agent.news.at(-1), ['web', `owner#${t}`]);
  // archive: refused while a turn runs, fine after; an archived thread takes no messages; restore respects the cap
  agent.hold = true;
  await post('/api/chat/send', {text: 'slow', thread: t});
  await wait(() => agent.release);
  assert.equal((await post(`/api/chat/threads/${t}/archive`)).status, 409);
  agent.hold = false; const rel = agent.release; agent.release = null; rel();
  await wait(() => lastAssistant('owner')?.status === 'done');
  const arch = await post(`/api/chat/threads/${t}/archive`);
  assert.equal(arch.status, 200, arch.text);
  assert.ok(arch.json.thread.archived);
  assert.equal((await post('/api/chat/send', {text: 'late', thread: t})).status, 409);
  const list = (await get('/api/chat/threads')).json;
  assert.equal(list.open, 4);
  assert.equal(list.threads.at(-1).id, t, 'archived threads sort last');
  assert.equal((await post('/api/chat/threads', {title: 'room again'})).status, 200);
  assert.equal((await post(`/api/chat/threads/${t}/unarchive`)).status, 409, 'five open again, restore refused');
  assert.equal((await post(`/api/chat/threads/${made[1]}/archive`)).status, 200);
  assert.equal((await post(`/api/chat/threads/${t}/unarchive`)).status, 200);
  // another identity never sees these threads
  assert.equal((await req(`/api/chat/history?thread=${t}`, {cookie: OC})).status, 404);
  assert.equal((await req(`/api/chat/threads/${t}/archive`, {method: 'POST', body: {}, cookie: OC, csrf: OP.csrf})).status, 404);
});

test('rows from before threads land in a General thread and keep their agent session', async () => {
  db.prepare("INSERT INTO web_messages(who,role,text,status,created) VALUES('legacy','user','old message','done',1)").run();
  db.prepare("INSERT INTO chats(channel,chat_id,session_id,model,created,updated,turns) VALUES('web','legacy','sess-old','fake',1,1,3)").run();
  const again = new WebChat({agent});
  const t = again.threads('legacy');
  assert.equal(t.threads.length, 1);
  assert.equal(t.threads[0].title, 'General');
  assert.equal(again.history('legacy').messages[0].text, 'old message');
  assert.equal(db.prepare("SELECT chat_id FROM chats WHERE session_id='sess-old'").get().chat_id, `legacy#${t.threads[0].id}`);
});

test('logs never carry message text or file names', () => {
  const joined = logged.join('\n');
  assert.doesNotMatch(joined, /hi there|what is this|Screenshot 2026|op test|notes\.txt/);
});

// --- the routes the my.example.com client uses
const sessions = (path, method, body) => req(path, {method, body, cookie: SC, csrf: S.csrf});

test('sessions: bootstrap, create, send with a client id, read, pin, delete and undo', async () => {
  const boot = await get('/api/bootstrap');
  assert.equal(boot.json.authenticated, true); assert.equal(boot.json.accountKey, 'owner');
  assert.ok(boot.json.nav.some(([href]) => href === '/fleet'));
  assert.ok(!boot.json.nav.some(([href]) => href === '/chat'));
  const created = await sessions('/api/sessions', 'POST', {});
  assert.equal(typeof created.json.id, 'string'); assert.equal(created.json.empty, true);
  assert.equal((await sessions('/api/sessions', 'POST', {})).json.id, created.json.id, 'an empty session is reused');
  const sid = created.json.id;
  const sent = await sessions(`/api/sessions/${sid}/messages`, 'POST', {text: 'check my servers\nplease', clientId: 'client-12345678'});
  assert.equal(sent.status, 200); assert.equal(sent.json.clientId, 'client-12345678'); assert.equal(sent.json.sessionId, sid); assert.equal(typeof sent.json.created, 'number');
  await wait(() => !chat.busy(Number(sid)));
  const hist = await get(`/api/sessions/${sid}/messages`);
  assert.equal(hist.json.messages.length, 2); assert.equal(hist.json.messages[1].role, 'assistant');
  assert.equal(hist.json.session.title, 'check my servers', 'named from the first line');
  assert.equal(hist.json.session.unread, 1);
  const read = await sessions(`/api/sessions/${sid}`, 'PATCH', {read: hist.json.session.lastId, pinned: true});
  assert.equal(read.json.unread, 0); assert.equal(read.json.pinned, true);
  assert.equal((await req(`/api/sessions/${sid}`, {method: 'PATCH', body: {pinned: false}, cookie: SC})).status, 403, 'PATCH needs CSRF');
  assert.equal((await get('/api/sessions?q=check%20my')).json[0].id, sid);
  assert.equal((await get('/api/sessions?q=nothing-like-this')).json.length, 0);
  assert.equal((await sessions(`/api/sessions/${sid}`, 'DELETE', {})).status, 200);
  assert.equal((await get(`/api/sessions/${sid}/messages`)).status, 404);
  assert.equal((await sessions(`/api/sessions/${sid}/undo`, 'POST', {})).json.id, sid);
  assert.equal((await get(`/api/sessions/${sid}/messages`)).status, 200);
});

test('sessions: operator threads stay apart; no session means no access', async () => {
  const sid = (await sessions('/api/sessions', 'POST', {title: 'owner only'})).json.id;
  assert.equal((await req(`/api/sessions/${sid}/messages`, {cookie: OC})).status, 404);
  assert.equal((await req('/api/bootstrap')).status, 401);
  assert.equal((await req('/api/bootstrap', {cookie: OC})).json.nav.some(([href]) => href === '/fleet'), false);
});

test('sessions: upload, send, serve back, and bad ids refused', async () => {
  const sid = (await sessions('/api/sessions', 'POST', {title: 'files'})).json.id;
  const up = await new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port, path: `/api/uploads?session=${sid}`, method: 'POST', setHost: false, headers: {Host: 'me.example.com', 'X-Real-IP': '203.0.113.9', Origin: 'https://me.example.com',
      Cookie: SC, 'X-CSRF-Token': S.csrf, 'Content-Type': 'image/png', 'X-File-Name': 'shot.png', 'Content-Length': String(PNG.length)}}, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve(JSON.parse(t))); });
    r.on('error', reject); r.end(PNG);
  });
  assert.ok(up.id);
  const sent = await sessions(`/api/sessions/${sid}/messages`, 'POST', {text: 'look', clientId: 'client-abcdefgh', files: [{id: up.id}]});
  assert.equal(sent.json.files[0].id, up.id); assert.equal(sent.json.files[0].mime, 'image/png');
  await wait(() => !chat.busy(Number(sid)));
  assert.match(agent.calls.at(-1).text, /\[Attached: .*shot\.png \(image\/png, \d+ bytes\)\]/);
  const back = await get(`/api/uploads/${up.id}?inline=1`);
  assert.equal(back.status, 200); assert.equal(back.headers['content-type'], 'image/png');
  for (const evil of ['../../etc/passwd', '2026-11-05/../../secret', '2026-11-05/not-web-prefixed.png']) {
    assert.notEqual((await get(`/api/uploads/${Buffer.from(evil).toString('base64url')}`)).status, 200, evil);
  }
});

test('sessions: delete a message and retry a failed reply', async () => {
  const sid = (await sessions('/api/sessions', 'POST', {title: 'retry'})).json.id;
  agent.fail = true;
  await sessions(`/api/sessions/${sid}/messages`, 'POST', {text: 'try this', clientId: 'client-retry-01'});
  await wait(() => !chat.busy(Number(sid)));
  agent.fail = false;
  const failed = (await get(`/api/sessions/${sid}/messages`)).json.messages.at(-1);
  assert.equal(failed.status, 'failed');
  assert.equal((await sessions(`/api/sessions/${sid}/retry`, 'POST', {id: failed.id})).status, 200);
  await wait(() => !chat.busy(Number(sid)));
  const rows = (await get(`/api/sessions/${sid}/messages`)).json.messages;
  assert.equal(rows.length, 2); assert.equal(rows[1].status, 'done');
  assert.equal((await sessions(`/api/sessions/${sid}/messages/${rows[1].id}`, 'DELETE', {})).status, 200);
  assert.equal((await get(`/api/sessions/${sid}/messages`)).json.messages.length, 1);
});

test('events: the client stream carries message, delta, status with rising ids', async () => {
  const sid = (await sessions('/api/sessions', 'POST', {title: 'stream'})).json.id;
  const got = new Promise((resolve, reject) => {
    const r = http.request({host: '127.0.0.1', port, path: '/api/events?after=0', setHost: false, headers: {Host: 'me.example.com', 'X-Real-IP': '203.0.113.9', Cookie: SC}}, res => {
      let text = ''; const timer = setTimeout(() => { r.destroy(); resolve(text); }, 3000);
      res.on('data', c => { text += c; if (/event: message\ndata: \{[^\n]*"role":"assistant"[^\n]*"status":"done"/.test(text)) { clearTimeout(timer); r.destroy(); resolve(text); } });
    });
    r.on('error', reject); r.end();
  });
  await new Promise(r => setTimeout(r, 100));
  await sessions(`/api/sessions/${sid}/messages`, 'POST', {text: 'stream me', clientId: 'client-stream-1'});
  const text = await got;
  assert.match(text, /event: delta\ndata: \{"sessionId":"\d+","id":\d+,"text":"Hello"/);
  assert.match(text, /event: status/);
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
  assert.ok(ids.length > 3 && ids.every((n, i) => !i || n > ids[i - 1]));
  await wait(() => !chat.busy(Number(sid)));
});

test('an email alert link: signed out goes to sign-in and back; test logins never open mail', async () => {
  const id = 'a'.repeat(24);
  const out = await req(`/chat/mail/${id}`);
  assert.equal(out.status, 303); assert.equal(out.headers.location, `/login?next=/chat/mail/${id}`);
  assert.equal((await get(`/chat/mail/${id}`)).status, 200);
  assert.equal((await req(`/api/mail/${id}/open`, {method: 'POST', body: {}, cookie: OC, csrf: OP.csrf})).status, 404);
  assert.equal((await req(`/api/mail/${id}/open`, {method: 'POST', body: {}, cookie: SC})).status, 403, 'needs CSRF');
});
