// Invented schedules, fake clocks/providers and in-memory HTTP. No network or real deliveries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable, Writable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'mm-schedules-'));
process.env.MASTAN_ME_DATA = dir;
process.env.AGENT_HOME = join(dir, 'home');
process.env.OWNER_TELEGRAM_ID = '999';
process.env.SESSION_SECRET = 'invented-schedule-service';
process.env.MASTAN_ME_BROWSER = 'off';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_TOKEN_FILE;
delete process.env.CREDENTIALS_DIRECTORY;
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {Schedules, pendingScheduleNotes} = await import('../src/agent/schedules.js');
const {BackgroundTasks} = await import('../src/agent/tasks.js');
const {Agent} = await import('../src/agent/runner.js');
const {providers} = await import('../src/providers/index.js');
const {atlas} = await import('../src/atlas/store.js');
const {chatCredentials, chatForToken} = await import('../src/chat-tokens.js');
const {createInternal} = await import('../src/internal.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const {TelegramChannel} = await import('../src/channels/telegram.js');
const {sim, viaHttps} = await import('../src/channels/telegram-api.js');
const {schedule, main} = await import('../src/schedule-cli.js');
const db = openDb(), runners = [], credentials = [];
mkdirSync(config.workspace, {recursive: true});
writeFileSync(join(config.workspace, 'SOUL.md'), 'Invented soul.');
writeFileSync(join(config.workspace, 'invented.txt'), 'Invented check evidence.');
const chat = (chatId = '999', user = 'owner') => ({user, channel: 'telegram', chatId});
const wait = async fn => {
  for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(fn(), 'condition completed');
};
const finished = tasks => wait(() => !tasks.running.size && !tasks.contexts.size);
const credential = context => { const c = chatCredentials(context); credentials.push(c); return c.env.MASTAN_ME_CHAT_TOKEN; };
function setup({send} = {}) {
  let time = Date.parse('2026-10-27T06:00:00Z');
  const calls = [], sent = [];
  const tasks = new BackgroundTasks({db, run(role, opts) {
    return new Promise((resolve, reject) => {
      calls.push({role, opts, resolve: text => resolve({text, sessionId: 'invented-session'}), reject});
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {code: 'ABORTED'})), {once: true});
    });
  }});
  runners.push(tasks);
  const schedules = new Schedules({db, tasks, now: () => time, send: send || (async (chatId, text, extra) => { sent.push({chatId, text, extra}); return [{message_id: sent.length}]; })});
  return {schedules, tasks, calls, sent, now: () => time, advance: n => { time += n; }};
}
async function add(s, input = {}, context = chat()) {
  const out = await s.request(context, {action: 'add', kind: 'reminder', title: 'Invented reminder', in: '15m', ...input});
  assert.equal(out.status, 'ok', out.error);
  return out.id;
}
const check = (s, input = {}, context = chat()) => add(s, {kind: 'check', title: 'Invented check', brief: 'Read the invented source and report a meaningful change.', in: undefined, at: 'now', repeat: 'every 30m', ...input}, context);
const runs = id => db.prepare('SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY id').all(id);
async function invoke(handler, url, body, headers = {}, change = () => {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]), parts = [];
  Object.assign(req, {url, method: 'POST', headers, socket: {remoteAddress: '127.0.0.1'}});
  change(req);
  const res = new Writable({write(c, enc, cb) { parts.push(Buffer.from(c)); cb(); }});
  res.writeHead = status => { res.statusCode = status; return res; };
  await handler(req, res);
  return {status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString('utf8'))};
}
const rpc = (handler, token, input, change) => invoke(handler, '/internal/schedules', input, {'x-chat-token': token}, change);

test.beforeEach(() => {
  for (const table of ['schedule_notes', 'schedule_runs', 'schedules', 'bg_task_notes', 'bg_tasks', 'web_messages', 'web_threads', 'chats', 'kv', 'artifacts']) db.exec(`DELETE FROM ${table}`);
  delete process.env.MASTAN_ME_SCHEDULES;
  delete process.env.MASTAN_ME_TASKS;
});
test.afterEach(async () => {
  for (const tasks of runners.splice(0)) { tasks.shutdown(); await Promise.all([...tasks.running.values()].map(s => s.promise)); }
  for (const c of credentials.splice(0)) c.revoke();
});
test.after(() => rmSync(dir, {recursive: true, force: true}));

test('two simultaneous ticks claim once before delivery; reminders use captured Telegram text and have sound', async () => {
  const f = setup(), id = await add(f.schedules, {title: 'Pay invented bill', text: 'Use the invented reference.'});
  assert.equal(f.schedules.schedule(id).tz, 'Asia/Riyadh');
  f.advance(15 * 60_000);
  await Promise.all([f.schedules.tick(), f.schedules.tick()]);
  assert.equal(runs(id).length, 1); assert.equal(runs(id)[0].state, 'sent');
  assert.deepEqual(f.sent, [{chatId: '999', text: 'Reminder: Pay invented bill\nUse the invented reference.', extra: {disable_notification: false}}]);
  assert.equal(f.schedules.schedule(id).status, 'done'); assert.equal(f.schedules.schedule(id).runs, 1);
  assert.equal(f.calls.length, 0);
  assert.match(pendingScheduleNotes(db, 'telegram', '999')[0].note, new RegExp(`^\\[Reminder ${id} "Pay invented bill" sent at .* Riyadh\\]$`));
});

test('restart delivers claimed once, marks sending uncertain, and downtime skips three missed slots with one late delivery', async () => {
  const f = setup(), a = await add(f.schedules), b = await add(f.schedules), c = await add(f.schedules, {repeat: 'every 15m'});
  f.advance(15 * 60_000);
  f.schedules.claim(a); const sending = f.schedules.claim(b);
  db.prepare("UPDATE schedule_runs SET state='sending' WHERE id=?").run(sending.id);
  f.advance(45 * 60_000);
  const restart = new Schedules({db, tasks: f.tasks, now: f.now, send: async (chatId, text) => f.sent.push({chatId, text})});
  await restart.recover(); await restart.recover();
  assert.equal(f.sent.length, 2); assert.equal(runs(a)[0].state, 'sent');
  assert.equal(runs(b)[0].state, 'uncertain'); assert.equal(runs(c).length, 1);
  assert.match(f.sent[1].text, /\(late, was due 09:15\)/);
  assert.equal(restart.schedule(c).next_run, f.now() + 15 * 60_000);
  assert.equal(restart.schedule(c).runs, 1);
});

test('Telegram errors retry in one-minute steps, stop after three attempts, and written lost responses never retry', async () => {
  let attempts = 0;
  const f = setup({send: async () => { attempts++; throw Object.assign(new Error('invented refusal content must not be saved'), {status: 429}); }});
  const id = await add(f.schedules); f.advance(15 * 60_000); await f.schedules.tick();
  assert.equal(attempts, 1); assert.equal(runs(id)[0].state, 'failed');
  f.advance(59_000); await f.schedules.tick(); assert.equal(attempts, 1);
  f.advance(1000); await f.schedules.tick(); assert.equal(attempts, 2);
  f.advance(60_000); await f.schedules.tick(); assert.equal(attempts, 3);
  f.advance(60_000); await f.schedules.tick(); assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(runs(id)[0].detail), {attempts: 3});
  assert.equal(pendingScheduleNotes(db, 'telegram', '999').length, 0);
  f.schedules.send = async () => { attempts++; throw Object.assign(new Error('lost'), {bodyWritten: true}); };
  const lost = await add(f.schedules); f.advance(15 * 60_000); await f.schedules.tick();
  assert.equal(runs(lost)[0].state, 'uncertain');
  f.advance(60_000); await f.schedules.recover(); assert.equal(attempts, 4);
});

test('a definite refusal can recover on the next attempt and leaves only one delivered note', async () => {
  let tries = 0;
  const f = setup({send: async () => { if (++tries === 1) throw Object.assign(new Error('refused'), {status: 500}); return [{message_id: 1}]; }});
  const id = await add(f.schedules); f.advance(15 * 60_000); await f.schedules.tick();
  f.advance(60_000); await f.schedules.tick(); await f.schedules.tick();
  assert.equal(tries, 2); assert.equal(runs(id)[0].state, 'sent');
  assert.equal(pendingScheduleNotes(db, 'telegram', '999').length, 1);
});

test('web reminders are marked schedule posts in the right thread and typed /schedules bypasses the agent', async () => {
  const f = setup(), web = new WebChat({agent: {turn() { throw new Error('must not run'); }}, tasks: f.tasks, schedules: f.schedules});
  f.schedules.web = web;
  const a = web.createThread('owner', 'Invented alpha'), b = web.createThread('owner', 'Invented beta');
  const id = await add(f.schedules, {}, web.taskContext('owner', a.id)), events = [];
  web.on('event', ev => events.push(ev));
  await web.send('owner', {thread: a.id, text: '/schedules'});
  assert.match(web.history('owner', {thread: a.id}).messages.at(-1).text, new RegExp(`${id}\\. reminder: Invented reminder`));
  f.advance(15 * 60_000); await f.schedules.tick();
  const row = web.history('owner', {thread: a.id}).messages.at(-1);
  assert.equal(row.schedule, id); assert.match(row.text, /^Reminder:/);
  assert.equal(web.history('owner', {thread: b.id}).messages.length, 0);
  assert.equal(web.history('operator').messages.length, 0);
  assert.equal(events.filter(e => e.type === 'schedule').length, 1);
  const checkId = await check(f.schedules, {}, web.taskContext('owner', b.id));
  await f.schedules.tick(); f.calls[0].resolve('Invented web change.'); await finished(f.tasks);
  const changed = web.history('owner', {thread: b.id}).messages.at(-1);
  assert.equal(changed.schedule, checkId); assert.equal(changed.task, undefined);
  assert.match(changed.text, /^Check: Invented check\nInvented web change\./);
  const telegram = new TelegramChannel({agent: {}, schedules: f.schedules});
  const store = {calls: []};
  await sim.run(store, () => telegram.command('999', '/schedules'));
  assert.match(store.calls[0].text, /^No active or paused/);
});

test('checks use the task queue, own context, task credentials, 15-minute timeout and previous summary without Done posts', async () => {
  const f = setup(), id = await check(f.schedules, {brief: 'x'.repeat(20_000)});
  await f.schedules.tick();
  const opts = f.calls[0].opts;
  assert.equal(opts.timeoutMs, 15 * 60_000); assert.equal(opts.mcp, 'main'); assert.equal(opts.cwd, config.workspace);
  assert.equal(opts.chat.user, 'owner'); assert.equal(opts.chat.chatId, '999'); assert.equal(opts.chat.kind, 'task');
  assert.equal(chatForToken(credential(opts.chat)).kind, 'task');
  assert.match(opts.prompt, /Previous result \(.* Riyadh\): none, this is the first run$/);
  assert.match(readFileSync(opts.systemFile, 'utf8'), /scheduled check.*NO_CHANGE/);
  f.calls[0].resolve('NO_CHANGE\nThe invented value is still 17.'); await finished(f.tasks);
  assert.equal(runs(id)[0].state, 'quiet'); assert.equal(f.sent.length, 0);
  assert.equal(f.schedules.schedule(id).last_result, 'The invented value is still 17.');
  assert.equal(pendingScheduleNotes(db, 'telegram', '999').length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM bg_task_notes WHERE note IS NOT NULL').get().n, 0);
  f.advance(30 * 60_000); await f.schedules.tick();
  assert.match(f.calls[1].opts.prompt, /Previous result \(2026-10-27 09:00 Riyadh\): The invented value is still 17\.$/);
  f.calls[1].resolve('Invented value changed to 19.\nSecond line.\n3\n4\n5\n6\n7\n8\n9'); await finished(f.tasks);
  assert.equal(runs(id)[1].state, 'posted'); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /^Check: Invented check\nInvented value changed to 19\./);
  assert.equal(f.sent[0].text.split('\n').length, 9); assert.doesNotMatch(f.sent[0].text, /Done:/);
  assert.match(pendingScheduleNotes(db, 'telegram', '999')[0].note, /Check .*Invented value changed/);
});

test('previous results are capped at 1,200 prompt characters and check follow-up notes at 600 characters', async () => {
  const f = setup(), id = await check(f.schedules);
  db.prepare('UPDATE schedules SET last_result=?,last_run=? WHERE id=?').run('x'.repeat(1500), f.now(), id);
  await f.schedules.tick();
  assert.equal(f.calls[0].opts.prompt.split('Previous result (2026-10-27 09:00 Riyadh): ')[1], 'x'.repeat(1200));
  f.calls[0].resolve('y'.repeat(900)); await finished(f.tasks);
  assert.equal(f.schedules.schedule(id).last_result.length, 900);
  assert.equal(pendingScheduleNotes(db, 'telegram', '999')[0].note.split('Riyadh: ')[1], 'y'.repeat(600) + ']');
});

test('checks share the per-user cap of two; both queued and running checks skip overlapping firings', async () => {
  const f = setup();
  f.tasks.start(chat(), {title: 'Ordinary one', brief: 'Invented work.'});
  f.tasks.start(chat('888'), {title: 'Ordinary two', brief: 'Invented work.'});
  const id = await check(f.schedules); await f.schedules.tick();
  assert.equal(f.calls.length, 2); assert.equal(f.tasks.owned(chat(), runs(id)[0].task_id).status, 'queued');
  f.advance(30 * 60_000); await f.schedules.tick(); assert.equal(runs(id)[1].state, 'skipped');
  f.calls[0].resolve('Ordinary done.'); await wait(() => f.calls.length === 3);
  assert.equal(f.calls[2].opts.chat.taskId, runs(id)[0].task_id);
  f.advance(30 * 60_000); await f.schedules.tick(); assert.equal(runs(id)[2].state, 'skipped');
  f.calls[1].resolve('Ordinary two done.'); f.calls[2].resolve('NO_CHANGE\nStill the same.'); await finished(f.tasks);
});

test('three consecutive failures pause and notify once; a successful run resets failures; resume clears the count', async () => {
  const f = setup(), id = await check(f.schedules);
  await f.schedules.tick(); f.calls[0].reject(new Error('private source content')); await finished(f.tasks);
  assert.equal(f.schedules.schedule(id).fails, 1); assert.equal(f.sent.length, 0);
  f.advance(30 * 60_000); await f.schedules.tick(); f.calls[1].resolve('NO_CHANGE\nStill 17.'); await finished(f.tasks);
  assert.equal(f.schedules.schedule(id).fails, 0);
  for (let n = 0; n < 3; n++) {
    f.advance(30 * 60_000); await f.schedules.tick();
    f.calls.at(-1).reject(Object.assign(new Error('secret invented stack'), {code: n === 2 ? 'TIMEOUT' : 'ERROR'})); await finished(f.tasks);
  }
  assert.equal(f.schedules.schedule(id).status, 'paused'); assert.equal(f.schedules.schedule(id).fails, 3);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, `Paused check ${id} "Invented check" after 3 failed runs: timed out. Say "resume ${id}" to start it again.`);
  await f.schedules.tick(); await f.tasks.recover(); assert.equal(f.sent.length, 1);
  assert.equal((await f.schedules.request(chat(), {action: 'resume', id})).status, 'ok');
  assert.equal(f.schedules.schedule(id).fails, 0);
});

test('check posts and pause notices respect quiet hours while reminders retain sound', async () => {
  const f = setup(); f.advance(15 * 3600_000); // midnight in Riyadh
  const id = await check(f.schedules); await f.schedules.tick();
  f.calls[0].resolve('Invented change.'); await finished(f.tasks);
  assert.equal(f.sent[0].extra.disable_notification, true);
  await add(f.schedules); f.advance(15 * 60_000); await f.schedules.tick();
  assert.equal(f.sent[1].extra.disable_notification, false);
  db.prepare('INSERT INTO kv VALUES(?,?,?)').run('quiet:owner', JSON.stringify({from: '08:00', to: '10:00'}), f.now());
  f.advance(9 * 3600_000); await f.schedules.tick();
  f.calls.at(-1).resolve('Another change.'); await finished(f.tasks);
  assert.equal(f.sent.at(-1).extra.disable_notification, true);
  assert.equal(f.schedules.schedule(id).fails, 0);
});

test('times and inclusive until mark schedules done after the last firing, without replaying downtime', async () => {
  const f = setup(), a = await add(f.schedules, {repeat: 'every 15m', times: 2});
  const b = await add(f.schedules, {at: '2026-10-27 23:59', in: undefined, repeat: 'daily 23:59', until: '2026-10-27'});
  f.advance(15 * 60_000); await f.schedules.tick(); assert.equal(f.schedules.schedule(a).status, 'active');
  f.advance(15 * 60_000); await f.schedules.tick(); assert.equal(f.schedules.schedule(a).status, 'done');
  f.advance(24 * 3600_000); await f.schedules.tick();
  assert.equal(f.schedules.schedule(b).status, 'done'); assert.equal(runs(b).length, 1);
  assert.equal((await f.schedules.request(chat(), {action: 'resume', id: a})).status, 'failed');
  assert.equal((await f.schedules.request(chat(), {action: 'resume', id: b})).status, 'failed');
});

test('50 active schedules and 10 checks are per-user caps, and resume enforces them too', async () => {
  const f = setup();
  const paused = await add(f.schedules); await f.schedules.request(chat(), {action: 'pause', id: paused});
  for (let n = 0; n < 50; n++) await add(f.schedules);
  assert.match((await f.schedules.request(chat('888'), {action: 'add', kind: 'reminder', title: 'Extra', in: '1h'})).error, /50 active/);
  assert.match((await f.schedules.request(chat(), {action: 'resume', id: paused})).error, /50 active/);
  const other = chat('777', 'operator');
  for (let n = 0; n < 10; n++) await check(f.schedules, {at: '10:00'}, other);
  assert.match((await f.schedules.request(other, {action: 'add', kind: 'check', title: 'Extra', brief: 'Invented.', in: '1h'})).error, /10 active checks/);
  const row = f.schedules.list(other)[0];
  await f.schedules.request(other, {action: 'pause', id: row.id});
  await check(f.schedules, {at: '10:00'}, other);
  assert.match((await f.schedules.request(other, {action: 'resume', id: row.id})).error, /10 active checks/);
});

test('48 check runs per user per local day skip later firings, notify once, and reset the next day', async () => {
  const f = setup(), id = await check(f.schedules);
  for (let n = 0; n < 48; n++) {
    await f.schedules.request(chat(), {action: 'run', id});
    f.calls.at(-1).resolve('NO_CHANGE\nStill 17.'); await finished(f.tasks); f.advance(1000);
  }
  for (let n = 0; n < 2; n++) { await f.schedules.request(chat(), {action: 'run', id}); f.advance(1000); }
  assert.equal(f.calls.length, 48); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /48 check runs/); assert.equal(runs(id).filter(r => r.state === 'skipped').length, 2);
  f.advance(24 * 3600_000); await f.schedules.tick();
  assert.equal(f.calls.length, 49); f.calls.at(-1).resolve('NO_CHANGE\nStill 17.'); await finished(f.tasks);
});

test('tokens isolate user and chat, task tokens only list, operator credentials and X-Real-IP are refused', async () => {
  const f = setup(), handler = createInternal({config, db, tasks: f.tasks, schedules: f.schedules});
  const a = credential(chat()), b = credential(chat('888')), other = credential(chat('999', 'operator'));
  const out = await rpc(handler, a, {action: 'add', kind: 'reminder', title: 'Private invented reminder', at: '10:00'});
  const id = out.json.id;
  assert.equal(out.json.next_run_local, '2026-10-27 10:00 Riyadh');
  assert.equal((await rpc(handler, a, {action: 'list'})).json.schedules.length, 1);
  assert.deepEqual((await rpc(handler, b, {action: 'list'})).json.schedules, []);
  assert.deepEqual((await rpc(handler, other, {action: 'list'})).json.schedules, []);
  for (const action of ['pause', 'resume', 'delete', 'run']) assert.equal((await rpc(handler, b, {action, id})).json.error, 'Schedule not found.');
  const task = credential({...chat(), kind: 'task'});
  assert.equal((await rpc(handler, task, {action: 'list'})).json.schedules.length, 1);
  for (const action of ['add', 'pause', 'resume', 'delete', 'run']) assert.equal((await rpc(handler, task, {action, ...(action === 'add' ? {kind: 'reminder', title: 'Nested', in: '1h'} : {id})})).json.status, 'unavailable');
  const op = createHash('sha256').update(config.sessionSecret + ':internal').digest('hex');
  assert.equal((await invoke(handler, '/internal/schedules', {action: 'list'}, {'x-internal-token': op})).status, 404);
  assert.equal((await rpc(handler, a, {action: 'list'}, req => { req.headers['x-real-ip'] = '127.0.0.1'; })).status, 404);
  assert.equal((await rpc(handler, a, {action: 'list'}, req => { req.socket.remoteAddress = '192.0.2.1'; })).status, 404);
  assert.equal((await rpc(handler, a, {action: 'add', kind: 'reminder', title: 'Forged', in: '1h', chat_id: '888'})).json.status, 'failed');
  await rpc(handler, a, {action: 'pause', id});
  await rpc(handler, a, {action: 'run', id});
  assert.equal(f.sent.length, 1); assert.equal(f.schedules.schedule(id).status, 'done');
  await rpc(handler, a, {action: 'delete', id});
  assert.equal(f.schedules.schedule(id).status, 'deleted'); assert.equal(runs(id).length, 1);
});

test('last five reminder/check notes reach a successful main turn once, retain failures and notes arriving mid-turn', async () => {
  const f = setup();
  for (let n = 0; n < 6; n++) {
    const id = await add(f.schedules, {title: `Invented ${n}`});
    await f.schedules.request(chat(), {action: 'run', id});
  }
  const id = await check(f.schedules); await f.schedules.tick(); f.calls[0].resolve('The invented value changed.'); await finished(f.tasks);
  const notes = pendingScheduleNotes(db, 'telegram', '999');
  assert.equal(notes.length, 5); assert.doesNotMatch(notes.map(n => n.note).join('\n'), /Invented [01]/);
  const original = providers['claude-cli'], a = atlas(), commit = a.commit, prompts = [];
  a.commit = () => {};
  let fail = true, release;
  providers['claude-cli'] = {async run(opts) {
    prompts.push(opts.prompt);
    if (fail) throw new Error('Invented main failure');
    if (prompts.length === 2) await new Promise(r => { release = r; });
    return {text: 'Invented reply.', sessionId: 'invented-main', exitCode: 0};
  }};
  try {
    const agent = new Agent();
    await assert.rejects(agent.turn({channel: 'telegram', chatId: '999', text: 'What changed?'}));
    assert.equal(pendingScheduleNotes(db, 'telegram', '999').length, 5);
    fail = false;
    const turn = agent.turn({channel: 'telegram', chatId: '999', text: 'What changed?'}); await wait(() => release);
    const later = await add(f.schedules, {title: 'Arrived mid-turn'}); await f.schedules.request(chat(), {action: 'run', id: later});
    release(); await turn;
    assert.match(prompts[1], new RegExp(`Check ${id}.*The invented value changed`));
    assert.equal(pendingScheduleNotes(db, 'telegram', '999').length, 1);
    await agent.turn({channel: 'telegram', chatId: '999', text: 'Snooze an hour.'});
    assert.match(prompts[2], /Arrived mid-turn/); assert.doesNotMatch(prompts[2], /The invented value changed/);
    await agent.turn({channel: 'telegram', chatId: '999', text: 'Next.'});
    assert.doesNotMatch(prompts[3], /\[Reminder|\[Check/);
  } finally { providers['claude-cli'] = original; a.commit = commit; }
});

test('simulated reminders never send; checks run for real with a separate capture store including file RPCs', async () => {
  const f = setup(), parentStore = {calls: []}, context = {...chat(), simulation: parentStore};
  const reminder = await add(f.schedules, {text: 'Invented simulated text.'}, context);
  await f.schedules.request(context, {action: 'run', id: reminder});
  assert.equal(f.sent.length, 0); assert.equal(f.schedules.schedule(reminder).simulated, 1);
  assert.match(JSON.parse(runs(reminder)[0].detail).calls[0].text, /Invented simulated text/);
  const id = await check(f.schedules, {}, context); await f.schedules.tick();
  assert.notEqual(f.calls[0].opts.chat.simulation, parentStore);
  const handler = createInternal({config, db, tasks: f.tasks, schedules: f.schedules});
  const sent = await invoke(handler, '/internal/send-file', {path: join(config.workspace, 'invented.txt')}, {'x-chat-token': credential(f.calls[0].opts.chat)});
  assert.equal(sent.json.status, 'sent');
  f.calls[0].resolve('Invented changed evidence.'); await finished(f.tasks);
  assert.equal(f.sent.length, 0); assert.equal(parentStore.calls.length, 0);
  const captured = JSON.parse(runs(id)[0].detail).calls;
  assert.equal(captured[0].method, 'sendDocument'); assert.match(captured[1].text, /^Check:/);
  assert.equal(runs(id)[0].state, 'posted');
});

test('restarted schedule tasks fail through schedule handling without Done or interruption posts, including simulated tasks', async () => {
  const f = setup(), context = {...chat(), simulation: {calls: []}}, id = await check(f.schedules, {}, context);
  await f.schedules.tick(); f.tasks.shutdown(); await Promise.all([...f.tasks.running.values()].map(s => s.promise));
  const tasks = new BackgroundTasks({db, run() { throw new Error('must not run'); }}); runners.push(tasks);
  const schedules = new Schedules({db, tasks, now: f.now, send: async () => { throw new Error('must not send'); }});
  await tasks.recover(); await schedules.recover();
  assert.equal(schedules.schedule(id).fails, 1); assert.equal(runs(id)[0].state, 'failed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM bg_task_notes WHERE note IS NOT NULL').get().n, 0);
  assert.equal(f.sent.length, 0);
});

test('recovery finalizes a finished task whose schedule completion was interrupted, only once', async () => {
  const f = setup(), id = await check(f.schedules); await f.schedules.tick();
  f.tasks.shutdown(); await Promise.all([...f.tasks.running.values()].map(s => s.promise));
  db.prepare("UPDATE bg_tasks SET status='done',result='NO_CHANGE\nStill 17.' WHERE id=?").run(runs(id)[0].task_id);
  await f.schedules.recover(); await f.schedules.recover();
  assert.equal(runs(id)[0].state, 'quiet'); assert.equal(f.schedules.schedule(id).last_result, 'Still 17.');
});

test('switch off prevents ticks and add/run/resume, omits prompt instructions, and keeps list/pause/delete', async () => {
  const f = setup(), id = await add(f.schedules), agent = new Agent();
  assert.match(readFileSync(agent.systemFile('telegram'), 'utf8'), /mastan-me-schedule.*skills\/schedules/);
  process.env.MASTAN_ME_SCHEDULES = 'off'; f.advance(3600_000);
  await f.schedules.start(); await f.schedules.tick(); assert.equal(f.schedules.timer, undefined);
  assert.equal(runs(id).length, 0);
  for (const action of ['add', 'run', 'resume']) assert.equal((await f.schedules.request(chat(), {action, ...(action === 'add' ? {kind: 'reminder', title: 'Disabled', in: '1h'} : {id})})).status, 'unavailable');
  assert.equal((await f.schedules.request(chat(), {action: 'list'})).schedules.length, 1);
  assert.equal((await f.schedules.request(chat(), {action: 'pause', id})).status, 'ok');
  assert.equal((await f.schedules.request(chat(), {action: 'delete', id})).status, 'ok');
  for (const channel of ['telegram', 'web']) assert.doesNotMatch(readFileSync(agent.systemFile(channel), 'utf8'), /mastan-me-schedule|skills\/schedules/);
  f.schedules.shutdown();
});

test('the service timer ticks at 15 seconds and shutdown clears it', async () => {
  const f = setup(), id = await add(f.schedules), set = globalThis.setInterval, clear = globalThis.clearInterval;
  let callback, delay, cleared, unref = false, timers = 0;
  const timer = {unref() { unref = true; return this; }};
  globalThis.setInterval = (fn, ms) => { timers++; callback = fn; delay = ms; return timer; };
  globalThis.clearInterval = id => { cleared = id; };
  try {
    await f.schedules.start();
    await f.schedules.start(); assert.equal(timers, 1);
    assert.equal(delay, 15_000); assert.equal(unref, true); assert.equal(runs(id).length, 0);
    f.advance(15 * 60_000); callback(); await f.schedules.tick();
    assert.equal(runs(id)[0].state, 'sent');
    f.schedules.shutdown(); assert.equal(cleared, timer);
  } finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
});

test('an older check finishing after five reminders leaves the newest note; manual runs preserve a paused regular slot', async () => {
  const f = setup(), id = await check(f.schedules); await f.schedules.tick();
  for (let n = 0; n < 5; n++) {
    const reminder = await add(f.schedules, {title: `Later reminder ${n}`});
    await f.schedules.request(chat(), {action: 'run', id: reminder});
  }
  f.calls[0].resolve('The older check just finished.'); await finished(f.tasks);
  const notes = pendingScheduleNotes(db, 'telegram', '999');
  assert.equal(notes.length, 5); assert.match(notes.at(-1).note, /older check just finished/);
  assert.doesNotMatch(notes.map(n => n.note).join('\n'), /Later reminder 0/);
  const reminder = await add(f.schedules, {repeat: 'every 1h'}), next = f.schedules.schedule(reminder).next_run;
  await f.schedules.request(chat(), {action: 'pause', id: reminder});
  await f.schedules.request(chat(), {action: 'run', id: reminder});
  assert.equal(f.schedules.schedule(reminder).status, 'paused'); assert.equal(f.schedules.schedule(reminder).next_run, next);
  assert.ok(f.schedules.list(chat()).some(s => s.status === 'done'));
  assert.doesNotMatch(f.schedules.listText(chat()), /Later reminder/);
});

test('written delivery with an interrupted receipt stays uncertain and does not resend; schedule logs contain no content', async () => {
  const f = setup(), id = await add(f.schedules, {title: 'Private title', text: 'Private reminder content'}), log = console.log, logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  f.schedules.note = () => { throw new Error('Invented receipt failure'); };
  try {
    f.advance(15 * 60_000); await f.schedules.tick();
    assert.equal(runs(id)[0].state, 'uncertain'); assert.equal(f.sent.length, 1);
    f.advance(60_000); await f.schedules.recover(); assert.equal(f.sent.length, 1);
    assert.doesNotMatch(logs.join('\n'), /Private title|Private reminder content|Invented receipt failure/);
    assert.equal(pendingScheduleNotes(db, 'telegram', '999').length, 0);
  } finally { console.log = log; }
});

test('telegram-sim creation persists the simulation marker and a claimed reminder recovers without a real send', async () => {
  const f = setup(); let id;
  const agent = {busy: () => false, busyCount: () => 0, async turn() {
    id = await add(f.schedules, {}, {...chat(), simulation: sim.getStore()});
    return {text: 'Invented reminder created.', durationMs: 1};
  }};
  const telegram = new TelegramChannel({agent, tasks: f.tasks, schedules: f.schedules});
  const handler = createInternal({config, db, agent, telegram, tasks: f.tasks, schedules: f.schedules});
  const headers = {'x-internal-token': createHash('sha256').update(config.sessionSecret + ':internal').digest('hex')};
  await invoke(handler, '/internal/telegram-sim', {text: 'Invented reminder request.', chat_id: 999}, headers);
  assert.equal(f.schedules.schedule(id).simulated, 1);
  f.advance(15 * 60_000); f.schedules.claim(id);
  const restart = new Schedules({db, tasks: f.tasks, now: f.now, send: async () => { throw new Error('must not send'); }});
  await restart.recover(); await restart.recover();
  assert.equal(runs(id)[0].state, 'sent'); assert.equal(JSON.parse(runs(id)[0].detail).calls.length, 1);
  assert.equal(f.sent.length, 0);
});

test('validation enforces kind, text/brief/title bounds, interval floors and prevents malformed actions', async () => {
  const f = setup(), base = {action: 'add', kind: 'reminder', title: 'Invented', in: '1h'};
  for (const input of [
    {kind: 'other'}, {title: ''}, {title: 'x'.repeat(121)}, {title: 'x\ny'}, {text: 'x'.repeat(2001)}, {text: 1}, {brief: 'unwanted'},
    {kind: 'check', brief: ''}, {kind: 'check', brief: 'x'.repeat(20_001)}, {kind: 'check', brief: 'Valid.', text: ''},
    {repeat: 'every 14m'}, {kind: 'check', brief: 'Valid.', repeat: 'every 29m'},
  ]) assert.equal((await f.schedules.request(chat(), {...base, ...input})).status, 'failed', JSON.stringify(input));
  assert.equal((await f.schedules.request(chat(), null)).status, 'failed');
  assert.equal((await f.schedules.request(chat(), {action: 'unknown'})).status, 'failed');
  assert.equal((await f.schedules.request(chat(), {action: '__proto__'})).status, 'failed');
  assert.equal((await f.schedules.request(chat(), {...base, text: 'x'.repeat(2000), title: 'x'.repeat(120)})).status, 'ok');
});

test('schedule CLI parses all flags and actions, bounds stdin, uses loopback chat credentials and task-style exit codes', async () => {
  const env = {MASTAN_ME_RPC: 'http://127.0.0.1:3100', MASTAN_ME_CHAT_TOKEN: 'invented-cli-token'}, calls = [];
  const request = async (url, opts) => { calls.push({url, opts}); return {ok: true, json: async () => ({status: 'ok', id: 42, next_run_local: 'Invented time'})}; };
  const out = await schedule(['add', '--remind', '--title', 'Invented', '--at', '2026-11-01 09:00', '--repeat', 'monthly 1 09:00', '--until', '2027-01-01', '--times', '3'], {env, request, stdin: Readable.from(['Invented ', 'text.'])});
  assert.equal(out.status, 'ok');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {action: 'add', kind: 'reminder', title: 'Invented', at: '2026-11-01 09:00', repeat: 'monthly 1 09:00', until: '2027-01-01', times: 3, text: 'Invented text.'});
  assert.equal(calls[0].url.pathname, '/internal/schedules'); assert.equal(calls[0].opts.headers['X-Chat-Token'], env.MASTAN_ME_CHAT_TOKEN);
  await schedule(['add', '--check', '--title', 'Check', '--at', 'now', '--repeat', 'every 3h'], {env, request, stdin: Readable.from(['Invented brief.'])});
  assert.equal(JSON.parse(calls.at(-1).opts.body).brief, 'Invented brief.');
  for (const action of ['pause', 'resume', 'delete', 'run']) {
    await schedule([action, '42'], {env, request}); assert.deepEqual(JSON.parse(calls.at(-1).opts.body), {action, id: 42});
  }
  await schedule(['list'], {env, request}); assert.deepEqual(JSON.parse(calls.at(-1).opts.body), {action: 'list'});
  for (const args of [['add', '--check', '--remind'], ['add', '--remind', '--title', 'x', '--title', 'y'], ['pause', 'x'], ['add', '--remind', '--title', 'x', '--times', '0']]) assert.equal((await schedule(args, {env, request})).status, 'failed');
  assert.equal((await schedule(['add', '--remind', '--title', 'Big', '--in', '1h'], {env, request, stdin: Readable.from(['x'.repeat(2001)])})).status, 'failed');
  assert.equal((await schedule(['add', '--check', '--title', 'Big', '--in', '1h'], {env, request, stdin: Readable.from(['x'.repeat(20_001)])})).status, 'failed');
  assert.equal((await schedule(['list'], {env: {...env, MASTAN_ME_RPC: 'https://example.invalid'}, request})).status, 'failed');
  assert.equal((await schedule(['list'], {env: {}})).status, 'unavailable');
  assert.match((await schedule(['list'], {env, request: async () => { throw new Error('lost'); }})).error, /List schedules/);
  const log = console.log; console.log = () => {};
  try {
    assert.equal(await main(['list'], {env, request}), 0);
    assert.equal(await main(['bad'], {env, request}), 1);
    assert.equal(await main(['list'], {env: {}}), 3);
  } finally { console.log = log; }
});

test('admin schedules and fire use operator routes and expose simulated details only', async () => {
  const f = setup(), id = await add(f.schedules), simId = await add(f.schedules, {}, {...chat(), simulation: {calls: []}});
  await f.schedules.request(chat(), {action: 'run', id}); await f.schedules.request(chat(), {action: 'run', id: simId});
  assert.equal(f.schedules.adminList(id)[0].detail, null);
  assert.equal(f.schedules.adminList(simId)[0].detail.calls[0].method, 'sendMessage');
  const handler = createInternal({config, db, schedules: f.schedules});
  const headers = {'x-internal-token': createHash('sha256').update(config.sessionSecret + ':internal').digest('hex')};
  assert.equal((await invoke(handler, '/internal/admin/schedules', {}, headers)).json.schedules.length, 2);
  assert.equal((await invoke(handler, '/internal/admin/schedules', {runs: simId}, headers)).json.schedules[0].state, 'sent');
  assert.equal((await invoke(handler, '/internal/admin/schedule-fire', {id}, headers)).json.status, 'ok');
  assert.equal(f.schedules.schedule(id).next_run, f.now());
  assert.equal((await invoke(handler, '/internal/admin/schedules', {}, {'x-chat-token': credential(chat())})).status, 404);
  const {commands} = await import('../src/admin/ops.js');
  const original = globalThis.fetch, log = console.log, calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({url, input: JSON.parse(opts.body)}); return {ok: true, json: async () => ({status: 'ok'})}; };
  console.log = () => {};
  try {
    await commands.schedules.run(['--runs', '42']); await commands['schedule-fire'].run(['42']);
    assert.deepEqual(calls.map(c => c.input), [{runs: 42}, {id: 42}]);
    assert.match(calls[0].url, /\/internal\/admin\/schedules$/); assert.match(calls[1].url, /schedule-fire$/);
  } finally { globalThis.fetch = original; console.log = log; }
});

test('JSON Telegram transport distinguishes a written lost response from a pre-write failure and a definite error response', async () => {
  for (const mode of ['before', 'after', 'response', 'invalid']) {
    const request = (opts, callback) => {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        if (mode !== 'before') { req.writableFinished = true; req.emit('finish'); }
        if (['before', 'after'].includes(mode)) req.emit('error', Object.assign(new Error('invented lost response'), {code: 'ECONNRESET'}));
        else {
          const res = new EventEmitter(); res.statusCode = 400; callback(res);
          res.emit('data', Buffer.from(mode === 'invalid' ? '<invalid>' : '{"ok":false,"error_code":400}')); res.emit('end');
        }
      });
      return req;
    };
    const promise = viaHttps('invented', 'sendMessage', {text: 'Invented.'}, {timeoutMs: 1000, request});
    if (mode === 'response') assert.equal((await promise).ok, false);
    else await assert.rejects(promise, e => e.bodyWritten === (mode !== 'before'));
  }
});
