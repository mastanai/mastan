// Invented tasks, fake providers and in-memory HTTP. Nothing calls a model, Telegram or an external service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable, Writable} from 'node:stream';
import {createHash} from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'mm-tasks-'));
process.env.MASTAN_ME_DATA = dir;
process.env.AGENT_HOME = join(dir, 'home');
process.env.OWNER_TELEGRAM_ID = '999';
process.env.SESSION_SECRET = 'invented-task-service';
process.env.MASTAN_ME_BROWSER = 'off';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_TOKEN_FILE;
delete process.env.CREDENTIALS_DIRECTORY;
delete process.env.MASTAN_ME_TASKS;
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {BackgroundTasks} = await import('../src/agent/tasks.js');
const {Agent} = await import('../src/agent/runner.js');
const {providers} = await import('../src/providers/index.js');
const {atlas} = await import('../src/atlas/store.js');
const {chatCredentials, chatForToken} = await import('../src/chat-tokens.js');
const {createInternal} = await import('../src/internal.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const {TelegramChannel} = await import('../src/channels/telegram.js');
const {sim} = await import('../src/channels/telegram-api.js');
const {task, main} = await import('../src/task-cli.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const auth = await import('../src/web/auth.js');
const db = openDb();
mkdirSync(config.workspace, {recursive: true});
writeFileSync(join(config.workspace, 'SOUL.md'), 'Invented soul.');
const source = join(config.workspace, 'invented.txt');
writeFileSync(source, 'Invented report.');
const credentials = [];
const liveRunners = [];
const credential = context => { const c = chatCredentials(context); credentials.push(c); return c.env; };
const tg = (chatId = '999') => ({user: 'owner', channel: 'telegram', chatId, simulation: {calls: []}});
const wait = async fn => {
  for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(fn(), 'condition completed');
};
function fakeRunner() {
  const calls = [];
  const tasks = new BackgroundTasks({db, run(role, opts) {
    return new Promise((resolve, reject) => {
      const call = {role, opts, resolve: text => resolve({text, sessionId: `session-${calls.length}`}), reject};
      calls.push(call);
      opts.onEvent({kind: 'init', sessionId: `init-${calls.length}`});
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted /private/run/internal'), {code: 'ABORTED'})), {once: true});
    });
  }});
  liveRunners.push(tasks);
  return {tasks, calls};
}
function request(url, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(data ? [Buffer.from(data)] : []);
  Object.assign(req, {url, method: body === undefined ? 'GET' : 'POST', headers: {host: config.host, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), ...headers}, socket: {remoteAddress: '127.0.0.1', localPort: config.port}});
  return req;
}
async function invoke(handler, url, body, headers, change = () => {}) {
  const req = request(url, body, headers), chunks = [];
  const res = new Writable({write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); }});
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = () => {};
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headersSent = true; return res; };
  change(req);
  await handler(req, res);
  await new Promise(r => { if (res.writableFinished) r(); else res.once('finish', r); });
  const text = Buffer.concat(chunks).toString('utf8');
  let json; try { json = JSON.parse(text); } catch {}
  return {status: res.statusCode, json, text};
}
const rpc = (handler, env, input) => invoke(handler, '/internal/tasks', input, {'x-chat-token': env.MASTAN_ME_CHAT_TOKEN});
const started = (tasks, context, title = 'Invented report', brief = 'Read the invented file and write a report.') => tasks.start(context, {title, brief});
const finished = tasks => wait(() => !tasks.running.size && !tasks.contexts.size);

test.beforeEach(() => {
  for (const table of ['bg_task_notes', 'bg_tasks', 'web_messages', 'web_threads', 'chats']) db.exec(`DELETE FROM ${table}`);
  delete process.env.MASTAN_ME_TASKS;
});
test.afterEach(async () => {
  for (const tasks of liveRunners.splice(0)) {
    tasks.shutdown();
    await Promise.all([...tasks.running.values()].map(s => s.promise));
  }
  for (const c of credentials.splice(0)) c.revoke();
});
test.after(() => rmSync(dir, {recursive: true, force: true}));

test('chat-token task RPC starts at once, lists only its chat, refuses forged destinations and operator credentials', async () => {
  const {tasks, calls} = fakeRunner(), a = tg(), b = tg('888');
  const handler = createInternal({config, db, tasks});
  const ea = credential(a), eb = credential(b);
  const out = await rpc(handler, ea, {action: 'start', title: 'Alpha', brief: 'A complete invented brief.'});
  assert.equal(out.status, 200); assert.equal(out.json.status, 'running');
  assert.equal(calls.length, 1);
  assert.equal((await rpc(handler, ea, {action: 'list'})).json.tasks[0].title, 'Alpha');
  assert.deepEqual((await rpc(handler, eb, {action: 'list'})).json.tasks, []);
  assert.equal((await rpc(handler, eb, {action: 'stop', id: out.json.id})).json.error, 'Task not found.');
  assert.equal((await rpc(handler, eb, {action: 'start', retry: out.json.id})).json.error, 'Task not found.');
  assert.equal((await rpc(handler, ea, {action: 'start', title: 'Bad', brief: 'Invented', chat_id: '888'})).json.status, 'failed');
  const op = createHash('sha256').update(config.sessionSecret + ':internal').digest('hex');
  assert.equal((await invoke(handler, '/internal/tasks', {action: 'list'}, {'x-internal-token': op})).status, 404);
  assert.equal((await invoke(handler, '/internal/notify', {text: 'invented'}, {'x-chat-token': ea.MASTAN_ME_CHAT_TOKEN})).status, 404);
  assert.equal((await invoke(handler, '/internal/tasks', {action: 'list'}, {'x-chat-token': ea.MASTAN_ME_CHAT_TOKEN, 'x-real-ip': '127.0.0.1'})).status, 404);
  assert.equal((await invoke(handler, '/internal/tasks', {action: 'list'}, {'x-chat-token': ea.MASTAN_ME_CHAT_TOKEN}, req => { req.socket.remoteAddress = '203.0.113.1'; })).status, 404);
  calls[0].resolve('Alpha ready.'); await finished(tasks);
  assert.match(a.simulation.calls.at(-1).text, /^Done: Alpha\nAlpha ready\./);
  assert.deepEqual(b.simulation.calls, []);
});

test('two tasks per user across chats, an independent user, and FIFO queue promotion', async () => {
  const {tasks, calls} = fakeRunner(), a = tg(), b = tg('888');
  const operator = {...tg('777'), user: 'operator'};
  const one = started(tasks, a, 'One'), two = started(tasks, b, 'Two');
  const three = started(tasks, a, 'Three'), four = started(tasks, b, 'Four');
  const other = started(tasks, operator, 'Operator');
  assert.equal(one.status, 'running'); assert.equal(two.status, 'running');
  assert.equal(three.status, 'queued'); assert.equal(four.status, 'queued'); assert.equal(other.status, 'running');
  assert.equal(calls.length, 3);
  calls[1].resolve('Two done.');
  await wait(() => calls.length === 4);
  assert.equal(tasks.owned(a, three.id).status, 'running'); assert.equal(tasks.owned(b, four.id).status, 'queued');
  assert.equal(calls[3].opts.chat.chatId, a.chatId);
  calls[0].resolve('One done.'); await wait(() => calls.length === 5);
  assert.equal(tasks.owned(b, four.id).status, 'running');
  calls[2].resolve('Other done.'); calls[3].resolve('Three done.'); calls[4].resolve('Four done.');
  await finished(tasks);
});

test('a task is a one-shot main call with its own system, user context, send token and no nested starts or retries', async () => {
  const {tasks, calls} = fakeRunner(), context = tg();
  const handler = createInternal({config, db, tasks});
  const out = started(tasks, context);
  const {role, opts} = calls[0];
  assert.equal(role, 'main'); assert.equal(opts.sessionKey, undefined); assert.equal(opts.resume, undefined);
  assert.equal(opts.cwd, config.workspace); assert.equal(opts.mcp, 'main'); assert.equal(opts.timeoutMs, 3600_000);
  assert.equal(opts.chat.user, context.user); assert.equal(opts.chat.simulation, context.simulation);
  assert.equal(opts.chat.kind, 'task'); assert.equal(opts.chat.taskId, out.id);
  const system = readFileSync(opts.systemFile, 'utf8');
  assert.match(system, /^Invented soul\./); assert.match(system, /## Background task/); assert.match(system, /at most 8 lines/);
  const env = credential(opts.chat);
  assert.equal(chatForToken(env.MASTAN_ME_CHAT_TOKEN).kind, 'task');
  assert.equal((await rpc(handler, env, {action: 'start', title: 'Nested', brief: 'Do work.'})).json.status, 'unavailable');
  assert.equal((await rpc(handler, env, {action: 'start', retry: out.id})).json.status, 'unavailable');
  const sent = await invoke(handler, '/internal/send-file', {path: source}, {'x-chat-token': env.MASTAN_ME_CHAT_TOKEN});
  assert.equal(sent.json.status, 'sent'); assert.equal(context.simulation.calls[0].method, 'sendDocument');
  calls[0].resolve(Array.from({length: 10}, (_, n) => `Line ${n}`).join('\n')); await finished(tasks);
  assert.equal(tasks.owned(context, out.id).result.split('\n').length, 8);
  assert.equal(tasks.owned(context, out.id).session_id, 'session-1');
});

test('failed and stopped paths post short safe text, queued stop never runs, and retry keeps the stored brief', async () => {
  const {tasks, calls} = fakeRunner(), context = tg(), handler = createInternal({config, db, tasks}), env = credential(context);
  const failed = started(tasks, context, 'Failed report', 'Every invented detail.');
  const running = started(tasks, context, 'Stopped report'), queued = started(tasks, context, 'Queued report');
  const stopQueued = await rpc(handler, env, {action: 'stop', id: queued.id}); assert.equal(stopQueued.json.status, 'stopped');
  calls[0].reject(new Error('stack at /var/lib/mastan-me/run/system.md\nsecret invented'));
  await wait(() => tasks.owned(context, failed.id).status === 'failed');
  const stopRunning = await rpc(handler, env, {action: 'stop', id: running.id}); assert.equal(stopRunning.json.status, 'stopped');
  await finished(tasks);
  assert.equal(calls.length, 2);
  const text = context.simulation.calls.map(c => c.text).join('\n');
  assert.match(text, /Failed: Failed report/); assert.match(text, /Stopped: Stopped report/); assert.match(text, /Stopped: Queued report/);
  assert.doesNotMatch(text, /\/run\/|stack|secret|\/var\/lib/);
  const retry = await rpc(handler, env, {action: 'start', retry: failed.id});
  assert.notEqual(retry.json.id, failed.id); assert.equal(calls.at(-1).opts.prompt, 'Every invented detail.');
  assert.equal(tasks.owned(context, retry.json.id).title, 'Failed report');
  calls.at(-1).resolve('Retried.'); await finished(tasks);
});

test('completion notes prepend the next successful main turn once, retain failures and keep notes finishing mid-turn', async () => {
  const {tasks, calls} = fakeRunner(), context = tg();
  const first = started(tasks, context, 'Deck'); calls[0].resolve('Look at slide 3.'); await finished(tasks);
  const original = providers['claude-cli'];
  const a = atlas(), commit = a.commit;
  a.commit = () => {};
  const prompts = []; let fail = true, release;
  providers['claude-cli'] = {async run(opts) {
    prompts.push(opts.prompt);
    if (fail) throw new Error('Invented main failure');
    if (prompts.length === 2) await new Promise(r => { release = r; });
    return {text: 'Reply.', sessionId: 'main-fake', exitCode: 0};
  }};
  try {
    const agent = new Agent();
    await assert.rejects(agent.turn({channel: context.channel, chatId: context.chatId, text: 'change slide 3'}));
    fail = false;
    const turn = agent.turn({channel: context.channel, chatId: context.chatId, text: 'change slide 3'});
    await wait(() => release);
    const second = started(tasks, context, 'Another'); calls.at(-1).resolve('Another result.'); await finished(tasks);
    release(); await turn;
    const pattern = new RegExp(`^\\[Background task ${first.id} "Deck" done at .* Riyadh: Look at slide 3\\.\\]\\n\\[`);
    assert.match(prompts[0], pattern); assert.match(prompts[1], pattern);
    await agent.turn({channel: context.channel, chatId: context.chatId, text: 'follow up'});
    assert.doesNotMatch(prompts[2], /"Deck"/); assert.match(prompts[2], new RegExp(`Background task ${second.id} "Another"`));
    await agent.turn({channel: context.channel, chatId: context.chatId, text: 'next'});
    assert.doesNotMatch(prompts[3], /Background task/);
  } finally { providers['claude-cli'] = original; a.commit = commit; }
});

test('running and queued tasks fail on restart once, never resume, and simulated restarts remain captured', async () => {
  const {tasks} = fakeRunner(), context = tg();
  const ids = ['One', 'Two', 'Three'].map(title => started(tasks, context, title).id);
  tasks.shutdown(); await Promise.all([...tasks.running.values()].map(s => s.promise));
  let runs = 0;
  const restart = new BackgroundTasks({db, run: () => { runs++; throw new Error('Must not resume'); }});
  liveRunners.push(restart);
  const stores = ids.map(id => restart.context(db.prepare('SELECT * FROM bg_tasks WHERE id=?').get(id)).simulation);
  await restart.recover();
  assert.equal(runs, 0);
  for (let n = 0; n < ids.length; n++) {
    const row = restart.owned(context, ids[n]);
    assert.equal(row.status, 'failed'); assert.equal(row.error, 'service restarted');
    assert.equal(stores[n].calls.length, 1);
    assert.equal(stores[n].calls[0].text, `Interrupted by a restart: ${row.title}. Say "retry ${row.id}" to run it again.`);
    assert.equal(db.prepare('SELECT note FROM bg_task_notes WHERE task_id=?').get(row.id).note.includes('service restarted'), true);
  }
  await restart.recover(); assert.ok(stores.every(s => s.calls.length === 1));
});

test('web completion stays in its thread, carries a task marker and sends files separately from a running main reply', async () => {
  const {tasks, calls} = fakeRunner();
  const web = new WebChat({agent: {}, tasks}); tasks.web = web;
  const thread = web.createThread('owner', 'Alpha'), other = web.createThread('owner', 'Beta');
  const context = web.taskContext('owner', thread.id), events = [];
  web.on('event', ev => events.push(ev));
  const out = started(tasks, context, 'Web report');
  assert.equal(web.history('owner', {thread: thread.id}).thread.tasks[0].id, out.id);
  assert.equal(web.history('owner', {thread: other.id}).thread.tasks.length, 0);
  const mainId = Number(db.prepare("INSERT INTO web_messages(who,thread,role,status,created) VALUES('owner',?,'assistant','running',?)").run(thread.id, Date.now()).lastInsertRowid);
  web.live.set(thread.id, {who: 'owner', id: mainId, text: 'Main reply', started: Date.now()});
  const handler = createInternal({config, db, tasks, chat: web});
  const env = credential(calls[0].opts.chat);
  const sent = await invoke(handler, '/internal/send-file', {path: source}, {'x-chat-token': env.MASTAN_ME_CHAT_TOKEN});
  assert.equal(sent.json.status, 'sent');
  assert.deepEqual(web.row(mainId).files, []);
  assert.equal(events.find(e => e.type === 'artifact').message.task, out.id);
  calls[0].resolve('Web report ready.'); await finished(tasks);
  const rows = web.history('owner', {thread: thread.id}).messages;
  assert.equal(rows.at(-1).task, out.id); assert.match(rows.at(-1).text, /^Done: Web report/);
  assert.equal(web.live.has(thread.id), true); assert.equal(web.row(mainId).status, 'running');
  assert.equal(web.history('owner', {thread: other.id}).messages.length, 0);
  assert.equal(web.history('operator').messages.length, 0);
  assert.equal(events.filter(e => e.type === 'task').length, 1);
  assert.equal(events.filter(e => e.type === 'tasks').at(-1).tasks.length, 0);
});

test('restart posts one marked failure in each original web thread without resuming queued work', async () => {
  const {tasks} = fakeRunner(), web = new WebChat({agent: {}, tasks}); tasks.web = web;
  const a = web.createThread('owner', 'Alpha'), b = web.createThread('owner', 'Beta');
  const rows = [started(tasks, web.taskContext('owner', a.id), 'One'), started(tasks, web.taskContext('owner', a.id), 'Two'), started(tasks, web.taskContext('owner', b.id), 'Three')];
  assert.equal(rows[2].status, 'queued');
  tasks.shutdown(); await Promise.all([...tasks.running.values()].map(s => s.promise));
  const restart = new BackgroundTasks({db, run() { throw new Error('Must not resume'); }}); restart.web = web;
  liveRunners.push(restart);
  await restart.recover(); await restart.recover();
  assert.equal(web.history('owner', {thread: a.id}).messages.length, 2);
  const message = web.history('owner', {thread: b.id}).messages[0];
  assert.equal(message.task, rows[2].id); assert.equal(message.status, 'failed');
  assert.equal(message.text, `Interrupted by a restart: Three. Say "retry ${rows[2].id}" to run it again.`);
});

test('Telegram /tasks and /stop id bypass the main turn; plain /stop still stops it', async () => {
  const {tasks} = fakeRunner(), context = tg();
  const out = started(tasks, context, 'Telegram report'); let stops = 0;
  const telegram = new TelegramChannel({tasks, agent: {stop() { stops++; return true; }}});
  await sim.run(context.simulation, async () => {
    await telegram.command(context.chatId, '/tasks');
    await telegram.command(context.chatId, `/stop ${out.id}`);
    await telegram.command(context.chatId, '/stop');
  });
  await finished(tasks);
  assert.equal(stops, 1);
  assert.ok(context.simulation.calls.some(c => /Telegram report: running, 0 min/.test(c.text)));
  assert.ok(context.simulation.calls.some(c => c.text === 'Stopped: Telegram report'));
});

test('web typed task commands and chip stop route enforce thread and identity without running the main agent', async () => {
  const {tasks} = fakeRunner(); let mainStops = 0;
  const web = new WebChat({tasks, agent: {stop() { mainStops++; return true; }, turn() { throw new Error('Command called model'); }}}); tasks.web = web;
  const t = web.createThread('owner', 'Alpha'), other = web.createThread('owner', 'Beta');
  const context = web.taskContext('owner', t.id), out = started(tasks, context, 'Typed report');
  const session = auth.createSession(db, auth.OPERATOR), opCookie = `${COOKIE}=${session.value}`;
  auth.addCredential(db, {id: 'aW52ZW50ZWQtdGFzay1jcmVk', publicKey: new Uint8Array(40).fill(3), origin: 'local'});
  const owner = auth.createSession(db, 'aW52ZW50ZWQtdGFzay1jcmVk'), ownerCookie = `${COOKIE}=${owner.value}`;
  const handler = createWeb({config, db, chat: web, tasks});
  const streamRequest = request('/api/chat/stream', undefined, {cookie: ownerCookie});
  const chunks = [], streamResponse = new Writable({write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); }});
  streamResponse.setHeader = () => {};
  streamResponse.writeHead = () => streamResponse;
  try {
    await handler(streamRequest, streamResponse);
    const hello = Buffer.concat(chunks).toString('utf8');
    const snapshot = JSON.parse(hello.match(/event: hello\ndata: (.+)\n/)[1]);
    assert.equal(snapshot.tasks[t.id][0].id, out.id);
    assert.deepEqual(snapshot.tasks[other.id], []);
  } finally { streamRequest.emit('close'); streamResponse.end(); }
  const post = (body, cookie = ownerCookie, csrf = owner.csrf, url = '/api/chat/send') => invoke(handler, url, body, {cookie, origin: config.origin, 'x-csrf-token': csrf});
  const listed = await post({thread: t.id, text: '/tasks'}); assert.equal(listed.status, 200);
  assert.match(web.history('owner', {thread: t.id}).messages.at(-1).text, /Typed report: running/);
  assert.equal((await post({thread: other.id, task: out.id}, ownerCookie, owner.csrf, '/api/chat/stop')).json.stopped, false);
  assert.equal((await post({thread: t.id, task: out.id}, opCookie, session.csrf, '/api/chat/stop')).status, 404);
  assert.equal((await post({thread: t.id, task: out.id}, ownerCookie, 'bad', '/api/chat/stop')).status, 403);
  assert.equal((await post({thread: t.id, task: out.id}, ownerCookie, owner.csrf, '/api/chat/stop')).json.stopped, true);
  await finished(tasks);
  const next = started(tasks, context, 'Typed stop');
  await post({thread: t.id, text: `/stop ${next.id}`}); await finished(tasks);
  assert.equal(tasks.owned(context, next.id).status, 'stopped');
  await post({thread: t.id, text: '/stop'}); assert.equal(mainStops, 1);
  assert.match(readFileSync('src/web/session-routes.js', 'utf8'), /ev\.type === 'tasks'/);
  assert.match(readFileSync('src/web/chatclient/app.js', 'utf8'), /\/api\/chat\/stop/);
});

test('simulation waits for task result and file RPC after the main turn has returned; every send is captured', async () => {
  let handler, out;
  const tasks = new BackgroundTasks({db, async run(role, opts) {
    await new Promise(r => setTimeout(r, 30));
    const env = credential(opts.chat);
    const sent = await invoke(handler, '/internal/send-file', {path: source}, {'x-chat-token': env.MASTAN_ME_CHAT_TOKEN});
    assert.equal(sent.json.status, 'sent');
    await new Promise(r => setTimeout(r, 30));
    return {text: 'Simulated result.', sessionId: 'sim-task'};
  }}); liveRunners.push(tasks);
  const agent = {busy: () => false, busyCount: () => 0, async turn() {
    out = started(tasks, {user: 'owner', channel: 'telegram', chatId: '123', simulation: sim.getStore()}, 'Simulation');
    return {text: 'Running. Keep talking.', durationMs: 1};
  }};
  const telegram = new TelegramChannel({agent, tasks});
  handler = createInternal({config, db, tasks, telegram, agent});
  const op = createHash('sha256').update(config.sessionSecret + ':internal').digest('hex');
  const result = await invoke(handler, '/internal/telegram-sim', {chat_id: 123, text: 'Invented long work', until_tasks_done: true}, {'x-internal-token': op});
  assert.equal(result.status, 200); assert.equal(tasks.owned({user: 'owner', channel: 'telegram', chatId: '123'}, out.id).status, 'done');
  assert.ok(result.json.calls.some(c => c.method === 'sendDocument' && c.filename === 'invented.txt'));
  assert.ok(result.json.calls.some(c => /^Done: Simulation\nSimulated result\./.test(c.text)));
  assert.ok(result.json.calls.some(c => c.text === 'Running. Keep talking.'));
  assert.equal(tasks.busySimulation({calls: []}), false);
});

test('task disable switch removes main notes, refuses starts and retries, and keeps list and stop', async () => {
  const {tasks} = fakeRunner(), context = tg(), out = started(tasks, context);
  const agent = new Agent();
  assert.match(readFileSync(agent.systemFile('telegram'), 'utf8'), /mastan-me-task start/);
  process.env.MASTAN_ME_TASKS = 'off';
  assert.doesNotMatch(readFileSync(agent.systemFile('telegram'), 'utf8'), /mastan-me-task|background-tasks\/SKILL/);
  assert.doesNotMatch(readFileSync(agent.systemFile('web'), 'utf8'), /mastan-me-task/);
  assert.equal(started(tasks, context).status, 'unavailable');
  assert.equal(tasks.start(context, {retry: out.id}).status, 'unavailable');
  assert.equal(tasks.list(context).length, 1);
  assert.equal((await tasks.stop(context, out.id)).status, 'stopped'); await finished(tasks);
});

test('a simulated message queued behind another main turn keeps its own task capture context', async () => {
  const {tasks, calls} = fakeRunner(), a = {calls: []}, b = {calls: []};
  let busy = false, release, out;
  const agent = {busy: () => busy, async turn({text}) {
    busy = true;
    if (text === 'First') await new Promise(r => { release = r; });
    else out = started(tasks, {user: 'owner', channel: 'telegram', chatId: '999', simulation: sim.getStore()}, 'Queued simulation');
    busy = false;
    return {text: `Main ${text}`, durationMs: 1};
  }};
  const telegram = new TelegramChannel({agent, tasks, runBusy: async () => ({text: '{"reply":"I will take this next.","queue":true}'})});
  const first = sim.run(a, () => telegram.runTurn('999', 'First'));
  await wait(() => release);
  await sim.run(b, () => telegram.enqueue('999', 'Queued'));
  release(); await first;
  await wait(() => out);
  calls[0].resolve('Queued result.'); await finished(tasks);
  await wait(() => b.calls.some(c => c.text === 'Main Queued'));
  assert.ok(b.calls.some(c => /^Done: Queued simulation/.test(c.text)));
  assert.ok(!a.calls.some(c => /Queued result|Done: Queued simulation/.test(c.text)));
});

test('task CLI reads stdin, uses only loopback chat credentials, validates options and returns exit codes', async () => {
  const env = {MASTAN_ME_RPC: 'http://127.0.0.1:3100', MASTAN_ME_CHAT_TOKEN: 'invented-cli-context'};
  const calls = [];
  const request = async (url, opts) => { calls.push({url, opts}); return {ok: true, json: async () => ({status: 'queued', id: 42})}; };
  const opts = {env, request, stdin: Readable.from(['A complete ', 'invented brief.'])};
  assert.equal((await task(['start', '--title', 'CLI'], opts)).status, 'queued');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {action: 'start', title: 'CLI', brief: 'A complete invented brief.'});
  assert.equal(calls[0].url.pathname, '/internal/tasks'); assert.equal(calls[0].opts.headers['X-Chat-Token'], env.MASTAN_ME_CHAT_TOKEN);
  await task(['start', '--retry', '42'], {env, request}); assert.deepEqual(JSON.parse(calls.at(-1).opts.body), {action: 'start', retry: 42});
  await task(['stop', '42'], {env, request}); assert.deepEqual(JSON.parse(calls.at(-1).opts.body), {action: 'stop', id: 42});
  await task(['list'], {env, request}); assert.deepEqual(JSON.parse(calls.at(-1).opts.body), {action: 'list'});
  assert.equal((await task(['start', '--title', 'Big'], {env, request, stdin: Readable.from(['x'.repeat(20_001)])})).status, 'failed');
  assert.equal((await task(['stop', 'bad'], {env, request})).status, 'failed');
  assert.equal((await task(['list'], {env: {...env, MASTAN_ME_RPC: 'https://example.invalid'}, request})).status, 'failed');
  assert.equal((await task(['list'], {env: {}})).status, 'unavailable');
  const lost = await task(['list'], {env, request: async () => { throw new Error('lost'); }}); assert.match(lost.error, /List tasks/);
  const log = console.log; console.log = () => {};
  try {
    assert.equal(await main(['list'], {env, request}), 0);
    assert.equal(await main(['bad'], {env, request}), 1);
    assert.equal(await main(['list'], {env: {}}), 3);
  } finally { console.log = log; }
});

test('task input accepts 20,000 characters and rejects blank, oversized or malformed requests', async () => {
  const {tasks, calls} = fakeRunner(), context = tg();
  assert.equal(started(tasks, context, 'Max', 'x'.repeat(20_000)).status, 'running');
  for (const input of [{title: '', brief: 'x'}, {title: 'x'.repeat(121), brief: 'x'}, {title: 'x\ny', brief: 'x'}, {title: 'x', brief: ' '}, {title: 'x', brief: 'x'.repeat(20_001)}]) assert.equal(tasks.start(context, input).status, 'failed');
  assert.equal((await tasks.request(context, {action: 'unknown'})).status, 'failed');
  calls[0].resolve('x'.repeat(1600)); await finished(tasks);
  const note = db.prepare('SELECT note FROM bg_task_notes WHERE note IS NOT NULL').get().note;
  assert.equal(note.split('Riyadh: ')[1], 'x'.repeat(1200) + ']');
});

test('admin sim --wait-tasks sets the route wait option and a 60-minute default', async () => {
  const {commands} = await import('../src/admin/ops.js');
  const originalFetch = globalThis.fetch, log = console.log;
  let input;
  globalThis.fetch = async (url, opts) => { input = JSON.parse(opts.body); return {ok: true, json: async () => ({calls: []})}; };
  console.log = () => {};
  try {
    await commands.sim.run(['Invented long work', '--wait-tasks']);
    assert.equal(input.until_tasks_done, true); assert.equal(input.wait_ms, 3600_000);
    await commands.sim.run(['Invented long work', '4', '7', '--wait-tasks']);
    assert.equal(input.wait_ms, 4000); assert.equal(input.reply_to, 7);
  } finally { globalThis.fetch = originalFetch; console.log = log; }
});
