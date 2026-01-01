// Offline busy-chat cases: fake providers, simulated Telegram, no sockets or external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'mm-busy-'));
process.env.MASTAN_ME_DATA = dir;
process.env.AGENT_HOME = join(dir, 'home');
process.env.OWNER_TELEGRAM_ID = '999';
process.env.MASTAN_ME_BROWSER = 'off';
delete process.env.CREDENTIALS_DIRECTORY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_TOKEN_FILE;
delete process.env.MASTAN_ME_BUSY_REPLY;
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {busyReply} = await import('../src/agent/busy-reply.js');
const {Agent} = await import('../src/agent/runner.js');
const {TASK_NOTE} = await import('../src/agent/tasks.js');
const {TelegramChannel} = await import('../src/channels/telegram.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const {sim} = await import('../src/channels/telegram-api.js');
const {providers, residentCount} = await import('../src/providers/index.js');
const {mcpArgs} = await import('../src/providers/common.js');
const {chatCredentials} = await import('../src/chat-tokens.js');
const {atlas} = await import('../src/atlas/store.js');
mkdirSync(config.workspace, {recursive: true});
const db = openDb();
const json = (reply, queue) => ({text: JSON.stringify({reply, queue})});
const running = () => ({started: Date.now() - 42_000, request: 'Make a new deck for Sumqayit.', status: 'Writing files...', replyTail: 'I am building the slides.'});
const busyAgent = () => ({busy: () => true, runningInfo: running});
const tick = () => new Promise(r => setImmediate(r));
const contextOf = opts => JSON.parse(opts.prompt.slice(opts.prompt.indexOf('\n{') + 1));
const holdWeb = (web, thread) => {
  const state = {...running(), who: 'owner', text: 'Partial answer'};
  state.id = Number(db.prepare("INSERT INTO web_messages(who,thread,role,text,status,created) VALUES('owner',?,'assistant','','running',?)")
    .run(thread, state.started).lastInsertRowid);
  web.live.set(thread, state);
  return state;
};

test.beforeEach(() => {
  delete process.env.MASTAN_ME_BUSY_REPLY;
  for (const table of ['web_messages', 'web_threads', 'chats']) db.exec(`DELETE FROM ${table}`);
});
test.after(() => rmSync(dir, {recursive: true, force: true}));

test('Telegram status question gets a real reply and never enters the main queue', async () => {
  let call;
  const telegram = new TelegramChannel({agent: busyAgent(), runBusy: async (role, opts) => {
    call = {role, opts}; return json('About 2 to 4 minutes total. It has been 42 seconds so far.', false);
  }});
  const capture = {calls: []};
  await sim.run(capture, () => telegram.enqueue('999', 'How long?'));
  assert.equal(capture.calls.at(-1).text, 'About 2 to 4 minutes total. It has been 42 seconds so far.');
  assert.equal(telegram.queue.get('999')?.length || 0, 0);
  assert.equal(call.role, 'fast');
  const state = running();
  assert.deepEqual(contextOf(call.opts), {request: state.request, elapsedSeconds: 42, status: state.status,
    replyTail: state.replyTail, queued: 0, message: 'How long?'});
});

test('Telegram new request is acknowledged and queued with its simulation context', async () => {
  const telegram = new TelegramChannel({agent: busyAgent(), runBusy: async () => json('I will handle that right after the deck.', true)});
  const capture = {calls: []};
  await sim.run(capture, () => telegram.enqueue('999', 'Then research venues.'));
  assert.equal(capture.calls.at(-1).text, 'I will handle that right after the deck.');
  assert.deepEqual(telegram.queue.get('999'), [{text: 'Then research venues.', simulation: capture}]);
});

test('Telegram provider errors and bad JSON fall back to elapsed seconds and queue the message', async () => {
  for (const runBusy of [async () => { throw new Error('invented provider error'); }, async () => ({text: 'not JSON'})]) {
    const telegram = new TelegramChannel({agent: busyAgent(), runBusy}), capture = {calls: []};
    await sim.run(capture, () => telegram.enqueue('999', 'status'));
    assert.equal(capture.calls.at(-1).text, 'Working on your last request (42 s so far). I will answer this right after.');
    assert.equal(telegram.queue.get('999')[0].text, 'status');
  }
});

test('Telegram timeout aborts an unresponsive fast call after 12 seconds, falls back and queues', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let opts;
  const telegram = new TelegramChannel({agent: busyAgent(), runBusy: (role, input) => {
    opts = input; return new Promise(() => {});
  }}), capture = {calls: []};
  const pending = sim.run(capture, () => telegram.enqueue('999', '?'));
  t.mock.timers.tick(11_999);
  assert.equal(capture.calls.length, 0);
  assert.equal(opts.signal.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(opts.signal.aborted, true);
  assert.equal(capture.calls.at(-1).text, 'Working on your last request (42 s so far). I will answer this right after.');
  assert.equal(telegram.queue.get('999')[0].text, '?');
});

test('switch off restores the old fixed Telegram line and queues even status questions without calling fast', async () => {
  process.env.MASTAN_ME_BUSY_REPLY = 'off';
  const telegram = new TelegramChannel({agent: busyAgent(), runBusy: () => { throw new Error('must not call'); }}), capture = {calls: []};
  await sim.run(capture, () => telegram.enqueue('999', 'How long?'));
  assert.equal(capture.calls.at(-1).text, 'Still on the last one. I will take this next. /stop cancels the running task.');
  assert.equal(telegram.queue.get('999')[0].text, 'How long?');
});

test('web status reply is a normal completed assistant message in its busy thread and is not queued', async () => {
  const calls = [], events = [];
  const web = new WebChat({agent: busyAgent(), runBusy: async (role, opts) => {
    calls.push({role, opts}); return json('Ещё примерно 1 до 3 минут. Работаю над презентацией.', false);
  }});
  const thread = web.createThread('owner', 'Busy'), other = web.createThread('owner', 'Other');
  const state = holdWeb(web, thread.id);
  web.on('event', ev => events.push(ev));
  const out = await web.send('owner', {thread: thread.id, text: 'Сколько ещё?'});
  assert.equal(out.queued, 0);
  assert.equal(web.queue.get(thread.id)?.length || 0, 0);
  const reply = web.history('owner', {thread: thread.id}).messages.at(-1);
  assert.equal(reply.role, 'assistant'); assert.equal(reply.status, 'done'); assert.ok(reply.finished);
  assert.equal(reply.text, 'Ещё примерно 1 до 3 минут. Работаю над презентацией.');
  assert.equal(reply.thread, thread.id);
  assert.equal(events.at(-1).type, 'user'); assert.equal(events.at(-1).message.id, reply.id);
  assert.equal(web.history('owner', {thread: other.id}).messages.length, 0);
  assert.equal(web.live.get(thread.id), state);
  assert.equal(calls[0].role, 'fast');
  web.live.delete(thread.id);
});

test('web changes to the running request get a normal assistant reply and queue the complete prompt', async () => {
  const web = new WebChat({agent: busyAgent(), runBusy: async () => json('I will make that change right after this version.', true)});
  const thread = web.createThread('owner', 'Change');
  holdWeb(web, thread.id);
  const out = await web.send('owner', {thread: thread.id, text: 'Use a blue cover.'});
  assert.equal(out.queued, 1);
  assert.deepEqual(web.queue.get(thread.id), [{id: out.id, prompt: 'Use a blue cover.'}]);
  const reply = web.history('owner', {thread: thread.id}).messages.at(-1);
  assert.equal(reply.role, 'assistant'); assert.equal(reply.status, 'done');
  assert.equal(reply.text, 'I will make that change right after this version.');
  // Keep the fake thread busy until its scheduled queue check has run.
  await tick(); web.live.delete(thread.id);
});

test('defensive JSON parsing rejects missing, extra, malformed and incorrectly typed fields', async () => {
  for (const text of ['null', '[]', '{}', '{"reply":"ok","queue":"false"}', '{"reply":"","queue":false}',
    '{"reply":"ok","queue":false,"extra":1}',
    JSON.stringify({reply: 'one\ntwo\nthree', queue: false}), JSON.stringify({reply: 'x'.repeat(601), queue: true})]) {
    const result = await busyReply({running: running(), message: 'status'}, {run: async () => ({text})});
    assert.equal(result.queue, true);
    assert.equal(result.reply, 'Working on your last request (42 s so far). I will answer this right after.');
  }
});

test('a fenced reply is accepted, with surrounding prose and only the first JSON object used', async () => {
  const expected = {reply: 'Working on {the deck}. About 2 to 4 minutes total.', queue: false};
  const text = `Here is the update:\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`\nExtra context: {"reply":"Ignored.","queue":true}`;
  const result = await busyReply({running: running(), message: 'status'}, {run: async () => ({text})});
  assert.deepEqual(result, expected);
});

test('running state and the one-shot fast call carry bounded context, no MCP servers, chat token or resident', async t => {
  let release, fastOpts;
  const provider = providers['claude-cli'];
  const a = atlas(), commit = a.commit;
  a.commit = () => {};
  t.mock.method(a, 'logChat', () => {});
  t.mock.method(a, 'renderAtlasMd', () => {});
  providers['claude-cli'] = {async run(opts) {
    if (opts.task === 'busy-reply') { fastOpts = opts; return json('Still working. Roughly 2 to 4 minutes total.', false); }
    opts.onEvent({kind: 'tool', name: 'Write', input: {file_path: 'invented.pptx'}});
    opts.onEvent({kind: 'delta', text: 'x'.repeat(350) + 'Latest words.'});
    await new Promise(r => { release = r; });
    return {text: 'Complete.', model: 'fake', sessionId: 'invented-main', durationMs: 1};
  }};
  const logged = [];
  t.mock.method(console, 'log', line => logged.push(line));
  const agent = new Agent(), text = 'Make a new deck. '.repeat(60);
  const turn = agent.turn({channel: 'telegram', chatId: '999', text});
  try {
    const state = agent.runningInfo('telegram', '999');
    assert.equal(state.request, text.slice(0, 600));
    assert.equal(state.request.length, 600);
    assert.equal(state.status, 'Writing files...');
    assert.equal(state.replyTail, ('x'.repeat(350) + 'Latest words.').slice(-300));
    const result = await busyReply({running: state, queued: 2, message: 'How long?'});
    assert.equal(result.queue, false);
    assert.deepEqual(contextOf(fastOpts), {request: text.slice(0, 600), elapsedSeconds: 0, status: 'Writing files...',
      replyTail: state.replyTail, queued: 2, message: 'How long?'});
    assert.equal(fastOpts.mcp, 'none'); assert.equal(fastOpts.timeoutMs, 12_000); assert.equal(fastOpts.stream, false);
    assert.equal(fastOpts.cwd, tmpdir());
    for (const field of ['chat', 'sessionKey', 'resume', 'systemFile']) assert.equal(fastOpts[field], undefined);
    assert.deepEqual(chatCredentials(fastOpts.chat).env, {});
    const args = mcpArgs(fastOpts.mcp);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(readFileSync(args[2], 'utf8')), {mcpServers: {}});
    assert.equal(residentCount(), 0);
    assert.equal(logged.length, 1); assert.match(logged[0], /^busy reply in \d+ ms \(queue false\)$/);
    assert.doesNotMatch(logged[0], /deck|How long|Latest words/);
    assert.match(fastOpts.prompt, /2 to 4 minutes total/); assert.match(fastOpts.prompt, /1 to 3 minutes total/);
    assert.match(fastOpts.prompt, /Owner's language/);
  } finally { release(); await turn; providers['claude-cli'] = provider; a.commit = commit; }
  assert.equal(agent.runningInfo('telegram', '999'), null);
});

test('TASK_NOTE and the background skill require files and variants at any length, other work over 30 seconds', () => {
  const skill = readFileSync(join(config.codeDir, 'workspace-template/skills/background-tasks/SKILL.md'), 'utf8');
  for (const text of [TASK_NOTE, skill]) {
    assert.match(text, /result is a file/); assert.match(text, /deck, document, spreadsheet, PDF, image, chart/);
    assert.match(text, /new version/); assert.match(text, /variant/); assert.match(text, /whatever its expected length/);
    assert.match(text, /30 seconds/); assert.match(text, /mastan-me-task start/);
  }
});

for (const channel of ['telegram', 'web']) test(`${channel} preserves arrival order and handles requests once when the main turn finishes during busy replies`, async () => {
  const states = new Map(), turns = [], fast = [];
  let release;
  const agent = {
    busy: (channel, chatId) => states.has(chatId), runningInfo: (channel, chatId) => states.get(chatId),
    async turn({chatId, text}) {
      turns.push(text); states.set(chatId, {...running(), request: text});
      if (text === 'First') await new Promise(r => { release = r; });
      states.delete(chatId);
      return {text: `Done ${text}`, durationMs: 1};
    },
  };
  const runBusy = () => new Promise(resolve => fast.push(resolve));
  const captures = [{calls: []}, {calls: []}, {calls: []}, {calls: []}];
  const chat = channel === 'telegram' ? new TelegramChannel({agent, runBusy}) : new WebChat({agent, runBusy});
  const thread = channel === 'web' ? chat.createThread('owner', 'Order').id : '999';
  const send = (text, n) => channel === 'telegram' ? sim.run(captures[n], () => chat.enqueue(thread, text))
    : chat.send('owner', {thread, text});
  const first = send('First', 0);
  const status = send('?', 1), second = send('Second', 2), third = send('Third', 3);
  assert.equal(fast.length, 3);
  fast[2](json('Third will follow.', true)); fast[1](json('Second will follow.', true));
  release(); await first; await tick();
  assert.deepEqual(turns, ['First'], 'the queue waits for the earliest busy decision');
  fast[0](json('About 2 to 4 minutes total.', false));
  await Promise.all([status, second, third]);
  for (let n = 0; n < 4; n++) await tick();
  assert.deepEqual(turns, ['First', 'Second', 'Third']);
  assert.equal(chat.queue.get(thread)?.length || 0, 0);
  assert.equal(chat.busyReplies.size, 0);
  if (channel === 'telegram') {
    assert.ok(captures[2].calls.some(c => c.text === 'Done Second'));
    assert.ok(captures[3].calls.some(c => c.text === 'Done Third'));
    assert.ok(!captures[0].calls.some(c => /Done (Second|Third)/.test(c.text)));
  }
});
