// Offline Fleet routes: real sessions, in-memory HTTP and a fake Unix gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import net from 'node:net';

const data = mkdtempSync(join(tmpdir(), 'fleet-web-'));
process.env.MASTAN_ME_DATA = data;
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const A = await import('../src/web/auth.js');
const db = openDb();
A.addCredential(db, {id: 'fixture-owner-passkey', publicKey: new Uint8Array(32).fill(1)});
const owner = A.createSession(db, 'fixture-owner-passkey'), operator = A.createSession(db, A.OPERATOR);
const socketPath = join(data, 'gate.sock');
const ctx = {config, db, atlas: {stats: () => ({})}, fleetSocket: socketPath};
const web = createWeb(ctx);
test.after(() => { db.close(); rmSync(data, {recursive: true, force: true}); });

function request(path, {session = owner, method = 'GET', body, csrf = true, origin = 'https://me.example.com', contentType = 'application/json', handler = web} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.url = path; req.method = method;
    req.headers = {host: 'me.example.com', ...(session ? {cookie: `${COOKIE}=${session.value}`} : {}),
      ...(method === 'POST' ? {origin, ...(csrf && session ? {'x-csrf-token': session.csrf} : {})} : {}),
      ...(payload ? {'content-type': contentType, 'content-length': String(payload.length)} : {})};
    req.socket = {localPort: 3100, remoteAddress: '127.0.0.1'};
    const headers = {};
    const res = {headersSent: false, statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      writeHead(status, values = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(values)) this.setHeader(k, v); },
      end(value) { const text = String(value ?? ''); let json; try { json = JSON.parse(text); } catch {} resolve({status: this.statusCode, headers, text, json}); }};
    handler(req, res).catch(reject);
  });
}

const id = 'a'.repeat(32);
test('fleet API and actions are 404 for anonymous and operator sessions; signed out, the page goes to sign-in', async () => {
  assert.equal((await request('/fleet', {session: null})).status, 303);
  assert.equal((await request('/fleet', {session: operator})).status, 404);
  for (const session of [null, operator]) {
    for (const path of ['/api/fleet', `/api/fleet/challenge/${id}`]) assert.equal((await request(path, {session})).status, 404);
    for (const op of ['approve', 'deny']) assert.equal((await request(`/api/fleet/${op}/${id}`, {session, method: 'POST', body: {}})).status, 404);
  }
  const page = await request('/fleet');
  assert.equal(page.status, 200); assert.match(page.text, /fleet\.js/); assert.match(page.text, /webauthn\.js/);
  assert.match(page.text, /csrf-token/); assert.match(page.text, /href="\/fleet" aria-current="page"/);
  assert.doesNotMatch(page.text, /\son[a-z]+=|style="/i);
  assert.doesNotMatch((await request('/chat', {session: operator})).text, /href="\/fleet"/);
});

test('fleet POSTs enforce CSRF, same-origin and JSON rules', async () => {
  for (const op of ['approve', 'deny']) {
    assert.equal((await request(`/api/fleet/${op}/${id}`, {method: 'POST', body: {}, csrf: false})).status, 403);
    assert.equal((await request(`/api/fleet/${op}/${id}`, {method: 'POST', body: {}, origin: 'https://invented.invalid'})).status, 403);
    assert.equal((await request(`/api/fleet/${op}/${id}`, {method: 'POST', body: {}, contentType: 'text/plain'})).status, 415);
  }
  assert.equal((await request(`/api/fleet/approve/${id}`)).status, 405);
  assert.equal((await request(`/api/fleet/challenge/${id}`, {method: 'POST', body: {}})).status, 405);
  assert.equal((await request('/api/fleet/challenge/not-an-id')).status, 404);
});

test('missing gate gives Owner an explicit install message', async () => {
  const result = await request('/api/fleet');
  assert.equal(result.status, 200); assert.equal(result.json.installed, false); assert.match(result.json.error, /not installed/);
});

test('in-memory relay preserves gate data and browser assertions and exposes only safe refusals', async () => {
  const calls = [];
  const handler = createWeb(ctx, {fleetTransport: async (req, options) => {
    assert.equal(options.socketPath, socketPath); calls.push(req);
    if (req.op === 'servers') return {ok: true, servers: [{name: 'fixture-01', reachable: true}]};
    if (req.op === 'pending') return {ok: true, pending: [{id, command: 'true', reason: 'invented'}]};
    if (req.op === 'requests') return {ok: true, requests: [{id, state: 'done', exit_code: 0, output: 'invented output'}]};
    if (req.op === 'challenge') return {ok: true, challenge: 'invented-challenge', rpId: 'me.example.com'};
    if (req.op === 'approve') return {ok: false, error: 'passkey verification failed'};
    return {ok: true, state: 'denied'};
  }});
  const get = path => request(path, {handler});
  const post = (op, body) => request(`/api/fleet/${op}/${id}`, {handler, method: 'POST', body});
  const list = await get('/api/fleet');
  assert.equal(list.status, 200); assert.equal(list.json.installed, true); assert.equal(list.json.requests[0].output, 'invented output');
  assert.ok(calls.some(c => c.op === 'requests' && c.n === 20));
  assert.equal((await get(`/api/fleet/challenge/${id}`)).json.challenge, 'invented-challenge');
  const assertion = {id: 'invented', response: {signature: 'invented signature'}};
  const refused = await post('approve', assertion);
  assert.equal(refused.status, 400); assert.equal(refused.json.error, 'passkey verification failed');
  assert.deepEqual(calls.find(c => c.op === 'approve'), {op: 'approve', id, assertion});
  assert.equal((await post('deny', {})).json.state, 'denied');
});

test('fleet routes relay listed operations and exact browser assertion to a fake gate socket', async t => {
  const received = [];
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const req = JSON.parse(input.trim()); received.push(req);
      const output = {ok: true};
      if (req.op === 'servers') output.servers = [{name: 'fixture-01', client: 'invented', reachable: true, health: 'up'}];
      if (req.op === 'pending') output.pending = [{id, server: 'fixture-01', command: 'true', reason: 'invented', state: 'pending'}];
      if (req.op === 'requests') output.requests = [{id, state: 'done', exit_code: 0, output: 'invented output'}];
      if (req.op === 'challenge') Object.assign(output, {challenge: 'invented-challenge', rpId: 'me.example.com', userVerification: 'required'});
      if (req.op === 'approve' || req.op === 'deny') output.state = req.op === 'approve' ? 'approved' : 'denied';
      socket.end(JSON.stringify(output) + '\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const list = await request('/api/fleet');
  assert.equal(list.status, 200); assert.equal(list.json.installed, true); assert.equal(list.json.requests[0].output, 'invented output');
  assert.ok(received.some(r => r.op === 'requests' && r.n === 20));
  assert.equal((await request(`/api/fleet/challenge/${id}`)).json.challenge, 'invented-challenge');
  const assertion = {id: 'invented-id', rawId: 'invented-id', type: 'public-key', response: {signature: 'invented'}};
  assert.equal((await request(`/api/fleet/approve/${id}`, {method: 'POST', body: assertion})).json.state, 'approved');
  assert.deepEqual(received.find(r => r.op === 'approve'), {op: 'approve', id, assertion});
  assert.equal((await request(`/api/fleet/deny/${id}`, {method: 'POST', body: {}})).json.state, 'denied');
  assert.equal((await request(`/api/fleet/deny/${id}`, {method: 'POST', body: {command: 'bad'}})).status, 400);
});

test('fleet usage is passkey only and survives a missing file', async () => {
  const file = join(data, 'usage.json');
  ctx.fleetUsageFile = file;
  for (const session of [null, operator]) assert.equal((await request('/api/fleet/usage', {session})).status, 404);
  assert.deepEqual((await request('/api/fleet/usage')).json, {available: false});
  writeFileSync(file, JSON.stringify({generated_at: 1, servers: []}));
  assert.deepEqual((await request('/api/fleet/usage')).json, {generated_at: 1, servers: []});
});

test('/fleet/ is the same page with the same gates', async () => {
  assert.equal((await request('/fleet/', {session: null})).status, 303);
  assert.equal((await request('/fleet/', {session: operator})).status, 404);
  const page = await request('/fleet/');
  assert.equal(page.status, 200); assert.match(page.text, /href="\/fleet" aria-current="page"/);
});

test('stats page and numbers file: owner only, and the page still loads without the file', async () => {
  const file = join(data, 'stats.json');
  ctx.statsFile = file;
  assert.equal((await request('/stats', {session: null})).status, 303);
  assert.equal((await request('/stats', {session: operator})).status, 404);
  for (const session of [null, operator]) assert.equal((await request('/api/numbers', {session})).status, 404);
  assert.doesNotMatch((await request('/chat', {session: operator})).text, /href="\/stats"/);
  for (const path of ['/stats', '/stats/']) {
    const page = await request(path);
    assert.equal(page.status, 200); assert.match(page.text, /stats\.js/); assert.match(page.text, /href="\/stats" aria-current="page"/);
  }
  assert.deepEqual((await request('/api/numbers')).json, {available: false});
  writeFileSync(file, '{"totals":{"messages":1}}');
  assert.deepEqual((await request('/api/numbers')).json, {totals: {messages: 1}});
  assert.equal((await request('/api/numbers', {method: 'POST', body: {}})).status, 404);
  const asset = (await request('/stats')).text.match(/src="(\/static\/stats\.js[^"]*)"/)[1];
  assert.equal((await request(asset)).status, 200);
});

test('traffic page and visits file: owner only, and the page still loads without the file', async () => {
  const file = join(data, 'traffic.json');
  ctx.trafficFile = file;
  assert.equal((await request('/traffic', {session: null})).status, 303);
  assert.equal((await request('/traffic', {session: operator})).status, 404);
  for (const session of [null, operator]) assert.equal((await request('/api/traffic', {session})).status, 404);
  assert.doesNotMatch((await request('/chat', {session: operator})).text, /href="\/traffic"/);
  for (const path of ['/traffic', '/traffic/']) {
    const page = await request(path);
    assert.equal(page.status, 200); assert.match(page.text, /traffic\.js/); assert.match(page.text, /href="\/traffic" aria-current="page"/);
  }
  assert.deepEqual((await request('/api/traffic')).json, {available: false});
  writeFileSync(file, '{"available":true,"visits":[]}');
  assert.deepEqual((await request('/api/traffic')).json, {available: true, visits: []});
  assert.equal((await request('/api/traffic', {method: 'POST', body: {}})).status, 404);
  assert.equal((await request((await request('/traffic')).text.match(/src="(\/static\/traffic\.js[^"]*)"/)[1])).status, 200);
});

test('people: page and routes are owner only, the web service only relays to the gate', async () => {
  assert.equal((await request('/people', {session: null})).status, 303);
  assert.equal((await request('/people', {session: operator})).status, 404);
  assert.doesNotMatch((await request('/chat', {session: operator})).text, /href="\/people"/);
  for (const session of [null, operator]) {
    assert.equal((await request('/api/fleet/people', {session, method: 'POST', body: {}})).status, 404);
  }
  const page = await request('/people');
  assert.equal(page.status, 200); assert.match(page.text, /people\.js/); assert.doesNotMatch(page.text, /webauthn\.js/);
  const seen = [];
  const handler = createWeb(ctx, {fleetTransport: async op => { seen.push(op); return {ok: true, people: {people: []}}; }});
  assert.deepEqual((await request('/api/fleet/people', {handler, method: 'POST', body: {}})).json.people, {people: []});
  assert.equal((await request('/api/fleet/people', {handler, method: 'POST', body: {id: 'x'}})).status, 400);
  assert.equal((await request('/api/fleet/people', {handler, method: 'POST', body: {}, csrf: false})).status, 403);
  assert.deepEqual(seen, [{op: 'people'}]);
  assert.equal((await request('/api/fleet/people')).status, 404);
});
