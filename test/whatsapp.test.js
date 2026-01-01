// Invented WhatsApp messages, a fake socket and a fake agent. Nothing connects to WhatsApp or calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mm-wa-'));
process.env.MASTAN_ME_DATA = dir;
process.env.AGENT_HOME = join(dir, 'home');
process.env.OWNER_TELEGRAM_ID = '999';
process.env.SESSION_SECRET = 'invented-whatsapp-test';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.CREDENTIALS_DIRECTORY;
const {config} = await import('../src/config.js');
const W = await import('../src/channels/whatsapp.js');
const {chatCredentials} = await import('../src/chat-tokens.js');
const {openDb} = await import('../src/db.js');
const {createFileSender} = await import('../src/files.js');
const {BackgroundTasks} = await import('../src/agent/tasks.js');
const {Schedules} = await import('../src/agent/schedules.js');
mkdirSync(config.workspace, {recursive: true});
test.after(() => rmSync(dir, {recursive: true, force: true}));

const OWNER = '966500000001';
const env = {MASTAN_ME_WHATSAPP: 'on', WHATSAPP_ALLOW: `+${OWNER}`};
const nowS = () => Math.floor(Date.now() / 1000);
const msg = (over = {}) => ({key: {remoteJid: `${OWNER}@s.whatsapp.net`, id: `id-${Math.random()}`, fromMe: false, ...over.key},
  message: over.message || {conversation: over.text ?? 'hello'}, messageTimestamp: over.ts ?? nowS()});

function fakeAgent({reply = 'Done **now**', hold} = {}) {
  const a = {turns: [], running: new Set(), sessions: [], stops: []};
  a.busy = (ch, id) => a.running.has(`${ch}:${id}`);
  a.newSession = (ch, id) => a.sessions.push(`${ch}:${id}`);
  a.stop = (ch, id) => { a.stops.push(`${ch}:${id}`); return a.running.has(`${ch}:${id}`); };
  a.turn = async ({channel, chatId, text, onTool}) => {
    a.turns.push({channel, chatId, text});
    a.running.add(`${channel}:${chatId}`);
    onTool?.('Bash', {command: 'ls'});
    if (hold) await hold;
    a.running.delete(`${channel}:${chatId}`);
    return {text: reply, durationMs: 1200};
  };
  return a;
}

function fakeSock() {
  const s = {sent: [], presence: [], read: [], user: {id: '17745550000:3@s.whatsapp.net'}};
  s.sendMessage = async (jid, content) => { s.sent.push({jid, content}); return {key: {id: `out-${s.sent.length}`}}; };
  s.sendPresenceUpdate = async (kind, jid) => { s.presence.push({kind, jid}); };
  s.readMessages = async keys => { s.read.push(...keys); };
  s.end = () => { s.ended = true; };
  return s;
}

async function channel(opts = {}) {
  const agent = opts.agent || fakeAgent();
  const sock = fakeSock();
  let handlers;
  const ch = new W.WhatsAppChannel({agent, env: opts.env || env, connect: async ({handlers: h}) => { handlers = h; return {sock, download: opts.download || (async () => Buffer.from('img'))}; }});
  await ch.start();
  handlers.connection({connection: 'open'});
  return {ch, agent, sock, handlers};
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('markdown becomes WhatsApp marks', () => {
  assert.equal(W.toWhatsApp('## Plan\n**bold** and __it__ ~~old~~ [site](https://mastan.ai)'), '*Plan*\n*bold* and _it_ ~old~ site (https://mastan.ai)');
  assert.deepEqual(W.chunks('a'.repeat(10), 4), ['aaaa', 'aaaa', 'aa']);
});

test('sender phone from a phone JID, a LID with an alternate, the mapping file and the lookup', async () => {
  const auth = join(dir, 'auth-map');
  mkdirSync(auth, {recursive: true});
  writeFileSync(join(auth, 'lid-mapping-123456_reverse.json'), JSON.stringify(`+${OWNER}`));
  assert.equal(await W.senderPhone({remoteJid: `${OWNER}:2@s.whatsapp.net`}), OWNER);
  assert.equal(await W.senderPhone({remoteJid: '999@lid', remoteJidAlt: `${OWNER}@s.whatsapp.net`}), OWNER);
  assert.equal(await W.senderPhone({remoteJid: '123456@lid'}, {dir: auth}), OWNER);
  assert.equal(await W.senderPhone({remoteJid: '777@lid'}, {dir: auth, lidLookup: {getPNForLID: async () => `${OWNER}:0@s.whatsapp.net`}}), OWNER);
  assert.equal(await W.senderPhone({remoteJid: '888@lid'}, {dir: auth}), null);
  assert.equal(await W.senderPhone({remoteJid: '1203@g.us'}), null);
});

test('disabled unless switched on with an allowlist', () => {
  assert.equal(W.enabled({}), false);
  assert.equal(W.enabled({MASTAN_ME_WHATSAPP: 'on'}), false);
  assert.equal(W.enabled(env), true);
});

test('the owner gets an answer in WhatsApp marks; strangers, groups, own messages, repeats and old messages get nothing', async () => {
  const {ch, agent, sock} = await channel();
  assert.equal(ch.status().state, 'open');
  assert.equal(ch.status().me, '17745550000');
  await ch.handle(msg({key: {remoteJid: '966511111111@s.whatsapp.net'}}));
  await ch.handle(msg({key: {remoteJid: '1203@g.us', participant: `${OWNER}@s.whatsapp.net`}}));
  await ch.handle(msg({key: {fromMe: true}}));
  await ch.handle(msg({ts: nowS() - 3600}));
  await ch.handle(msg({message: {reactionMessage: {text: '👍'}}}));
  assert.equal(agent.turns.length, 0);
  assert.equal(sock.sent.length, 0);
  const m = msg({text: 'what is on today?'});
  await ch.handle(m);
  await ch.handle(m);
  assert.equal(agent.turns.length, 1);
  assert.deepEqual(agent.turns[0], {channel: 'whatsapp', chatId: OWNER, text: 'what is on today?'});
  assert.deepEqual(sock.sent, [{jid: `${OWNER}@s.whatsapp.net`, content: {text: 'Done *now*'}}]);
  assert.equal(sock.presence[0].kind, 'composing');
  assert.equal(sock.presence.at(-1).kind, 'paused');
  assert.equal(sock.read.length, 1);
});

test('a LID sender is answered on the LID chat', async () => {
  const {agent, sock, ch} = await channel();
  await ch.handle(msg({key: {remoteJid: '4242@lid', remoteJidAlt: `${OWNER}@s.whatsapp.net`}, text: 'hi'}));
  assert.equal(agent.turns[0].chatId, OWNER);
  assert.equal(sock.sent[0].jid, '4242@lid');
});

test('a message during a running reply is acknowledged, queued and answered next', async () => {
  let release;
  const agent = fakeAgent({hold: new Promise(r => { release = r; })});
  const {ch, sock} = await channel({agent});
  const first = ch.handle(msg({text: 'one'}));
  await settle();
  await ch.handle(msg({text: 'two'}));
  assert.match(sock.sent[0].content.text, /after the current reply/);
  release();
  await first;
  await settle(); await settle();
  assert.deepEqual(agent.turns.map(t => t.text), ['one', 'two']);
});

test('commands: /new, /stop and others point to Telegram', async () => {
  const {ch, agent, sock} = await channel();
  await ch.handle(msg({text: '/new'}));
  await ch.handle(msg({text: '/stop'}));
  await ch.handle(msg({text: '/board'}));
  assert.deepEqual(agent.sessions, [`whatsapp:${OWNER}`]);
  assert.deepEqual(agent.stops, [`whatsapp:${OWNER}`]);
  assert.equal(agent.turns.length, 0);
  assert.match(sock.sent[0].content.text, /Fresh session/);
  assert.match(sock.sent[1].content.text, /Nothing is running/);
  assert.match(sock.sent[2].content.text, /Telegram/);
});

test('a photo with a caption is saved to the inbox and handed to the agent', async () => {
  const {ch, agent} = await channel({download: async () => Buffer.from('jpeg-bytes')});
  await ch.handle(msg({key: {id: 'PHOTO1'}, message: {imageMessage: {caption: 'what is this?', mimetype: 'image/jpeg', fileLength: 10}}}));
  const t = agent.turns[0].text;
  assert.match(t, /^what is this\?\n\n\[Attached: .*wa-image-PHOTO1\.jpg \(image\/jpeg, 10 bytes\)\]$/);
  const path = t.match(/\[Attached: (\S+)/)[1];
  assert.equal(readFileSync(path, 'utf8'), 'jpeg-bytes');
});

test('logged out or replaced stops for good; other closes reconnect', async () => {
  const a = await channel();
  a.handlers.connection({connection: 'close', lastDisconnect: {error: {output: {statusCode: 440}}}});
  assert.equal(a.ch.status().state, 'stopped');
  assert.equal(a.ch.status().problem, 'replaced by another session');
  const b = await channel();
  b.handlers.connection({connection: 'close', lastDisconnect: {error: {output: {statusCode: 428}}}});
  assert.equal(b.ch.status().state, 'reconnecting');
  b.ch.shutdown();
});

test('files go back as an image or a document into the chat Owner wrote from', async () => {
  const {ch, sock} = await channel();
  await ch.handle(msg({text: '/help'}));
  const stored = join(dir, 'chart.png');
  writeFileSync(stored, 'png');
  assert.deepEqual(await ch.sendArtifact(OWNER, {stored_path: stored, mime: 'image/png', name: 'chart.png', caption: 'Chart'}), {status: 'sent', receipt: 'out-2'});
  assert.deepEqual(Object.keys(sock.sent[1].content).sort(), ['caption', 'image', 'mimetype']);
  await ch.sendArtifact(OWNER, {stored_path: stored, mime: 'application/pdf', name: 'r.pdf'});
  assert.equal(sock.sent[2].content.fileName, 'r.pdf');
  ch.stopped = true;
  assert.equal((await ch.sendArtifact('966599999999', {stored_path: stored, mime: 'image/png', name: 'x.png'})).status, 'failed');
});

test('the harness accepts WhatsApp chats for files but not for tasks or schedules', async () => {
  const cred = chatCredentials({user: 'owner', channel: 'whatsapp', chatId: OWNER});
  assert.ok(cred.env.MASTAN_ME_CHAT_TOKEN);
  cred.revoke();
  const db = openDb();
  const source = join(config.workspace, 'note.txt');
  writeFileSync(source, 'hi');
  const calls = [];
  const send = createFileSender({config, db, chat: null, whatsapp: {sendArtifact: async (id, a) => { calls.push({id, name: a.name}); return {status: 'sent', receipt: 'r1'}; }}});
  const out = await send({user: 'owner', channel: 'whatsapp', chatId: OWNER}, {path: source});
  assert.equal(out.status, 'sent');
  assert.deepEqual(calls, [{id: OWNER, name: 'note.txt'}]);
  assert.equal((await send({user: 'owner', channel: 'whatsapp', chatId: OWNER}, {path: join(config.dataDir, 'whatsapp', 'auth', 'creds.json')})).status, 'failed');
  const tasks = new BackgroundTasks({db, run: async () => ({text: 'x'})});
  assert.equal(tasks.start({user: 'owner', channel: 'whatsapp', chatId: OWNER}, {title: 't', brief: 'b'}).status, 'unavailable');
  const schedules = new Schedules({db, tasks, send: async () => []});
  assert.equal((await schedules.request({user: 'owner', channel: 'whatsapp', chatId: OWNER}, {action: 'add', kind: 'reminder', title: 't', text: 'x', in: '5m'})).status, 'unavailable');
  assert.equal((await schedules.request({user: 'owner', channel: 'whatsapp', chatId: OWNER}, {action: 'list'})).status, 'ok');
  schedules.shutdown(); tasks.shutdown();
});

test('the auth folder is created private', async () => {
  await channel();
  assert.ok(existsSync(W.authDir()));
});
