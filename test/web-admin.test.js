// mastan-me-admin auth commands: import-passkeys (idempotent), enrol, test-login, passkeys, revoke, sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = existsSync('/private/tmp/claude-501') ? '/private/tmp/claude-501' : tmpdir();
const DATA = mkdtempSync(join(base, 'mastan-me-web-admin-'));
process.env.MASTAN_ME_DATA = DATA;
process.env.MASTAN_ME_HOSTNAME = 'me.example.com';
const {commands} = await import('../src/admin/auth.js');
const {openDb} = await import('../src/db.js');
const A = await import('../src/web/auth.js');
const db = openDb();
test.after(() => rmSync(DATA, {recursive: true, force: true}));

async function run(name, ...args) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { await commands[name].run(args); } finally { console.log = orig; }
  return out.join('\n');
}

test('import-passkeys copies board rows once, origin board', async () => {
  const file = join(DATA, 'rows.json');
  writeFileSync(file, JSON.stringify([
    {id: 'Ym9hcmQtcGFzc2tleS1yb3ctb25l', public_key_b64: Buffer.alloc(77, 1).toString('base64'), counter: 0, transports: '["hybrid","internal"]', created: 1760000000000},
    {id: 'Ym9hcmQtcGFzc2tleS1yb3ctdHdv', public_key_b64: Buffer.alloc(77, 2).toString('base64'), counter: 2, transports: ['internal'], created: '2026-10-01T10:00:00Z'},
  ]));
  assert.match(await run('import-passkeys', file), /2 new, 0 counter updated, 0 already present/);
  assert.match(await run('import-passkeys', file), /0 new, 0 counter updated, 2 already present/);
  const rows = db.prepare("SELECT id, origin, counter, transports, created, length(public_key) n FROM credentials ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.origin === 'board' && r.n === 77));
  assert.equal(rows.find(r => r.id === 'Ym9hcmQtcGFzc2tleS1yb3ctdHdv').created, Date.parse('2026-10-01T10:00:00Z'));
  assert.deepEqual(JSON.parse(rows.find(r => r.id === 'Ym9hcmQtcGFzc2tleS1yb3ctb25l').transports), ['hybrid', 'internal']);
  // a higher counter from the board is taken over, never a lower one
  writeFileSync(file, JSON.stringify([{id: 'Ym9hcmQtcGFzc2tleS1yb3ctdHdv', public_key_b64: Buffer.alloc(77, 2).toString('base64'), counter: 5, transports: [], created: 1}]));
  assert.match(await run('import-passkeys', file), /0 new, 1 counter updated/);
  writeFileSync(file, JSON.stringify([{id: 'bad id!', public_key_b64: 'AAAA', counter: 0}]));
  await assert.rejects(() => run('import-passkeys', file), /base64url/);
  writeFileSync(file, '{not json');
  await assert.rejects(() => run('import-passkeys', file), /JSON array/);
  await assert.rejects(() => run('import-passkeys'), /Usage/);
});

test('passkeys lists handle, origin, created', async () => {
  const out = await run('passkeys');
  assert.equal(out.split('\n').length, 2);
  assert.match(out, /board\s+2025-10-09T/);
});

test('enrol prints a one-time link and stores only its hash', async () => {
  const out = await run('enrol');
  const value = out.match(/^https:\/\/me\.example\.com\/login#enrol=([A-Za-z0-9_-]{43})$/m)[1];
  assert.match(out, /Expires in 10 minutes/);
  const row = db.prepare('SELECT hash, expires FROM enrollments').get();
  assert.equal(row.hash, A.hash(value));
  assert.ok(row.expires - Date.now() <= 600_000 && row.expires - Date.now() > 590_000);
  assert.equal(db.prepare('SELECT count(*) n FROM enrollments WHERE hash=?').get(value).n, 0);
  await run('enrol');
  assert.equal(db.prepare('SELECT count(*) n FROM enrollments').get().n, 1); // only one pending link
});

test('test-login prints an operator link, hash stored, single use', async () => {
  const out = await run('test-login');
  const value = out.match(/^https:\/\/me\.example\.com\/login#operator=([A-Za-z0-9_-]{43})$/m)[1];
  assert.match(out, /30 minutes/);
  assert.equal(db.prepare('SELECT count(*) n FROM operator_links WHERE hash=?').get(A.hash(value)).n, 1);
  assert.equal(A.consumeOperatorLink(db, value), true);
  assert.equal(A.consumeOperatorLink(db, value), false);
});

test('sessions list and revoke-all; revoke a passkey ends its sessions', async () => {
  const id = 'Ym9hcmQtcGFzc2tleS1yb3ctb25l';
  A.createSession(db, id);
  A.createSession(db, A.OPERATOR, {ttl: A.OPERATOR_SESSION_TTL});
  const list = await run('sessions');
  assert.match(list, /passkey/);
  assert.match(list, /operator/);
  const handle = db.prepare('SELECT handle FROM credentials WHERE id=?').get(id).handle;
  assert.match(await run('revoke', handle), /revoked/);
  assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE credential_id=?').get(id).n, 0);
  await assert.rejects(() => run('revoke', 'nope-nope'), /Unknown/);
  assert.match(await run('sessions', '--revoke-all'), /Sessions revoked: 1/);
  assert.match(await run('sessions'), /No active sessions/);
  await assert.rejects(() => run('sessions', '--all'), /Usage/);
});

test('CLI entry lists the auth commands', () => {
  const r = spawnSync(process.execPath, [join(HERE, '..', 'src', 'admin', 'cli.js')], {env: {...process.env, MASTAN_ME_DATA: DATA}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  for (const c of ['enrol', 'passkeys', 'revoke', 'sessions', 'test-login', 'import-passkeys']) assert.match(r.stdout, new RegExp(`\\b${c}\\b`));
});
