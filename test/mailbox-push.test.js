// IMAP IDLE trigger and the canary notice channel. Fake clients and a fake ssh only; never opens a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MailboxIdle} from '../src/jobs/mailbox-idle.js';
import {sendOwnerNotice, sshArgs} from '../src/channels/canary-notice.js';
import {MailStore} from '../src/mail/store.js';

const dir = mkdtempSync(join(tmpdir(), 'mailbox-push-test-'));
test.after(() => rmSync(dir, {recursive: true, force: true}));
const wait = ms => new Promise(r => setTimeout(r, ms));
const quiet = async fn => { const warn = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = warn; } };

class FakeClient extends EventEmitter {
  constructor(options, {failConnect = false} = {}) { super(); this.options = options; this.failConnect = failConnect; this.opened = null; this.closed = 0; }
  async connect() { if (this.failConnect) throw Error('private connection detail'); }
  async mailboxOpen(path) { this.opened = path; }
  close() { this.closed++; this.emit('close'); }
}
function idleSetup({accounts = [{id: 'hello', alerts: true}, {id: 'archive', alerts: false}, {id: 'old', alerts: true, hidden: true}], failures = 0, ...options} = {}) {
  const clients = [];
  let remainingFailures = failures;
  const store = {definitions: accounts, stopped: false,
    watchClient(id) { if (this.stopped) return null; const c = new FakeClient({id}, {failConnect: remainingFailures-- > 0}); clients.push(c); return c; },
    async role() { return 'INBOX'; }};
  let runs = 0, release = null;
  const idle = new MailboxIdle({store, debounce: 20, minDelay: 10, maxDelay: 40, onMail: async () => { runs++; if (release) await new Promise(r => { release = r; }); }, ...options});
  return {idle, store, clients, runs: () => runs, hold() { release = true; }, free() { const r = release; release = null; r?.(); }};
}

test('IDLE watches only alerting accounts, opens INBOX and runs once per burst of new mail', async () => {
  const f = idleSetup();
  f.idle.start(); await wait(5);
  assert.equal(f.clients.length, 1); assert.deepEqual(f.clients[0].options, {id: 'hello'}); assert.equal(f.clients[0].opened, 'INBOX');
  assert.equal(f.runs(), 0, 'the first connection does not trigger a run; start() ticks already');
  for (let i = 0; i < 5; i++) f.clients[0].emit('exists', {count: 10 + i});
  await wait(60); assert.equal(f.runs(), 1);
  f.clients[0].emit('exists', {count: 20}); await wait(60); assert.equal(f.runs(), 2);
  f.idle.shutdown();
});

test('IDLE never overlaps runs: mail during a run gets exactly one more run', async () => {
  const f = idleSetup();
  f.idle.start(); await wait(5); f.hold();
  f.clients[0].emit('exists', {}); await wait(40); assert.equal(f.runs(), 1);
  f.clients[0].emit('exists', {}); f.clients[0].emit('exists', {}); await wait(40); assert.equal(f.runs(), 1);
  f.free(); await wait(60); assert.equal(f.runs(), 2);
  f.idle.shutdown();
});

test('IDLE reconnects with backoff after close or a failed connect, then catches up once', async () => {
  const f = idleSetup({failures: 2, debounce: 60});
  await quiet(async () => { f.idle.start(); await wait(150); });
  // Two failed connects (10 ms, then 20 ms backoff), then a working one that catches up once.
  assert.equal(f.clients.length, 3); assert.ok(f.clients.slice(0, 2).every(c => c.closed >= 1)); assert.equal(f.clients[2].opened, 'INBOX'); assert.equal(f.runs(), 1);
  f.clients[2].emit('close'); await wait(70);
  assert.equal(f.clients.length, 4); assert.equal(f.clients[3].opened, 'INBOX'); assert.equal(f.runs(), 1);
  await wait(80); assert.equal(f.runs(), 2, 'mail that arrived while away is picked up after the reconnect');
  // Events from the old client are ignored.
  f.clients[2].emit('exists', {}); await wait(90); assert.equal(f.runs(), 2);
  f.clients[3].emit('exists', {}); await wait(90); assert.equal(f.runs(), 3);
  f.idle.shutdown();
});

test('IDLE shutdown closes clients, cancels pending retries and debounced runs', async () => {
  const f = idleSetup({accounts: [{id: 'hello', alerts: true}, {id: 'second', alerts: true}]});
  f.idle.start(); await wait(5);
  f.clients[0].emit('exists', {});
  f.clients[1].emit('close'); // schedules a retry
  f.idle.shutdown();
  await wait(80);
  assert.equal(f.runs(), 0); assert.equal(f.clients.length, 2); assert.ok(f.clients.every(c => c.closed >= 1));
});

test('without certificates nothing starts and nothing throws; the store factory reuses connection options', async () => {
  const accounts = [{id: 'hello', label: 'Mastan', host: 'mail.example.invalid', imapPort: 993, smtpPort: 465, certFile: '/nonexistent/a.crt', keyFile: '/nonexistent/a.key', addresses: [{address: 'hello@example.com'}], alerts: true}];
  let built = 0;
  const missing = new MailStore({config: {}, accounts, clientFactory: () => { built++; return new FakeClient(); }});
  assert.equal(missing.watchClient('hello'), null);
  const idle = new MailboxIdle({store: missing, onMail: async () => {}});
  idle.start(); assert.equal(idle.watchers.size, 0); idle.shutdown(); assert.equal(built, 0);
  const tls = {cert: Buffer.from('c'), key: Buffer.from('k')};
  const present = new MailStore({config: {}, accounts, readCredentials: () => tls, clientFactory: o => new FakeClient(o)});
  const client = present.watchClient('hello');
  assert.deepEqual(client.options, present.clientOptions(accounts[0], tls));
  assert.equal(client.options.tls.rejectUnauthorized, true); assert.equal(client.options.auth, undefined);
  await present.shutdown(); assert.equal(present.watchClient('hello'), null);
});

function fakeSpawn({status = 0, stdout = 'ok\n', stderr = '', hang = false} = {}) {
  const calls = [];
  const spawnFn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = ''; child.stdin.on('data', c => { input += c; });
    child.kill = signal => { calls.at(-1).killed = signal; };
    calls.push({cmd, args, options, get input() { return input; }});
    child.stdin.on('finish', () => {
      if (hang) return;
      setImmediate(() => { child.stdout.end(stdout); child.stderr.end(stderr); child.emit('close', status); });
    });
    return child;
  };
  return {spawnFn, calls};
}
const notice = {id: 'mail:hello:1:11', text: '📧 New email\nhello@mastan.ai', fallback: '📧 New email\nhello@mastan.ai'};

test('canary notice: missing key rejects with NO_KEY before any ssh', async () => {
  const f = fakeSpawn();
  await assert.rejects(sendOwnerNotice(notice, {config: {ownerNoticeKey: join(dir, 'absent-key')}, spawnFn: f.spawnFn}), e => e.code === 'NO_KEY');
  assert.equal(f.calls.length, 0);
});

test('canary notice: pinned ssh with its own key, JSON on stdin only, ok and duplicate accepted', async () => {
  const key = join(dir, 'owner-notice-key'); writeFileSync(key, 'invented');
  const config = {ownerNoticeKey: key, ownerNoticeKnownHosts: '/etc/known', ownerNoticeHost: '192.0.2.10'};
  const f = fakeSpawn();
  assert.equal(await sendOwnerNotice(notice, {config, spawnFn: f.spawnFn}), 'ok');
  const call = f.calls[0];
  assert.equal(call.cmd, '/usr/bin/ssh'); assert.deepEqual(call.args, sshArgs(config));
  assert.deepEqual(call.args.slice(0, 3), ['-F', 'none', '-i']); assert.equal(call.args[3], key);
  for (const opt of ['IdentitiesOnly=yes', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=/etc/known', 'GlobalKnownHostsFile=/dev/null']) assert.ok(call.args.includes(opt), opt);
  assert.equal(call.args.at(-2), 'root@192.0.2.10'); assert.ok(!call.args.join(' ').includes('New email'));
  assert.equal(call.options.shell, false); assert.deepEqual(call.options.env, {PATH: '/usr/bin:/bin'});
  assert.deepEqual(JSON.parse(call.input), notice);
  assert.equal(await sendOwnerNotice(notice, {config, spawnFn: fakeSpawn({stdout: 'duplicate\n'}).spawnFn}), 'duplicate');
});

test('canary notice: refusals, ssh failures and timeouts reject with a code only', async () => {
  const key = join(dir, 'owner-notice-key-2'); writeFileSync(key, 'invented');
  const config = {ownerNoticeKey: key};
  await assert.rejects(sendOwnerNotice(notice, {config, spawnFn: fakeSpawn({status: 3, stdout: '', stderr: 'rate\n'}).spawnFn}), e => e.code === 'RATE' && !/New email/.test(e.message));
  await assert.rejects(sendOwnerNotice(notice, {config, spawnFn: fakeSpawn({status: 255, stdout: '', stderr: 'Host key verification failed for private detail.\n'}).spawnFn}), e => e.code === 'EXIT_255' && !/private/.test(e.message));
  const hung = fakeSpawn({hang: true});
  await assert.rejects(sendOwnerNotice(notice, {config, spawnFn: hung.spawnFn, timeout: 20}), e => e.code === 'TIMEOUT');
  assert.equal(hung.calls[0].killed, 'SIGKILL');
  await assert.rejects(sendOwnerNotice(notice, {config, spawnFn: () => { throw Error('ENOENT private'); }}), e => e.code === 'SPAWN');
});
