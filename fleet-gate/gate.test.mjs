import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash, randomBytes, sign} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {verifyAuthenticationResponse} from '@simplewebauthn/server';
import {FleetGate, destructive, CHECKS, createGateServer, executeSSH, RP_ID, ORIGIN, STATUS_COMMAND, KEY, KNOWN_HOSTS, OUTPUT_LIMIT, logsCommand, sshArgs, redact, capOutput, OutputCapture} from './gate.mjs';
import {fleetCall} from '../src/web/fleet.js';

const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'P-256'});
const jwk = publicKey.export({format: 'jwk'});
// COSE EC2 key: kty=2, alg=-7 (ES256), crv=1 (P-256), x, y.
const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y, 'base64url')]);
const credential = {id: randomBytes(32).toString('base64url'), public_key_b64: cose.toString('base64'), transports: ['internal']};
const sha = text => createHash('sha256').update(text).digest();
function assertion(challenge, {origin = ORIGIN, rp = RP_ID, flags = 5, counter = 1, id = credential.id, type = 'webauthn.get'} = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({type, origin, challenge, crossOrigin: false}));
  const auth = Buffer.alloc(37); sha(rp).copy(auth); auth[32] = flags; auth.writeUInt32BE(counter, 33);
  return {id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: auth.toString('base64url'),
    signature: sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), privateKey).toString('base64url'), userHandle: null}};
}
function fixture(t, options = {}) {
  const state = mkdtempSync(join(tmpdir(), 'fleet-gate-'));
  const calls = [], logged = [];
  let now = Date.now();
  const gate = new FleetGate({state, servers: () => [{name: 'fixture-01', host: '192.0.2.11', client: 'invented'}],
    passkeys: () => [credential], verify: verifyAuthenticationResponse, now: () => now,
    executor: async (...args) => { calls.push(args); return {exit_code: 0, output: 'invented output\n'}; }, log: () => logged.push('refused'), ...options});
  t.after(async () => { await Promise.allSettled(gate.jobs); gate.close(); rmSync(state, {recursive: true, force: true}); });
  const request = async () => {
    const row = await gate.handle({op: 'run', server: 'fixture-01', command: 'systemctl restart mastan-web', reason: 'Recover invented failed unit'});
    assert.equal(row.ok, true); return row;
  };
  const challenge = async id => { const out = await gate.handle({op: 'challenge', id}); assert.equal(out.ok, true); return out; };
  return {gate, state, calls, logged, request, challenge, advance: ms => { now += ms; }};
}

test('real P-256 assertion verifies, atomically claims and executes exactly once', async t => {
  const f = fixture(t), row = await f.request();
  assert.equal(row.status, 'pending'); assert.equal(row.expires - row.created, 30 * 60_000);
  assert.equal(row.approve_url, `${ORIGIN}/fleet#r${row.id}`); assert.equal(f.calls.length, 0);
  const options = await f.challenge(row.id);
  assert.equal(Buffer.from(options.challenge, 'base64url').length, 32);
  assert.equal(options.rpId, RP_ID); assert.equal(options.userVerification, 'required'); assert.equal(options.timeout, 120_000);
  assert.deepEqual(options.allowCredentials, [{id: credential.id, type: 'public-key', transports: ['internal']}]);
  const signed = assertion(options.challenge);
  const replies = await Promise.all([f.gate.handle({op: 'approve', id: row.id, assertion: signed}), f.gate.handle({op: 'approve', id: row.id, assertion: signed})]);
  assert.equal(replies.filter(r => r.ok).length, 1);
  await Promise.all(f.gate.jobs);
  const result = await f.gate.handle({op: 'result', id: row.id});
  assert.equal(result.state, 'done'); assert.equal(result.exit_code, 0); assert.equal(result.output, 'invented output\n');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].slice(0, 2), ['192.0.2.11', row.command]); assert.equal(f.calls[0][2].timeout_s, 120); assert.equal(f.calls[0][2].key, KEY);
  assert.equal(f.gate.get(row.id).challenge, null);
  assert.equal(f.gate.db.prepare('SELECT counter FROM counters').get().counter, 1);
  assert.equal((await f.gate.handle({op: 'approve', id: row.id, assertion: signed})).ok, false);
  assert.equal(f.calls.length, 1);
});

for (const [name, changes] of Object.entries({
  'wrong origin': {origin: 'https://invented.invalid'}, 'wrong rpId': {rp: 'invented.invalid'},
  'wrong challenge': {challenge: 'not-the-challenge'}, 'unknown credential': {id: 'unknown'},
  'no UV': {flags: 1}, 'no UP': {flags: 4}, 'wrong ceremony type': {type: 'webauthn.create'},
  'counter going back': {counter: 6}, 'counter equal': {counter: 7},
})) {
  test(`refuses ${name}, keeps pending and logs one safe line`, async t => {
    const f = fixture(t), row = await f.request(), options = await f.challenge(row.id);
    if (name.startsWith('counter')) f.gate.db.prepare('INSERT INTO counters VALUES(?,7)').run(credential.id);
    const signed = assertion(changes.challenge ?? options.challenge, changes);
    const out = await f.gate.handle({op: 'approve', id: row.id, assertion: signed});
    assert.equal(out.ok, false); assert.equal(f.gate.get(row.id).state, 'pending'); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.logged, ['refused']);
  });
}

test('fresh challenge replaces old, is bound to a request and expires after 120 seconds', async t => {
  const f = fixture(t), first = await f.request(), second = await f.request();
  const old = await f.challenge(first.id), fresh = await f.challenge(first.id), other = await f.challenge(second.id);
  assert.notEqual(old.challenge, fresh.challenge);
  for (const [id, challenge] of [[first.id, old.challenge], [second.id, fresh.challenge]]) {
    assert.equal((await f.gate.handle({op: 'approve', id, assertion: assertion(challenge)})).ok, false);
  }
  f.advance(120_001);
  assert.equal((await f.gate.handle({op: 'approve', id: second.id, assertion: assertion(other.challenge)})).ok, false);
  assert.equal(f.gate.get(second.id).state, 'pending'); assert.equal(f.calls.length, 0);
});

test('expiry, cancellation, denial and wait terminal states never execute', async t => {
  const f = fixture(t);
  for (const [op, state] of [['cancel', 'cancelled'], ['deny', 'denied']]) {
    const row = await f.request(), options = await f.challenge(row.id);
    const waiting = f.gate.handle({op: 'wait', id: row.id, timeout_s: 2});
    assert.equal((await f.gate.handle({op, id: row.id})).state, state);
    assert.equal((await waiting).state, state);
    assert.equal((await f.gate.handle({op: 'approve', id: row.id, assertion: assertion(options.challenge)})).ok, false);
    assert.equal((await f.gate.handle({op: 'cancel', id: row.id})).ok, false);
  }
  const row = await f.request(), options = await f.challenge(row.id);
  const waiting = f.gate.handle({op: 'wait', id: row.id});
  f.advance(30 * 60_000);
  assert.equal((await waiting).state, 'expired');
  assert.equal((await f.gate.handle({op: 'approve', id: row.id, assertion: assertion(options.challenge)})).ok, false);
  assert.equal(f.calls.length, 0);
});

test('wait resolves on done, cannot cancel approved, and pending wait timeout returns pending', async t => {
  let release;
  const f = fixture(t, {executor: () => new Promise(r => { release = r; })});
  const row = await f.request(), options = await f.challenge(row.id);
  await f.gate.handle({op: 'approve', id: row.id, assertion: assertion(options.challenge)});
  assert.equal((await f.gate.handle({op: 'cancel', id: row.id})).ok, false);
  const waiting = f.gate.handle({op: 'wait', id: row.id, timeout_s: 2});
  release({exit_code: 0, output: 'finished'});
  assert.equal((await waiting).state, 'done');
  const pending = await f.request();
  assert.equal((await f.gate.handle({op: 'wait', id: pending.id, timeout_s: 1})).state, 'pending');
  for (const timeout_s of [0, 901, 1.5, '5']) assert.equal((await f.gate.handle({op: 'wait', id: pending.id, timeout_s})).ok, false);
});

test('pinned SSH argv and fixed reads; unknown servers, extra fields and invalid arguments refused', async t => {
  const f = fixture(t);
  assert.deepEqual(sshArgs('192.0.2.11', 'printf hi'), ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', 'root@192.0.2.11', '--', 'printf hi']);
  for (const op of ['status', 'logs', 'run']) assert.equal((await f.gate.handle({op, server: 'unknown'})).ok, false);
  assert.equal((await f.gate.handle({op: 'shell'})).ok, false);
  assert.equal((await f.gate.handle({op: 'status', server: 'fixture-01', command: 'evil'})).ok, false);
  await f.gate.handle({op: 'status', server: 'fixture-01'});
  assert.equal(f.calls[0][1], STATUS_COMMAND);
  assert.equal(f.calls[0][2].timeout_s, 15);
  for (const patch of [{command: ''}, {command: 'x'.repeat(4001)}, {reason: 'two\nlines'}, {reason: 'x'.repeat(201)}, {timeout_s: 901}, {command: 'echo password=invented'}]) {
    assert.equal((await f.gate.handle({op: 'run', server: 'fixture-01', command: 'true', reason: 'fixture', ...patch})).ok, false);
  }
  const a = await f.request(), b = await f.request();
  assert.deepEqual((await f.gate.handle({op: 'requests', n: 1})).requests.map(r => r.id), [b.id]);
  assert.deepEqual((await f.gate.handle({op: 'pending'})).pending.map(r => r.id), [b.id, a.id]);
  assert.equal((await f.gate.handle({op: 'requests', n: 0})).ok, false);
});

test('logs validate every argument, quote shell words and escape grep as fixed text', () => {
  assert.equal(logsCommand({unit: 'mastan-web.service'}), "journalctl -u 'mastan-web.service' --since '-2 hours' -n 200 --no-pager -o short-iso");
  assert.match(logsCommand({unit: 'mastan-web', since: '15m', lines: 1000, grep: "a.*'$(id)"}), /--since '-15 min'/);
  assert.equal(logsCommand({unit: 'x', since: '3d', grep: 'a.*'}).split('--grep ')[1], "'a\\.\\*'");
  assert.equal(logsCommand({unit: 'x', grep: 'خطأ'}).split('--grep ')[1], "'خطأ'");
  for (const patch of [{unit: 'x;id'}, {unit: 'x'.repeat(81)}, {since: '-2h'}, {since: '1000h'}, {since: '2h;id'}, {lines: 0}, {lines: 1001}, {lines: '20'}, {grep: '\n'}, {grep: 'x'.repeat(81)}]) {
    assert.throws(() => logsCommand({unit: 'x', ...patch}));
  }
});

test('redaction, bounded UTF-8 head and tail, chunked private blocks and audit without output', async t => {
  const secrets = ['Bearer invented-bearer', 'sk-invented', '123456:abcdefghijklmnopqrst', 'password="invented two words"', "secret='invented value'", 'token=invented', 'key=invented', 'ghp_invented', 'github_pat_invented'];
  const text = secrets.join('\n') + '\n-----BEGIN OPENSSH PRIVATE KEY-----\ninvented-key-body\n-----END OPENSSH PRIVATE KEY-----\n';
  const clean = redact(text);
  assert.doesNotMatch(clean, /invented/);
  const capture = new OutputCapture();
  const raw = Buffer.from('HEAD\n' + text + 'safe line\n'.repeat(18000) + 'TAIL\n');
  for (let i = 0; i < raw.length; i += 11) capture.write(raw.subarray(i, i + 11));
  const output = capture.finish();
  assert.ok(Buffer.byteLength(output) <= OUTPUT_LIMIT); assert.match(output, /^HEAD/); assert.match(output, /TAIL\n$/);
  assert.doesNotMatch(output, /invented/);
  const utf8 = capOutput('start\n' + '🌿'.repeat(40000) + '\nend');
  assert.ok(Buffer.byteLength(utf8) <= OUTPUT_LIMIT); assert.match(utf8, /^start/); assert.match(utf8, /end$/);
  const f = fixture(t, {executor: async () => ({exit_code: 1, output: text})});
  const row = await f.request(), options = await f.challenge(row.id);
  const before = readFileSync(join(f.state, 'audit.jsonl'), 'utf8');
  await f.gate.handle({op: 'pending'}); await f.challenge(row.id);
  assert.equal(readFileSync(join(f.state, 'audit.jsonl'), 'utf8'), before);
  const fresh = await f.challenge(row.id);
  await f.gate.handle({op: 'approve', id: row.id, assertion: assertion(fresh.challenge)});
  await Promise.all(f.gate.jobs);
  const result = await f.gate.handle({op: 'result', id: row.id});
  assert.equal(result.state, 'failed'); assert.equal(result.exit_code, 1); assert.doesNotMatch(result.output, /invented/);
  const audit = readFileSync(join(f.state, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit[0].command, row.command); assert.equal(audit[0].request_id, row.id);
  assert.ok(audit.some(a => a.op === 'execute' && a.exit_code === 1));
  assert.ok(audit.every(a => !Object.hasOwn(a, 'output') && !Object.hasOwn(a, 'assertion')));
  assert.equal(f.gate.db.prepare('SELECT count(*) n FROM audit').get().n, audit.length);
});

test('servers run parallel, cache for 60 s, report unreachable and invalidate after change', async t => {
  let calls = 0, active = 0, peak = 0;
  const servers = [{name: 'fixture-01', host: '192.0.2.11', client: 'a'}, {name: 'fixture-02', host: '192.0.2.12', client: 'b'}];
  const f = fixture(t, {servers: () => servers, executor: async host => {
    calls++; active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--;
    return {exit_code: host.endsWith('11') ? 0 : 255, output: 'fixture-host\nup, load average: 0.0\n'};
  }});
  const first = await f.gate.handle({op: 'servers'});
  assert.equal(first.servers[0].reachable, true); assert.equal(first.servers[1].reachable, false); assert.equal(peak, 2);
  await f.gate.handle({op: 'servers'}); assert.equal(calls, 2);
  f.advance(60_001); await f.gate.handle({op: 'servers'}); assert.equal(calls, 4);
  const row = await f.request(), options = await f.challenge(row.id);
  await f.gate.handle({op: 'approve', id: row.id, assertion: assertion(options.challenge)});
  await Promise.all(f.gate.jobs);
  await f.gate.handle({op: 'servers'}); assert.equal(calls, 7);
});

test('changed root server config cannot redirect approval', async t => {
  let host = '192.0.2.11';
  const f = fixture(t, {servers: () => [{name: 'fixture-01', host}]});
  const row = await f.request(), options = await f.challenge(row.id); host = '192.0.2.99';
  assert.equal((await f.gate.handle({op: 'approve', id: row.id, assertion: assertion(options.challenge)})).ok, false);
  assert.equal(f.calls.length, 0);
});

test('SSH executor spawns an argv array, combines redacted streams and enforces its timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let child, argv, options, executable, killed;
  const spawnProcess = (bin, args, opts) => {
    executable = bin; argv = args; options = opts;
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = sig => { killed = sig; child.emit('close', null); };
    return child;
  };
  const run = executeSSH('192.0.2.11', 'printf fixture', {spawnProcess});
  child.stdout.write('invented stdout\n'); child.stderr.write('Bearer invented-bearer\n'); child.emit('close', 0);
  const result = await run;
  assert.equal(executable, '/usr/bin/ssh'); assert.deepEqual(argv, sshArgs('192.0.2.11', 'printf fixture'));
  assert.equal(options.shell, undefined); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(result.exit_code, 0); assert.match(result.output, /invented stdout/); assert.doesNotMatch(result.output, /invented-bearer/);
  const timed = executeSSH('192.0.2.11', 'sleep 999', {spawnProcess, timeout_s: 120});
  t.mock.timers.tick(119_999); assert.equal(killed, undefined);
  t.mock.timers.tick(1);
  assert.equal((await timed).exit_code, 124); assert.equal(killed, 'SIGKILL');
});

test('servers respect a 15-second overall limit even with a stalled executor', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let signal;
  const f = fixture(t, {executor: (_host, _command, options) => { signal = options.signal; return new Promise(() => {}); }});
  const pending = f.gate.handle({op: 'servers'});
  t.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(result.servers[0].reachable, false); assert.equal(signal.aborted, true);
  assert.match(result.servers[0].health, /15 s/);
});

test('restart does not replay an approved request and preserves counters', async t => {
  const f = fixture(t), row = await f.request();
  f.gate.db.prepare("UPDATE requests SET state='approved',challenge='obsolete' WHERE id=?").run(row.id);
  f.gate.db.prepare('INSERT INTO counters VALUES(?,7)').run(credential.id);
  // A second instance models startup against persisted state without any executor.
  const restarted = new FleetGate({state: f.state, executor: () => { throw new Error('must never execute'); }});
  t.after(() => restarted.close());
  assert.equal(restarted.get(row.id).state, 'failed');
  assert.match(restarted.get(row.id).output, /unknown/);
  assert.equal(restarted.db.prepare('SELECT counter FROM counters WHERE id=?').get(credential.id).counter, 7);
});

test('long unbroken output keeps head and tail; secrets crossing chunks stay redacted', () => {
  const capture = new OutputCapture();
  const text = 'HEAD' + 'x'.repeat(500000) + 'TAIL';
  for (let i = 0; i < text.length; i += 31) capture.write(text.slice(i, i + 31));
  const out = capture.finish();
  assert.ok(Buffer.byteLength(out) <= OUTPUT_LIMIT); assert.match(out, /^HEAD/); assert.match(out, /TAIL$/);
  const sensitive = new OutputCapture();
  sensitive.write('x'.repeat(150000) + 'Bea'); sensitive.write('rer invented-secret'); sensitive.write('z'.repeat(150000));
  assert.doesNotMatch(sensitive.finish(), /invented-secret/);
  const small = new OutputCapture(); small.write('🌿'.repeat(10000));
  assert.equal(small.finish(), '🌿'.repeat(10000));
  const blocks = new OutputCapture();
  blocks.write('-----BEGIN PRIVATE KEY-----\ninvented-one\n-----END PRIVATE KEY----- -----BEGIN RSA PRIVATE KEY-----\n');
  blocks.write('invented-two\n-----END RSA PRIVATE KEY-----\nSAFE');
  assert.doesNotMatch(blocks.finish(), /invented-one|invented-two/);
});

test('JSON line transport handles split frames, invalid JSON and bounded input without binding', async t => {
  const f = fixture(t), server = createGateServer(f.gate);
  t.after(() => server.close());
  const connect = () => {
    const client = new EventEmitter(), peer = new EventEmitter();
    client.setTimeout = peer.setTimeout = () => {};
    client.destroy = () => {};
    peer.end = answer => { queueMicrotask(() => { client.emit('data', Buffer.from(answer.slice(0, 4))); client.emit('data', Buffer.from(answer.slice(4))); client.emit('end'); }); };
    client.write = input => { peer.emit('data', Buffer.from(input.slice(0, 3))); peer.emit('data', Buffer.from(input.slice(3))); };
    server.emit('connection', peer); queueMicrotask(() => client.emit('connect'));
    return client;
  };
  const result = await fleetCall({op: 'run', server: 'fixture-01', command: 'true', reason: 'invented'}, {connect});
  assert.equal(result.state, 'pending'); assert.equal(f.calls.length, 0);
  const malformed = new EventEmitter(); malformed.setTimeout = () => {};
  let response;
  malformed.end = text => { response = JSON.parse(text); };
  server.emit('connection', malformed); malformed.emit('data', Buffer.from('not-json\n'));
  assert.equal(response.error, 'invalid JSON');
  const large = new EventEmitter(); large.setTimeout = () => {}; large.end = text => { response = JSON.parse(text); };
  server.emit('connection', large); large.emit('data', Buffer.alloc(65537, 120));
  assert.equal(response.error, 'request too large');
});

test('socket framing and relay against a real local gate socket', async t => {
  const f = fixture(t), server = createGateServer(f.gate), socketPath = join(f.state, 'gate.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await fleetCall({op: 'run', server: 'fixture-01', command: 'true', reason: 'fixture'}, {socketPath})).state, 'pending');
  const malformed = await new Promise(resolve => {
    const socket = net.createConnection(socketPath, () => { socket.write('{'); socket.end('bad}\n'); });
    let result = ''; socket.on('data', chunk => { result += chunk; }); socket.on('end', () => resolve(JSON.parse(result)));
  });
  assert.equal(malformed.ok, false);
});

test('offline Python admin, enrollment merge and CLI checks', async () => {
  const {stdout} = await promisify(execFile)('python3', ['-B', '-I', 'fleet-gate/admin_test.py']);
  assert.match(stdout, /offline admin checks passed/);
});

test('people list: no assertion, every read in the audit, the numbers never are', async t => {
  const f = fixture(t);
  const {writeFileSync} = await import('node:fs');
  const list = {people: [{id: '+10000000000'}]};
  assert.equal((await f.gate.handle({op: 'people'})).ok, false);
  writeFileSync(join(f.state, 'people.json'), JSON.stringify(list));
  const read = await f.gate.handle({op: 'people'});
  assert.equal(read.ok, true); assert.deepEqual(read.people, list);
  // The auto-approve switch and leases are about commands; they do not touch this list.
  await f.gate.handle({op: 'lease_set', on: false});
  assert.equal((await f.gate.handle({op: 'people'})).ok, true);
  // The passkey verbs are gone and arguments are refused.
  assert.equal((await f.gate.handle({op: 'people_challenge'})).ok, false);
  assert.equal((await f.gate.handle({op: 'people', lease: 'x'.repeat(43)})).ok, false);
  const audit = f.gate.db.prepare("SELECT * FROM audit WHERE op='people' AND state='ok'").all();
  assert.equal(audit.length, 2);
  assert.doesNotMatch(JSON.stringify(f.gate.db.prepare('SELECT * FROM audit').all()), /10000000000/);
});

test('checks are a fixed list: no passkey, validated arguments, logged, nothing else runs', async t => {
  const {gate, calls} = fixture(t);
  const disk = await gate.handle({op: 'check', server: 'fixture-01', name: 'disk'});
  assert.equal(disk.ok, true); assert.match(calls.at(-1)[1], /^df -h/);
  const unit = await gate.handle({op: 'check', server: 'fixture-01', name: 'unit', unit: 'mastan-web'});
  assert.equal(unit.ok, true); assert.match(calls.at(-1)[1], /systemctl status 'mastan-web'/);
  const count = calls.length;
  for (const bad of [{name: 'rm'}, {name: '__proto__'}, {name: 'constructor'}, {name: 'unit', unit: 'x; reboot'}, {name: 'unit', unit: '$(reboot)'}, {name: 'errors', since: '1h; reboot'},
    {name: 'http', port: 80, path: "/'; reboot; '"}, {name: 'http', port: 0}, {name: 'disk', unit: 'nginx'}]) {
    assert.equal((await gate.handle({op: 'check', server: 'fixture-01', ...bad})).ok, false, JSON.stringify(bad));
  }
  assert.equal(calls.length, count);
  assert.ok(Object.values(CHECKS).every(c => !/\bcat\b|\benv\b|\bps -ef\b|\baux\b/.test(c.command({unit: 'x', port: 1}))));
  const logged = readFileSync(join(gate.auditFile), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.op === 'check');
  assert.ok(logged.some(r => r.command === 'disk' && r.server === 'fixture-01'));
});

test('a server can use its own key; a bad key name is refused', async t => {
  const servers = [{name: 'own-01', host: '192.0.2.21', client: 'x', key: 'own-01_ed25519'}, {name: 'evil-01', host: '192.0.2.22', client: 'x', key: '../../root/key'}];
  const {gate, calls} = fixture(t, {servers: () => servers});
  await gate.handle({op: 'check', server: 'own-01', name: 'disk'});
  assert.equal(calls.at(-1)[2].key, '/var/lib/mastan-ops/ssh/own-01_ed25519');
  assert.equal(sshArgs('192.0.2.21', 'x', calls.at(-1)[2].key)[1], '/var/lib/mastan-ops/ssh/own-01_ed25519');
  assert.equal((await gate.handle({op: 'check', server: 'evil-01', name: 'disk'})).ok, false);
});

test('windows: passkey to open, only on the allowed server, run without a tap until they close', async t => {
  const servers = [{name: 'mastan-server', host: '192.0.2.31', client: 'own'}, {name: 'prod-01', host: '192.0.2.32', client: 'canary'}, {name: 'dev-01', host: '192.0.2.33', client: 'own'}];
  const {gate, calls} = fixture(t, {servers: () => servers});
  for (const server of ['prod-01', 'dev-01']) assert.match((await gate.handle({op: 'window', server, reason: 'try'})).error, /not allowed/);
  assert.equal((await gate.handle({op: 'window', server: 'mastan-server', minutes: 16, reason: 'too long'})).ok, false);
  const held = await gate.handle({op: 'run', server: 'mastan-server', command: 'uptime', reason: 'before the window'});
  assert.equal(held.state, 'pending');
  const open = await gate.handle({op: 'window', server: 'mastan-server', minutes: 15, reason: 'mail fix'});
  assert.equal(open.state, 'pending'); assert.equal(open.kind, 'window');
  assert.equal((await gate.handle({op: 'windows'})).windows.length, 0);
  const {challenge} = await gate.handle({op: 'challenge', id: open.id});
  const done = await gate.handle({op: 'approve', id: open.id, assertion: assertion(challenge)});
  assert.equal(done.state, 'done'); assert.equal(calls.length, 0);
  assert.equal((await gate.handle({op: 'windows'})).windows[0].server, 'mastan-server');
  const quick = await gate.handle({op: 'run', server: 'mastan-server', command: 'systemctl restart nginx', reason: 'in the window'});
  assert.equal(quick.ok, true); await Promise.allSettled(gate.jobs);
  assert.equal(calls.at(-1)[1], 'systemctl restart nginx');
  assert.equal((await gate.handle({op: 'result', id: quick.id})).state, 'done');
  const other = await gate.handle({op: 'run', server: 'prod-01', command: 'uptime', reason: 'other server stays closed'});
  assert.equal(other.state, 'pending');
  assert.equal((await gate.handle({op: 'close_window', server: 'mastan-server'})).state, 'closed');
  assert.equal((await gate.handle({op: 'run', server: 'mastan-server', command: 'uptime', reason: 'after closing'})).state, 'pending');
});

test('live shows output while a command runs, redacted', async t => {
  let release;
  const {gate} = fixture(t, {executor: (host, command, {onCapture}) => new Promise(resolve => {
    const capture = new OutputCapture(); onCapture(capture);
    capture.write('step one\npassword=hunter2\n');
    release = () => resolve({exit_code: 0, output: capture.finish()});
  })});
  const row = await gate.handle({op: 'run', server: 'fixture-01', command: 'long job', reason: 'watch it'});
  const {challenge} = await gate.handle({op: 'challenge', id: row.id});
  await gate.handle({op: 'approve', id: row.id, assertion: assertion(challenge)});
  await new Promise(r => setImmediate(r));
  const live = await gate.handle({op: 'live', id: row.id});
  assert.equal(live.state, 'approved'); assert.match(live.output, /step one/); assert.doesNotMatch(live.output, /hunter2/);
  release(); await Promise.allSettled(gate.jobs);
  assert.equal((await gate.handle({op: 'live', id: row.id})).state, 'done');
});

let leaseCounter = 1000;
async function openLease(f) {
  const options = await f.gate.handle({op: 'lease_challenge'});
  const out = await f.gate.handle({op: 'lease_open', challenge: options.challenge, assertion: assertion(options.challenge, {counter: ++leaseCounter})});
  assert.equal(out.ok, true); return out.lease;
}

test('auto-approve: no lease means no run, a passkey-opened lease runs it once and logs it', async t => {
  const f = fixture(t), row = await f.request();
  for (const lease of ['x'.repeat(43), 'bad']) assert.equal((await f.gate.handle({op: 'auto_run', id: row.id, lease})).ok, false);
  assert.equal((await f.gate.handle({op: 'lease_open', challenge: 'invented', assertion: assertion('invented')})).ok, false);
  assert.equal(f.calls.length, 0);
  const lease = await openLease(f);
  const first = await f.gate.handle({op: 'auto_run', id: row.id, lease});
  assert.equal(first.ok, true); assert.equal(first.auto, 1);
  assert.equal((await f.gate.handle({op: 'auto_run', id: row.id, lease})).ok, false);
  await Promise.all(f.gate.jobs);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.gate.handle({op: 'result', id: row.id})).state, 'done');
  const recent = await f.gate.handle({op: 'auto_recent'});
  assert.deepEqual(recent.auto.map(r => r.id), [row.id]);
  const log = readFileSync(join(f.state, 'audit.jsonl'), 'utf8');
  assert.match(log, /"op":"run"[^\n]*systemctl restart mastan-web/); assert.match(log, /"op":"auto_run"/); assert.match(log, /"op":"execute"[^\n]*"exit_code":0/);
  assert.ok(!log.includes(lease)); assert.ok(!JSON.stringify(recent).includes(lease));
});

test('auto-approve: a challenge cannot be reused for a second lease', async t => {
  const f = fixture(t), options = await f.gate.handle({op: 'lease_challenge'}), signed = assertion(options.challenge);
  assert.equal((await f.gate.handle({op: 'lease_open', challenge: options.challenge, assertion: signed})).ok, true);
  assert.equal((await f.gate.handle({op: 'lease_open', challenge: options.challenge, assertion: signed})).ok, false);
});

test('auto-approve: the switch stops runs at once, anyone can turn off, only a lease turns on', async t => {
  const f = fixture(t), lease = await openLease(f), row = await f.request();
  assert.deepEqual((({on, lease: l}) => ({on, l}))(await f.gate.handle({op: 'lease_state', lease})), {on: true, l: true});
  assert.equal((await f.gate.handle({op: 'lease_set', on: false})).on, false);
  assert.equal((await f.gate.handle({op: 'auto_run', id: row.id, lease})).ok, false);
  assert.equal((await f.gate.handle({op: 'lease_set', on: true})).ok, false);
  assert.equal((await f.gate.handle({op: 'lease_set', on: true, lease})).on, true);
  assert.equal((await f.gate.handle({op: 'auto_run', id: row.id, lease})).ok, true);
  await Promise.all(f.gate.jobs);
});

test('auto-approve: an expired or closed lease stops working', async t => {
  const f = fixture(t), lease = await openLease(f), row = await f.request();
  f.advance(31 * 86400_000);
  assert.equal((await f.gate.handle({op: 'lease_state', lease})).lease, false);
  const fresh = await openLease(f), next = await f.request();
  assert.equal((await f.gate.handle({op: 'lease_close', lease: fresh})).ok, true);
  assert.equal((await f.gate.handle({op: 'auto_run', id: next.id, lease: fresh})).ok, false);
  assert.equal(f.calls.length, 0); assert.ok(row);
});

test('auto-approve: dev-01 and very destructive commands keep the card', async t => {
  const servers = () => [{name: 'fixture-01', host: '192.0.2.11'}, {name: 'dev-01', host: '192.0.2.12'}];
  const f = fixture(t, {servers}), lease = await openLease(f);
  const dev = await f.gate.handle({op: 'run', server: 'dev-01', command: 'uptime', reason: 'Invented'});
  assert.equal(dev.hold, 'gate host');
  assert.match((await f.gate.handle({op: 'auto_run', id: dev.id, lease})).error, /kept for approval/);
  const wipe = await f.gate.handle({op: 'run', server: 'fixture-01', command: 'rm -rf /var/lib/mastan-public', reason: 'Invented'});
  assert.match((await f.gate.handle({op: 'auto_run', id: wipe.id, lease})).error, /kept for approval/);
  assert.equal(f.gate.get(wipe.id).state, 'pending'); assert.equal(f.calls.length, 0);
});

test('destructive list: catches the list, leaves normal work alone', () => {
  for (const c of ['rm -rf /', 'rm -fr /var/lib/mastan-public', 'cd /tmp; rm --recursive /opt/mastan', 'rm /var/lib/mastan-public/me.sqlite', 'rm -rf "$DIR"',
    'mkfs.ext4 /dev/sda1', 'wipefs -a /dev/sda', 'dd if=/dev/zero of=/dev/sda', 'shred -u x', 'psql -c "DROP DATABASE app"', 'sqlite3 a.db "drop table users"', 'dropdb app',
    'hcloud server delete client-a-01', 'docker volume rm data', 'docker system prune -af', 'find / -name x -delete', 'redis-cli FLUSHALL',
    `echo ${Buffer.from('rm -rf /var/lib/mastan-public').toString('base64')} | base64 -d | sh`]) assert.ok(destructive(c), c);
  for (const c of ['uptime', 'systemctl restart nginx', 'grep -rl --exclude-dir=auth -e 998 /var/lib/mastan-public', 'rm /tmp/invented.txt', 'rm -rf /tmp/build/out/x',
    'rm -rf /var/lib/mastan-public/cache/old/x', 'df -h', 'fdisk -l', 'drop_caches=1 true', `echo ${Buffer.from('import sqlite3').toString('base64')}xxxx | base64 -d`]) assert.equal(destructive(c), null, c);
});

