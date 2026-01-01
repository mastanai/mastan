// Invented files, injected Telegram transport and in-memory HTTP requests. No network or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, truncateSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Readable, Writable, PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'mm-files-'));
process.env.MASTAN_ME_DATA = dir;
process.env.AGENT_HOME = join(dir, 'home');
process.env.CREDENTIALS_DIRECTORY = join(dir, 'credentials');
process.env.TELEGRAM_BOT_TOKEN = '12345:invented-test-value';
process.env.OWNER_TELEGRAM_ID = '999';
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {openSource, storeArtifact, createFileSender, MAX_FILE_BYTES} = await import('../src/files.js');
const {sendFile, multipart, sim} = await import('../src/channels/telegram-api.js');
const {chatCredentials, chatForToken} = await import('../src/chat-tokens.js');
const {createInternal} = await import('../src/internal.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const {TelegramChannel} = await import('../src/channels/telegram.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const A = await import('../src/web/auth.js');
const {send} = await import('../src/send-cli.js');
const db = openDb();
for (const p of [config.workspace, config.agentHome, config.credentialsDir, join(dir, 'run'), join(config.workspace, '.git')]) mkdirSync(p, {recursive: true});
const source = join(config.workspace, 'report.xlsx');
const bytes = Buffer.from([0, 80, 75, 255, 4, 13, 10, 100]);
writeFileSync(source, bytes);
const tg = {user: 'owner', channel: 'telegram', chatId: '999'};
const secrets = [];
const credentials = c => { const v = chatCredentials(c); secrets.push(v); return v.env.MASTAN_ME_CHAT_TOKEN; };
test.after(() => { for (const c of secrets) c.revoke(); rmSync(dir, {recursive: true, force: true}); });

// ServerResponse shape backed by a Writable, so real download pipelines and SSE run without sockets.
function response() {
  const parts = [];
  const res = new Writable({write(c, enc, cb) { parts.push(Buffer.from(c)); cb(); }});
  res.headers = {}; res.statusCode = 200; res.headersSent = false;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); return res; };
  res.body = () => Buffer.concat(parts);
  res.json = () => JSON.parse(res.body().toString('utf8'));
  return res;
}
function request(url, {body, headers = {}, method = body === undefined ? 'GET' : 'POST', remote = '127.0.0.1'} = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const req = Readable.from(payload.length ? [payload] : []);
  req.url = url; req.method = method; req.socket = {remoteAddress: remote, localPort: config.port};
  req.headers = {host: config.host, ...(payload.length ? {'content-type': 'application/json', 'content-length': String(payload.length)} : {}), ...headers};
  return req;
}
async function invoke(handler, url, options) {
  const req = request(url, options), res = response();
  await handler(req, res);
  return {req, res};
}

function transport(replies = [{ok: true, result: {message_id: 42}}], {drop = false, early = false} = {}) {
  const calls = [];
  const request = (options, callback) => {
    const chunks = [], call = {options, chunks}; calls.push(call);
    const req = new Writable({autoDestroy: false, write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); }});
    req.once('finish', () => queueMicrotask(() => {
      call.body = Buffer.concat(chunks);
      if (drop) return req.destroy(Object.assign(new Error('lost response'), {code: 'ECONNRESET'}));
      const res = new PassThrough(); res.statusCode = 200;
      callback(res); res.end(JSON.stringify(replies.length ? replies.shift() : {ok: true, result: {message_id: 42}}));
    }));
    if (early) queueMicrotask(() => req.destroy(Object.assign(new Error('connection refused'), {code: 'ECONNREFUSED'})));
    return req;
  };
  return {request, calls};
}

const closeSource = async path => { const {handle} = await openSource(path, config); await handle.close(); };
test('path policy allows workspace and temp files; refuses traversal, escapes, protected paths and invalid sizes', async () => {
  await closeSource(source);
  const temp = join(dir, 'temporary.txt'); writeFileSync(temp, 'invented'); await closeSource(temp);
  await assert.rejects(closeSource(`${config.workspace}/../temporary.txt`), /not allowed/);
  const outside = mkdtempSync(join(process.cwd(), 'tmp-files-policy-'));
  try {
    const file = join(outside, 'invented.txt'); writeFileSync(file, 'invented');
    symlinkSync(file, join(config.workspace, 'escape'));
    await assert.rejects(closeSource(join(config.workspace, 'escape')), /not allowed/);
    await assert.rejects(closeSource(file), /not allowed/);
  } finally { rmSync(outside, {recursive: true, force: true}); }
  for (const base of [join(dir, 'run'), config.agentHome, config.credentialsDir, join(config.workspace, '.git')]) {
    const file = join(base, 'invented'); writeFileSync(file, 'invented');
    await assert.rejects(closeSource(file), /not allowed/);
  }
  symlinkSync(join(dir, 'run', 'invented'), join(config.workspace, 'hidden-run'));
  await assert.rejects(closeSource(join(config.workspace, 'hidden-run')), /not allowed/);
  const nestedGit = join(config.workspace, 'project', '.git'); mkdirSync(nestedGit, {recursive: true});
  writeFileSync(join(nestedGit, 'invented'), 'invented'); await assert.rejects(closeSource(join(nestedGit, 'invented')), /not allowed/);
  await assert.rejects(closeSource(config.workspace), /regular files/);
  const empty = join(config.workspace, 'empty'); writeFileSync(empty, ''); await assert.rejects(closeSource(empty), /1 byte to 50 MB/);
  const huge = join(config.workspace, 'huge'); writeFileSync(huge, ''); truncateSync(huge, MAX_FILE_BYTES + 1);
  await assert.rejects(closeSource(huge), /1 byte to 50 MB/);
  truncateSync(huge, MAX_FILE_BYTES); await closeSource(huge);
  symlinkSync(source, join(config.workspace, 'report-link.xlsx')); await closeSource(join(config.workspace, 'report-link.xlsx'));
});

test('stored copy, metadata, safe name, mode and receipt survive later source edits', async () => {
  const sender = createFileSender({config, db}, {telegramSend: async (chatId, a) => {
    assert.equal(chatId, tg.chatId); writeFileSync(source, 'edited');
    assert.deepEqual(readFileSync(a.stored_path), bytes);
    return {status: 'sent', receipt: 71};
  }});
  const sent = await sender(tg, {path: source, name: '../Quarter "one".xlsx', caption: 'Ready'});
  assert.equal(sent.status, 'sent'); assert.equal(sent.receipt, 71);
  const a = db.prepare('SELECT * FROM artifacts WHERE id=?').get(sent.artifact);
  assert.match(a.stored_path, /users\/owner\/files\/out\/\d{4}-\d{2}-\d{2}\//);
  assert.equal(a.name, '_Quarter _one_.xlsx'); assert.equal(a.user, 'owner'); assert.equal(a.channel, 'telegram');
  assert.equal(a.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(a.size, bytes.length); assert.equal(a.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(statSync(a.stored_path).mode & 0o777, 0o640); assert.equal(a.status, 'sent'); assert.equal(a.receipt, '71');
  assert.equal(a.caption, 'Ready'); assert.deepEqual(readFileSync(a.stored_path), bytes);
  writeFileSync(source, bytes);
  for (const status of ['failed', 'uncertain']) {
    const s = createFileSender({config, db}, {telegramSend: async () => ({status, error: 'invented error'})});
    const out = await s(tg, {path: source});
    assert.equal(out.status, status); assert.equal(db.prepare('SELECT status,error FROM artifacts WHERE id=?').get(out.artifact).error, 'invented error');
  }
  const unknown = join(config.workspace, 'unknown.extension'); writeFileSync(unknown, bytes);
  const unicode = await storeArtifact(config, db, tg, {path: unknown, name: 'تقرير'.repeat(40)});
  assert.equal(unicode.mime, 'application/octet-stream'); assert.ok(Buffer.byteLength(unicode.name) <= 200);
  assert.deepEqual(readFileSync(unicode.stored_path), bytes);
});

test('browser files belong to the chat user, including through symlinks and when data lives in temp', async () => {
  const outside = mkdtempSync(join(process.cwd(), 'tmp-browser-policy-'));
  try {
    for (const dataDir of [join(dir, 'browser-policy'), outside]) {
      const cfg = {...config, dataDir, workspace: join(dataDir, 'workspace'), agentHome: join(dataDir, 'home'), credentialsDir: join(dataDir, 'credentials')};
      for (const path of [cfg.workspace, cfg.agentHome, cfg.credentialsDir, join(dataDir, 'run')]) mkdirSync(path, {recursive: true});
      const paths = {};
      for (const user of ['owner', 'operator']) {
        paths[user] = join(dataDir, 'users', user, 'browser', 'out', 'x.png');
        mkdirSync(dirname(paths[user]), {recursive: true}); writeFileSync(paths[user], 'invented image');
      }
      const check = async (path, chat) => { const {handle} = await openSource(path, cfg, chat); await handle.close(); };
      for (const user of ['owner', 'operator']) {
        const chat = {...tg, user}, other = user === 'owner' ? 'operator' : 'owner';
        await check(paths[user], chat);
        await assert.rejects(check(paths[other], chat), /not allowed/);
        await assert.rejects(check(paths[user]), /not allowed/);
        await assert.rejects(check(paths[user], {...chat, user: '../owner'}), /not allowed/);
        const link = join(cfg.workspace, `${user}-link`);
        symlinkSync(paths[other], link); await assert.rejects(check(link, chat), /not allowed/);
        const ownLink = join(dirname(paths[user]), 'other-user');
        symlinkSync(paths[other], ownLink); await assert.rejects(check(ownLink, chat), /not allowed/);
        for (const [i, root] of [join(dataDir, 'run'), cfg.agentHome, cfg.credentialsDir, join(dirname(paths[user]), '.git')].entries()) {
          mkdirSync(root, {recursive: true}); const file = join(root, 'invented'); writeFileSync(file, 'invented');
          const blockedLink = join(dirname(paths[user]), `blocked-${i}`); symlinkSync(file, blockedLink);
          await assert.rejects(check(blockedLink, chat), /not allowed/);
        }
      }
      const shared = join(cfg.workspace, 'shared.txt'); writeFileSync(shared, 'invented');
      const otherLink = join(dirname(paths.operator), 'shared-link'); symlinkSync(shared, otherLink);
      await assert.rejects(check(otherLink, tg), /not allowed/);
    }
  } finally { rmSync(outside, {recursive: true, force: true}); }
});

test('file sender accepts its own browser screenshot and refuses another user\'s screenshot', async () => {
  const paths = {};
  for (const user of ['owner', 'operator']) {
    paths[user] = join(dir, 'users', user, 'browser', 'out', 'x.png');
    mkdirSync(dirname(paths[user]), {recursive: true}); writeFileSync(paths[user], 'invented image');
  }
  let sent = 0;
  const sender = createFileSender({config, db}, {telegramSend: async () => { sent++; return {status: 'sent', receipt: 123}; }});
  for (const user of ['owner', 'operator']) {
    const chat = {...tg, user}, other = user === 'owner' ? 'operator' : 'owner';
    const out = await sender(chat, {path: paths[user]});
    assert.equal(out.status, 'sent');
    assert.equal(db.prepare('SELECT user FROM artifacts WHERE id=?').get(out.artifact).user, user);
    assert.deepEqual(await sender(chat, {path: paths[other]}), {status: 'failed', error: 'File path is not allowed.'});
  }
  assert.equal(sent, 2, 'only the two authorized screenshots were delivered');
});

test('Telegram streams multipart bytes from the copy with a formatted caption over the send agent', async () => {
  const a = await storeArtifact(config, db, tg, {path: source, caption: '**Ready**'});
  writeFileSync(source, 'later change');
  const t = transport(); const out = await sendFile(999, a, {request: t.request});
  assert.deepEqual(out, {status: 'sent', receipt: 42});
  const c = t.calls[0]; assert.match(c.options.path, /\/sendDocument$/);
  assert.equal(c.options.agent.maxSockets, 6); assert.equal(Number(c.options.headers['Content-Length']), c.body.length);
  assert.match(c.body.toString(), /name="caption"\r\n\r\n<b>Ready<\/b>/);
  assert.match(c.body.toString(), /name="parse_mode"\r\n\r\nHTML/);
  assert.match(c.body.toString(), /name="document"; filename="report.xlsx"/);
  const start = c.body.indexOf(Buffer.from(`Content-Type: ${a.mime}\r\n\r\n`)) + Buffer.byteLength(`Content-Type: ${a.mime}\r\n\r\n`);
  assert.deepEqual(c.body.subarray(start, start + a.size), bytes);
  writeFileSync(source, bytes);
});

test('Telegram photo/document choice, plain-caption fallback, explicit failure and ambiguous dropped response', async () => {
  for (const ext of ['jpg', 'png', 'webp']) {
    const path = join(config.workspace, `picture.${ext}`); writeFileSync(path, 'invented image');
    const a = await storeArtifact(config, db, tg, {path, caption: '*hello*'});
    const t = transport(); assert.equal((await sendFile(1, a, {request: t.request})).status, 'sent');
    assert.match(t.calls[0].options.path, /\/sendPhoto$/); assert.match(t.calls[0].body.toString(), /name="photo"/);
  }
  const big = join(config.workspace, 'big.png'); writeFileSync(big, ''); truncateSync(big, 10 * 1024 * 1024 + 1);
  const photo = await storeArtifact(config, db, tg, {path: big});
  const t = transport(); await sendFile(1, photo, {request: t.request}); assert.match(t.calls[0].options.path, /\/sendDocument$/);
  const a = await storeArtifact(config, db, tg, {path: source, caption: '**Ready**'});
  const fallback = transport([{ok: false, error_code: 400, description: 'bad entities'}, {ok: true, result: {message_id: 99}}]);
  assert.deepEqual(await sendFile(1, a, {request: fallback.request}), {status: 'sent', receipt: 99});
  assert.equal(fallback.calls.length, 2); assert.doesNotMatch(fallback.calls[1].body.toString(), /name="parse_mode"/);
  assert.match(fallback.calls[1].body.toString(), /\*\*Ready\*\*/);
  const failed = transport([{ok: false, error_code: 403, description: 'blocked by recipient'}]);
  assert.deepEqual(await sendFile(1, a, {request: failed.request}), {status: 'failed', error: 'blocked by recipient'});
  const dropped = transport([], {drop: true});
  assert.equal((await sendFile(1, a, {request: dropped.request})).status, 'uncertain'); assert.equal(dropped.calls.length, 1);
  const early = transport([], {early: true}); assert.equal((await sendFile(1, a, {request: early.request})).status, 'failed');
  const malformed = transport([null]); assert.equal((await sendFile(1, a, {request: malformed.request})).status, 'uncertain');
  const stalled = (opts, callback) => {
    const req = new Writable({autoDestroy: false, write(c, enc, cb) { cb(); }});
    opts.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('timeout'), {name: 'AbortError'})));
    return req;
  };
  await assert.rejects(multipart('invented', 'sendDocument', {}, a, {request: stalled, timeoutMs: 30}), e => e.bodyWritten && e.message === 'aborted');
});

let release;
const fakeAgent = {
  async turn({onDelta}) { onDelta('Working'); await new Promise(r => { release = r; }); return {text: 'Here it is.', durationMs: 1}; },
  newSession() {}, stop() { release?.(); return true; },
};
const chat = new WebChat({agent: fakeAgent});
const ctx = {config: {...config, sessionSecret: 'invented-session-secret'}, db, chat, agent: {busyCount: () => 0}};
const internal = createInternal(ctx);
const tokenOf = (user, thread) => credentials({user, channel: 'web', chatId: `${user}#${thread}`});
const sendRequest = (token, body, extra = {}) => invoke(internal, '/internal/send-file', {body, headers: {'x-chat-token': token, ...extra}});

test('chat tokens: missing/wrong/operator tokens, proxy and non-loopback refused; destination cannot be overridden', async () => { // gitleaks:allow (test title)
  const thread = chat.createThread('owner', 'files').id, other = chat.createThread('operator', 'operator files').id;
  const token = tokenOf('owner', thread), opToken = tokenOf('operator', other);
  assert.equal(Buffer.from(token, 'base64url').length, 32); assert.notEqual(token, opToken);
  assert.deepEqual(chatForToken(token), {user: 'owner', channel: 'web', chatId: `owner#${thread}`, simulation: undefined});
  const operator = createHash('sha256').update(ctx.config.sessionSecret + ':internal').digest('hex');
  for (const headers of [{}, {'x-chat-token': 'wrong'}, {'x-internal-token': operator}]) {
    const {res} = await invoke(internal, '/internal/send-file', {body: {path: source}, headers}); assert.equal(res.statusCode, 404);
  }
  assert.equal((await sendRequest(token, {path: source}, {'x-real-ip': '127.0.0.1'})).res.statusCode, 404);
  assert.equal((await sendRequest(token, {path: source}, {'x-real-ip': ''})).res.statusCode, 404);
  assert.equal((await invoke(internal, '/internal/send-file', {body: {path: source}, headers: {'x-chat-token': token}, remote: '203.0.113.8'})).res.statusCode, 404);
  assert.equal((await sendRequest(token, {path: source, chatId: `operator#${other}`})).res.json().status, 'failed');
  const out = (await sendRequest(opToken, {path: source})).res.json(); assert.equal(out.status, 'sent');
  assert.equal(chat.history('owner', {thread}).messages.length, 0);
  assert.equal(chat.history('operator', {thread: other}).messages[0].files[0].artifact, out.artifact);
  const ephemeral = chatCredentials(tg), t = ephemeral.env.MASTAN_ME_CHAT_TOKEN; ephemeral.revoke(); assert.equal(chatForToken(t), undefined);
});

test('web running turn: send attaches to its assistant, emits SSE, survives history and finish; idle send adds a message', async () => {
  const thread = chat.createThread('owner', 'active files').id;
  const token = tokenOf('owner', thread);
  const web = createWeb(ctx);
  A.addCredential(db, {id: 'invented-file-credential', publicKey: new Uint8Array([1, 2, 3])});
  const session = A.createSession(db, 'invented-file-credential');
  const stream = await invoke(web, '/api/chat/stream', {headers: {cookie: `${COOKIE}=${session.value}`}});
  try {
    chat.send('owner', {thread, text: 'make a report'});
    const id = chat.liveView(thread).id;
    const first = (await sendRequest(token, {path: source, caption: 'Your report'})).res.json();
    assert.equal(first.status, 'sent'); assert.equal(first.receipt, id);
    assert.equal(chat.row(id).files[0].artifact, first.artifact);
    assert.match(stream.res.body().toString(), /event: artifact\ndata: .*"running":true/);
    assert.equal(chat.liveView(thread).files[0].artifact, first.artifact);
    const reloaded = new WebChat({agent: fakeAgent});
    assert.equal(reloaded.history('owner', {thread}).messages.at(-1).files[0].artifact, first.artifact);
    release(); await new Promise(r => setImmediate(r));
    assert.equal(chat.row(id).status, 'done'); assert.equal(chat.row(id).files[0].artifact, first.artifact);
    assert.match(stream.res.body().toString(), /event: done\ndata: .*"files":\[\{"name":"report.xlsx"/);
    const second = (await sendRequest(token, {path: source})).res.json();
    assert.notEqual(second.receipt, id); assert.equal(chat.row(second.receipt).role, 'assistant');
    assert.match(stream.res.body().toString(), /"running":false/);
  } finally { stream.req.emit('close'); stream.res.end(); }
});

test('web downloads: session and per-user access, exact bytes, safe RFC filename, inline images only, missing file', async () => {
  const web = createWeb(ctx);
  const owner = A.createSession(db, 'invented-file-credential'), op = A.createSession(db, A.OPERATOR);
  const cookies = {owner: `${COOKIE}=${owner.value}`, operator: `${COOKIE}=${op.value}`};
  for (const user of ['owner', 'operator']) {
    const thread = chat.resolveThread(user).id;
    const out = (await sendRequest(tokenOf(user, thread), {path: source, name: 'Quarter تقرير.xlsx'})).res.json();
    const url = `/api/chat/out/${out.artifact}`;
    assert.equal((await invoke(web, url)).res.statusCode, 401);
    const own = (await invoke(web, url, {headers: {cookie: cookies[user]}})).res;
    assert.equal(own.statusCode, 200); assert.deepEqual(own.body(), bytes);
    assert.match(own.headers['content-disposition'], /^attachment; filename="Quarter _+\.xlsx"; filename\*=UTF-8''Quarter%20/);
    assert.equal(own.headers['cache-control'], 'private, no-store'); assert.equal(own.headers['x-content-type-options'], 'nosniff');
    assert.equal(own.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal((await invoke(web, url, {headers: {cookie: cookies[user === 'owner' ? 'operator' : 'owner']}})).res.statusCode, 404);
    assert.equal((await invoke(web, url + '?inline=1', {headers: {cookie: cookies[user]}})).res.statusCode, 404);
    const head = (await invoke(web, url, {method: 'HEAD', headers: {cookie: cookies[user]}})).res;
    assert.equal(head.statusCode, 200); assert.equal(head.body().length, 0);
    const row = db.prepare('SELECT * FROM artifacts WHERE id=?').get(out.artifact); rmSync(row.stored_path);
    assert.equal((await invoke(web, url, {headers: {cookie: cookies[user]}})).res.statusCode, 404);
  }
  const image = join(config.workspace, 'preview.png'); writeFileSync(image, bytes);
  const out = (await sendRequest(tokenOf('owner', chat.resolveThread('owner').id), {path: image})).res.json();
  const inline = (await invoke(web, `/api/chat/out/${out.artifact}?inline=1`, {headers: {cookie: cookies.owner}})).res;
  assert.equal(inline.statusCode, 200); assert.match(inline.headers['content-disposition'], /^inline;/); assert.equal(inline.headers['content-type'], 'image/png');
  assert.deepEqual(inline.body(), bytes);
  assert.equal((await invoke(web, '/api/chat/out/unknown', {headers: {cookie: cookies.owner}})).res.statusCode, 404);
});

test('simulation route captures an out-of-context HTTP file send, filename and size, without Telegram transport', async () => {
  let simInternal, sent, wireCalls = 0;
  const agent = {busyCount: () => 0, busy: () => false, async turn({chatId}) {
    const token = credentials({...tg, chatId, simulation: sim.getStore()});
    // This is a new request, outside the operator request's AsyncLocalStorage context.
    sent = await sim.exit(() => invoke(simInternal, '/internal/send-file', {body: {path: source, caption: 'sim report'}, headers: {'x-chat-token': token}}));
    return {text: 'Sent.', durationMs: 1};
  }};
  const telegram = new TelegramChannel({agent});
  simInternal = createInternal({...ctx, agent, telegram}, {telegramSend: (id, file, options) => sendFile(id, file, {...options,
    request() { wireCalls++; throw new Error('Unexpected transport'); }})});
  const token = createHash('sha256').update(ctx.config.sessionSecret + ':internal').digest('hex');
  const out = (await invoke(simInternal, '/internal/telegram-sim', {body: {text: 'make a file'}, headers: {'x-internal-token': token}})).res.json();
  const file = out.calls.find(c => c.filename);
  assert.deepEqual(file, {method: 'sendDocument', filename: 'report.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: bytes.length, caption: 'sim report'});
  assert.equal(sent.res.json().status, 'sent');
  assert.equal(wireCalls, 0);
});

test('picker accepts every office/data extension; MIME-only uploads acquire the right extension and file chip metadata', () => {
  const html = readFileSync(new URL('../src/web/chatclient/index.html', import.meta.url), 'utf8');
  const accept = html.match(/id="file-input"[^>]*accept="([^"]+)"/)[1].split(',');
  for (const ext of ['xlsx', 'xls', 'xlsm', 'csv', 'tsv', 'docx', 'doc', 'rtf', 'odt', 'ods', 'odp', 'pptx', 'ppt', 'txt', 'md', 'json', 'pdf', 'zip']) assert.ok(accept.includes('.' + ext), ext);
  assert.ok(accept.includes('image/*'));
  const files = chat.saveFiles('operator', [{name: 'spreadsheet', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: bytes},
    {name: 'slides', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: bytes},
    {name: 'macro', type: 'application/vnd.ms-excel.sheet.macroenabled.12', data: bytes}]);
  assert.match(files[0].path, /spreadsheet\.xlsx$/); assert.match(files[1].path, /slides\.pptx$/); assert.match(files[2].path, /macro\.xlsm$/);
  assert.deepEqual(readFileSync(files[0].path), bytes);
});

test('mastan-me-send executable prints one JSON line with exit codes 0, 1, 2, 3; RPC never sends an operator token', async () => {
  const preload = join(dir, 'fetch-fixture.mjs');
  writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify({status: process.env.FAKE_STATUS, artifact: 'invented-artifact'}));\n`);
  const bin = join(process.cwd(), 'bin/mastan-me-send');
  for (const [status, code] of [['sent', 0], ['failed', 1], ['uncertain', 2], ['unavailable', 3]]) {
    const env = {PATH: dirname(process.execPath) + ':/usr/bin:/bin', NODE_OPTIONS: `--import=${preload}`, FAKE_STATUS: status,
      ...(status === 'unavailable' ? {} : {MASTAN_ME_RPC: 'http://127.0.0.1:3100', MASTAN_ME_CHAT_TOKEN: 'invented-chat-value'})};
    const p = spawnSync(bin, [source, '--caption', 'hello', '--name', 'report.xlsx'], {env, encoding: 'utf8'});
    assert.equal(p.status, code, p.stderr); assert.equal(p.stdout.trim().split('\n').length, 1); assert.equal(JSON.parse(p.stdout).status, status);
  }
  let calls = 0;
  const env = {MASTAN_ME_RPC: 'http://127.0.0.1:3100', MASTAN_ME_CHAT_TOKEN: 'invented-chat-value', X_INTERNAL_TOKEN: 'never-forward'};
  const result = await send([source, '--caption', 'hello', '--name', 'visible.xlsx'], {env, request: async (url, options) => {
    calls++; assert.equal(String(url), 'http://127.0.0.1:3100/internal/send-file');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Content-Type', 'X-Chat-Token']);
    assert.equal(JSON.parse(options.body).name, 'visible.xlsx'); assert.equal(JSON.parse(options.body).path, source);
    return new Response(JSON.stringify({status: 'sent', receipt: 55}));
  }});
  assert.equal(result.status, 'sent'); assert.equal(calls, 1);
  assert.equal((await send([source, '--bad', 'x'], {env})).status, 'failed');
  assert.equal((await send([source], {env, request: async () => { throw new Error('lost'); }})).status, 'uncertain');
});
