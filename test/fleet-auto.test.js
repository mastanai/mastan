// End to end with invented data: the real gate on a real socket, the real mastan-fleet CLI, the real web and internal routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {generateKeyPairSync, createHash, randomBytes, sign} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {verifyAuthenticationResponse} from '@simplewebauthn/server';

const data = mkdtempSync(join(tmpdir(), 'fleet-auto-'));
process.env.MASTAN_ME_DATA = data;
process.env.MASTAN_ME_WORKSPACE = join(data, 'workspace');
process.env.MASTAN_ME_HOST = 'me.example.com';
process.env.MASTAN_ME_ORIGIN = 'https://me.example.com';
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const {LEASE_COOKIE} = await import('../src/web/fleet.js');
const A = await import('../src/web/auth.js');
const {createInternal} = await import('../src/internal.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const {chatCredentials} = await import('../src/chat-tokens.js');
const {FleetGate, createGateServer, RP_ID, ORIGIN} = await import('../fleet-gate/gate.mjs');

const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'P-256'});
const jwk = publicKey.export({format: 'jwk'});
const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y, 'base64url')]);
const credential = {id: randomBytes(32).toString('base64url'), public_key_b64: cose.toString('base64'), transports: ['internal']};
const sha = text => createHash('sha256').update(text).digest();
let counter = 0;
function assertion(challenge) {
  const clientDataJSON = Buffer.from(JSON.stringify({type: 'webauthn.get', origin: ORIGIN, challenge, crossOrigin: false}));
  const auth = Buffer.alloc(37); sha(RP_ID).copy(auth); auth[32] = 5; auth.writeUInt32BE(++counter, 33);
  return {id: credential.id, rawId: credential.id, type: 'public-key', clientExtensionResults: {}, response: {clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: auth.toString('base64url'), signature: sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), privateKey).toString('base64url'), userHandle: null}};
}

const ran = [];
const gate = new FleetGate({state: join(data, 'gate'), servers: () => [{name: 'fixture-01', host: '192.0.2.11'}, {name: 'dev-01', host: '192.0.2.12'}],
  passkeys: () => [credential], verify: verifyAuthenticationResponse, executor: async (host, command) => { ran.push(command); return {exit_code: 0, output: 'invented output\n'}; }});
writeFileSync(join(data, 'gate', 'people.json'), JSON.stringify({people: [{id: '+10000000001'}]}));
const socketPath = join(data, 'gate.sock');
const gateServer = createGateServer(gate);
await new Promise(done => gateServer.listen(socketPath, done));

// The fake agent runs what a real turn's Bash tool would run: the CLI with this chat's own token.
const cli = (command, token) => new Promise(resolve => {
  execFile('python3', ['fleet-gate/mastan-fleet', 'run', 'fixture-01', '--reason', 'Invented', '--', command],
    {env: {PATH: process.env.PATH, MASTAN_FLEET_SOCKET: socketPath, ...(token ? {MASTAN_ME_RPC: `http://127.0.0.1:${rpcPort}`, MASTAN_ME_CHAT_TOKEN: token} : {})}},
    (error, stdout) => resolve({code: error?.code ?? 0, stdout}));
});
let script = async () => 'ok', prompts = [];
const agent = {
  async turn({chatId, text}) { prompts.push(text); return {text: await script({chatId, text}), durationMs: 1, sessionId: 's', model: 'fake'}; },
  stop: () => false, newSession() {}, warm: () => false,
};
const db = openDb();
const chat = new WebChat({agent, runBusy: async () => ({reply: 'Queued.', queue: true})});
const ctx = {config, db, atlas: {stats: () => ({})}, fleetSocket: socketPath, chat};
const web = createWeb(ctx);
const internal = createInternal(ctx);
const rpc = http.createServer((req, res) => internal(req, res));
await new Promise(done => rpc.listen(0, '127.0.0.1', done));
const rpcPort = rpc.address().port;
A.addCredential(db, {id: 'fixture-owner-passkey', publicKey: new Uint8Array(32).fill(1)});
const owner = A.createSession(db, 'fixture-owner-passkey');
const webToken = thread => chatCredentials({user: 'owner', channel: 'web', chatId: `owner#${thread}`}).env.MASTAN_ME_CHAT_TOKEN;

test.after(async () => {
  rpc.close(); await new Promise(done => gateServer.close(done));
  await Promise.allSettled(gate.jobs); gate.close(); db.close(); rmSync(data, {recursive: true, force: true});
});

function request(path, {method = 'GET', body, lease} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.url = path; req.method = method;
    req.headers = {host: config.host, cookie: `${COOKIE}=${owner.value}${lease ? `; ${LEASE_COOKIE}=${lease}` : ''}`,
      ...(method === 'POST' ? {origin: config.origin, 'x-csrf-token': owner.csrf} : {}), ...(payload ? {'content-type': 'application/json', 'content-length': String(payload.length)} : {})};
    req.socket = {localPort: 3100, remoteAddress: '127.0.0.1'};
    const headers = {};
    const res = {headersSent: false, statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; },
      appendHeader(k, v) { const key = k.toLowerCase(); headers[key] = [headers[key] || []].flat().concat(v); },
      writeHead(status, values = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(values)) this.setHeader(k, v); },
      end(value) { const text = String(value ?? ''); let json; try { json = JSON.parse(text); } catch {} resolve({status: this.statusCode, headers, text, json}); }};
    web(req, res).catch(reject);
  });
}
async function openLease() {
  const options = await request('/api/fleet/auto/challenge');
  const out = await request('/api/fleet/auto/open', {method: 'POST', body: {challenge: options.json.challenge, assertion: assertion(options.json.challenge)}});
  assert.equal(out.status, 200); assert.equal(out.json.on, true); assert.equal(out.json.lease, true);
  const set = [out.headers['set-cookie']].flat().find(c => c.startsWith(LEASE_COOKIE));
  assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Strict/);
  return set.split(';')[0].split('=')[1];
}
const until = async fn => { for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('timed out'); };
const newThread = () => chat.createThread('owner', 'Invented', {force: true}).id;
const pendingIds = async () => (await request('/api/fleet/pending')).json.pending.map(r => r.id);
const send = (thread, lease) => request(`/api/sessions/${thread}/messages`, {method: 'POST', body: {text: 'please run it'}, lease});

test('a web turn with a lease runs the command with no card; the toggle stops it; the feed shows it', async () => {
  const lease = await openLease(), thread = newThread();
  let out, before = ran.length;
  script = async () => { out = await cli('echo first', webToken(thread)); return 'done'; };
  assert.equal((await send(thread, lease)).status, 200);
  await until(() => out && !chat.busy(thread));
  assert.equal(out.code, 0); assert.match(out.stdout, /done\s+exit=0/); assert.match(out.stdout, /invented output/);
  assert.deepEqual(ran.slice(before), ['echo first']);
  const view = (await request('/api/fleet/pending', {lease})).json;
  assert.deepEqual(view.pending, []); assert.equal(view.autoState.on, true); assert.equal(view.autoState.lease, true);
  assert.equal(view.auto[0].command, 'echo first'); assert.equal(view.auto[0].auto, 1); assert.ok(!JSON.stringify(view).includes(lease));

  assert.equal((await request('/api/fleet/auto', {method: 'POST', body: {on: false}, lease})).json.on, false);
  let id; before = ran.length;
  script = async () => {
    const start = await new Promise(resolve => execFile('python3', ['fleet-gate/mastan-fleet', '--json', 'run', 'fixture-01', '--reason', 'Invented', '--', 'echo off'],
      {env: {PATH: process.env.PATH, MASTAN_FLEET_SOCKET: socketPath}}, (e, stdout) => resolve(JSON.parse(stdout))));
    id = start.id; return 'asked';
  };
  await send(thread, lease);
  await until(() => id && !chat.busy(thread));
  assert.equal(ran.length, before); assert.ok((await pendingIds()).includes(id));
  await gate.handle({op: 'cancel', id});
  assert.equal((await request('/api/fleet/auto', {method: 'POST', body: {on: true}})).status, 400); // no lease, no turning on
  assert.equal((await request('/api/fleet/auto', {method: 'POST', body: {on: true}, lease})).json.on, true);
});

test('Telegram, tasks, a forged session with no lease and a stale token never auto-approve', async () => {
  const lease = await openLease(), thread = newThread(), before = ran.length;
  const asChat = async (token) => {
    const made = await gate.handle({op: 'run', server: 'fixture-01', command: 'echo blocked', reason: 'Invented'});
    const res = await fetch(`http://127.0.0.1:${rpcPort}/internal/fleet-run`, {method: 'POST', headers: {'x-chat-token': token, 'content-type': 'application/json'}, body: JSON.stringify({id: made.id})});
    return {made, answer: res.status === 200 ? await res.json() : {status: res.status}};
  };
  // A turn with a lease is running in the thread for the whole check.
  let release; script = () => new Promise(done => { release = () => done('ok'); });
  await send(thread, lease);
  const telegram = chatCredentials({user: 'owner', channel: 'telegram', chatId: '1'}).env.MASTAN_ME_CHAT_TOKEN;
  const task = chatCredentials({user: 'owner', channel: 'web', chatId: `owner#${thread}`, kind: 'task', taskId: 7}).env.MASTAN_ME_CHAT_TOKEN;
  const operator = chatCredentials({user: 'operator', channel: 'web', chatId: `operator#${thread}`}).env.MASTAN_ME_CHAT_TOKEN;
  for (const token of [telegram, task, operator, 'invented']) {
    const {made, answer} = await asChat(token);
    assert.notEqual(answer.auto, true); assert.equal(gate.get(made.id).state, 'pending');
    await gate.handle({op: 'cancel', id: made.id});
  }
  release(); await until(() => !chat.busy(thread));
  // Same thread, same token, but no turn is running now: a process left behind gets a card.
  const {made, answer} = await asChat(webToken(thread));
  assert.equal(answer.auto, false); assert.equal(gate.get(made.id).state, 'pending');
  await gate.handle({op: 'cancel', id: made.id});
  // A message with a session but no lease cookie is what a forged session looks like.
  let out; const other = newThread();
  script = async () => { out = await asChat(webToken(other)); return 'done'; };
  await send(other, null); await until(() => out && !chat.busy(other));
  assert.equal(out.answer.auto, false); assert.equal(gate.get(out.made.id).state, 'pending');
  await gate.handle({op: 'cancel', id: out.made.id});
  assert.equal(ran.length, before);
});

test('destructive commands stay pending for a card and dev-01 too, even in a leased turn', async () => {
  const lease = await openLease(), thread = newThread(), before = ran.length;
  let made, answer;
  script = async () => {
    made = await gate.handle({op: 'run', server: 'fixture-01', command: 'rm -rf /var/lib/mastan-public', reason: 'Invented'});
    answer = await (await fetch(`http://127.0.0.1:${rpcPort}/internal/fleet-run`, {method: 'POST', headers: {'x-chat-token': webToken(thread), 'content-type': 'application/json'}, body: JSON.stringify({id: made.id})})).json();
    return 'asked';
  };
  await send(thread, lease); await until(() => answer && !chat.busy(thread));
  assert.equal(answer.auto, false); assert.equal(ran.length, before);
  const row = (await request('/api/fleet/pending', {lease})).json.pending.find(r => r.id === made.id);
  assert.match(row.hold, /recursive delete/);
  await gate.handle({op: 'cancel', id: made.id});
});

test('a card approved after the turn ended starts a new turn with the gate result', async () => {
  const thread = newThread(); let made;
  script = async () => {
    made = await gate.handle({op: 'run', server: 'fixture-01', command: 'echo approved-later', reason: 'Invented'});
    await fetch(`http://127.0.0.1:${rpcPort}/internal/fleet-run`, {method: 'POST', headers: {'x-chat-token': webToken(thread), 'content-type': 'application/json'}, body: JSON.stringify({id: made.id})});
    return 'tap it';
  };
  await send(thread, null); await until(() => made && !chat.busy(thread));
  assert.ok((await pendingIds()).includes(made.id));
  prompts = []; script = async () => 'carried on';
  const options = await request(`/api/fleet/challenge/${made.id}`);
  const approved = await request(`/api/fleet/approve/${made.id}`, {method: 'POST', body: assertion(options.json.challenge)});
  assert.equal(approved.status, 200);
  await until(() => prompts.length === 1 && !chat.busy(thread));
  assert.match(prompts[0], new RegExp(`request ${made.id} on fixture-01 ended done, exit 0`));
  const history = chat.history('owner', {thread}).messages;
  assert.equal(history.at(-1).text, 'carried on');
  assert.equal(history.filter(m => m.role === 'user').length, 1); // no invented user message
});

test('People: a signed-in owner gets the list with no lease, a dead lease, or the switch off', async () => {
  const open = extra => request('/api/fleet/people', {method: 'POST', body: {}, ...extra});
  // A session from before leases existed: no lease cookie at all, and nothing asks for a passkey.
  const noLease = await open();
  assert.equal(noLease.status, 200); assert.equal(noLease.json.people.people[0].id, '+10000000001'); assert.equal(noLease.json.needsPasskey, undefined);
  // A lease that lapsed, or one the gate never issued.
  assert.equal((await open({lease: 'x'.repeat(43)})).json.people.people[0].id, '+10000000001');
  const lease = await openLease();
  await request('/api/fleet/auto', {method: 'POST', body: {on: false}, lease});
  assert.equal((await open({lease})).json.people.people[0].id, '+10000000001');
  await request('/api/fleet/auto', {method: 'POST', body: {on: true}, lease});
  assert.equal((await request('/api/fleet/people/lease', {method: 'POST', body: {}, lease})).status, 404);
});

test('login signs the gate challenge and sets the lease; logout closes it', async () => {
  const lease = await openLease();
  assert.equal((await gate.handle({op: 'lease_state', lease})).lease, true);
  const other = A.createSession(db, 'fixture-owner-passkey');
  const closed = await new Promise((resolve, reject) => {
    const payload = Buffer.from('{}'), req = Readable.from([payload]);
    req.url = '/api/logout'; req.method = 'POST';
    req.headers = {host: config.host, cookie: `${COOKIE}=${other.value}; ${LEASE_COOKIE}=${lease}`, origin: config.origin, 'x-csrf-token': other.csrf, 'content-type': 'application/json', 'content-length': '2'};
    req.socket = {localPort: 3100, remoteAddress: '127.0.0.1'};
    const headers = {};
    const res = {headersSent: false, statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, appendHeader(k, v) { const key = k.toLowerCase(); headers[key] = [headers[key] || []].flat().concat(v); },
      writeHead(s) { this.statusCode = s; this.headersSent = true; }, end() { resolve({status: this.statusCode, headers}); }};
    web(req, res).catch(reject);
  });
  assert.equal(closed.status, 200); assert.ok(closed.headers['set-cookie'].some(c => c.startsWith(`${LEASE_COOKIE}=;`)));
  assert.equal((await gate.handle({op: 'lease_state', lease})).lease, false);
});
