import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanary, fetchCanary} from '../src/clients/canary.js';

const NOW = Date.parse('2026-11-05T12:00:00Z'), HOUR = 3600_000;
const data = mkdtempSync(join(tmpdir(), 'clients-canary-')), key = join(data, 'key');
writeFileSync(key, 'invented-private-key');
test.after(() => rmSync(data, {recursive: true, force: true}));
const feed = (extra = {}) => JSON.stringify({version: 1, generated_at: NOW, private_requests: [], billing: [], costs: [], ...extra});

test('Canary caches for 60 seconds, shares in-flight calls and throttles Refresh for 10 seconds', async () => {
  let at = NOW, calls = 0, finish;
  const canary = createCanary({clientsCanaryKeyFile: key}, {now: () => at,
    canaryFetch: async () => { calls++; return new Promise(resolve => { finish = resolve; }); }});
  const first = canary(false), second = canary(true);
  // Wait for the local key check, without starting a process or a server.
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); finish(feed());
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(a.state, 'ready'); assert.equal(a.warning, null);
  at += 9_999; await canary(true); assert.equal(calls, 1);
  at++; finish = null;
  const refreshed = canary(true);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(feed()); await refreshed; assert.equal(calls, 2);
  at += 59_999; await canary(false); assert.equal(calls, 2);
  at++; finish = null;
  const expired = canary(false);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(feed()); await expired; assert.equal(calls, 3);
});

test('missing key is unavailable without SSH or error logs, and can recover', async () => {
  let at = NOW, calls = 0;
  const logged = [], old = console.error, absent = join(data, 'initially-absent');
  const canary = createCanary({clientsCanaryKeyFile: absent}, {now: () => at, canaryFetch: async () => { calls++; return feed(); }});
  console.error = line => logged.push(line);
  try {
    assert.equal((await canary(false)).state, 'unavailable');
    assert.equal((await canary(true)).state, 'unavailable');
    assert.equal(calls, 0); assert.deepEqual(logged, []);
    writeFileSync(absent, 'invented-key'); at += 10_000;
    assert.equal((await canary(true)).state, 'ready'); assert.equal(calls, 1);
    rmSync(absent); at += 10_000;
    assert.equal((await canary(true)).state, 'unavailable');
    assert.equal((await canary(false)).state, 'unavailable');
    assert.equal(calls, 1); assert.deepEqual(logged, []);
  } finally { console.error = old; }
});

test('failure keeps the last good data, warns in Riyadh time, ages past 48 hours, and recovers', async () => {
  let at = NOW, broken = false, calls = 0;
  const logged = [], old = console.error;
  const original = feed({private_requests: [{user_id: 'private-fixture', business: 'never-log-business'}]});
  const canary = createCanary({clientsCanaryKeyFile: key}, {now: () => at, canaryFetch: async () => {
    calls++;
    if (broken) throw Object.assign(new Error('never-log-message'), {code: 255, stdout: original, stderr: 'never-log-stderr'});
    return original;
  }});
  console.error = line => logged.push(line);
  try {
    const first = await canary(false); broken = true; at += 60_000;
    const failed = await canary(false);
    assert.equal(failed.state, 'ready'); assert.deepEqual(failed.private_requests, first.private_requests);
    assert.equal(failed.warning, 'Canary unavailable, showing data from 15:00');
    await canary(true); assert.equal(calls, 2);
    at = NOW + 48 * HOUR;
    assert.equal((await canary(false)).state, 'ready');
    at++; assert.equal(canary.cached().state, 'stale');
    assert.equal((await canary(false)).state, 'stale');
    assert.deepEqual(logged, ['[clients] canary 255', '[clients] canary 255']);
    assert.doesNotMatch(logged.join(' '), /never-log|private-fixture/);
    broken = false; at += 10_000;
    assert.equal((await canary(true)).warning, null);
  } finally { console.error = old; }
});

test('transport errors and bad JSON without last good data are unavailable and safely logged', async () => {
  const logged = [], old = console.error;
  console.error = line => logged.push(line);
  try {
    for (const canaryFetch of [async () => { throw Object.assign(new Error('secret-fixture'), {name: 'secret-fixture', code: 'secret-fixture', stdout: 'secret-fixture', stderr: 'secret-fixture'}); },
      async () => '{secret-fixture', async () => feed({costs: [{user_id: 'secret-fixture', day: 'invalid', micros: -1}]})]) {
      const canary = createCanary({clientsCanaryKeyFile: key}, {canaryFetch, now: () => NOW});
      assert.deepEqual(await canary(false), {state: 'unavailable', generated_at: null, private_requests: [], billing: [], costs: [], warning: null});
      assert.equal(canary.cached(), null);
    }
    assert.deepEqual(logged, ['[clients] canary Error', '[clients] canary SyntaxError', '[clients] canary SyntaxError']);
    assert.doesNotMatch(logged.join(' '), /secret-fixture/);
  } finally { console.error = old; }
});

test('default transport uses the exact SSH argv with no shell and a limited environment', async () => {
  for (const config of [{}, {clientsCanaryKeyFile: '/tmp/invented key', clientsCanaryKnownHosts: '/tmp/invented hosts', clientsCanaryHost: 'canary.example.invalid'}]) {
    let calls = 0;
    const result = await fetchCanary(config, (file, args, options, callback) => {
      calls++; assert.equal(file, '/usr/bin/ssh');
      assert.deepEqual(args, ['-F', 'none', '-i', config.clientsCanaryKeyFile || '/etc/mastan-me/clients-canary-key',
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=' + (config.clientsCanaryKnownHosts || '/etc/mastan-me/clients-canary-known-hosts'),
        '-o', 'GlobalKnownHostsFile=/dev/null', 'root@' + (config.clientsCanaryHost || '203.0.113.10'), 'clients-export']);
      assert.deepEqual(options, {shell: false, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}});
      callback(null, feed(), 'never-return-stderr');
    });
    assert.equal(result, feed()); assert.equal(calls, 1);
  }
  const error = Object.assign(new Error('invented'), {code: 255});
  await assert.rejects(fetchCanary({}, (file, args, options, callback) => callback(error, 'private-stdout', 'private-stderr')), error);
});
