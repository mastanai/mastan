// Web auth store: passkey credentials, sessions, one-time links and rate limits.
// Same shape as the Topic Board (store.mjs) so board passkey rows copy across.
// Only hashes of secrets are stored. Nothing here logs.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_TTL = 30 * 86400_000;
export const OPERATOR_SESSION_TTL = 30 * 60_000;
export const ENROL_TTL = 600_000;
export const OPERATOR_LINK_TTL = 600_000;
export const CHALLENGE_TTL = 300_000;
export const LIMIT_WINDOW = 300_000;
export const LIMIT_MAX = 30;
export const OPERATOR = 'operator';

export const fail = (status, message) => Object.assign(new Error(message || 'Request failed'), {status});

// Tables owned by src/db.js already exist; operator links are web-only.
export function ensureAuthTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_links(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, created INTEGER NOT NULL);`);
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// --- one-time links
export function enrol(db, now = Date.now()) {
  const value = token();
  transaction(db, () => {
    db.prepare('DELETE FROM enrollments').run();
    db.prepare("DELETE FROM challenges WHERE kind='register'").run();
    db.prepare('INSERT INTO enrollments VALUES(?,?)').run(hash(value), now + ENROL_TTL);
  });
  return value;
}
export function consumeEnrollment(db, digest, now = Date.now()) {
  return db.prepare('DELETE FROM enrollments WHERE hash=? AND expires>?').run(digest, now).changes === 1;
}

export function operatorLink(db, now = Date.now()) {
  ensureAuthTables(db);
  const value = token();
  db.prepare('INSERT INTO operator_links VALUES(?,?,?)').run(hash(value), now + OPERATOR_LINK_TTL, now);
  return value;
}
export function consumeOperatorLink(db, value, now = Date.now()) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) return false;
  return db.prepare('DELETE FROM operator_links WHERE hash=? AND expires>?').run(hash(value), now).changes === 1;
}

// --- sessions
export function createSession(db, credentialId, {now = Date.now(), ttl = SESSION_TTL} = {}) {
  const value = token(), handle = token().slice(0, 12), csrf = token();
  db.prepare('INSERT INTO sessions(handle,hash,credential_id,expires,csrf) VALUES(?,?,?,?,?)')
    .run(handle, hash(value), credentialId, now + ttl, csrf);
  return {value, handle, csrf, expires: now + ttl};
}

export function findSession(db, value, now = Date.now()) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) return null;
  const row = db.prepare(`SELECT s.handle, s.hash, s.credential_id, s.expires, s.csrf FROM sessions s
    WHERE s.hash=? AND s.expires>? AND (s.credential_id=? OR EXISTS(SELECT 1 FROM credentials c WHERE c.id=s.credential_id))`)
    .get(hash(value), now, OPERATOR);
  if (!row) return null;
  return {...row, operator: row.credential_id === OPERATOR};
}

export function deleteSession(db, digest) {
  return db.prepare('DELETE FROM sessions WHERE hash=?').run(digest).changes;
}
export function revokeAllSessions(db) {
  return db.prepare('DELETE FROM sessions').run().changes;
}
export function listSessions(db, now = Date.now()) {
  return db.prepare('SELECT handle, credential_id, expires FROM sessions WHERE expires>? ORDER BY expires').all(now)
    .map(s => ({handle: s.handle, kind: s.credential_id === OPERATOR ? 'operator' : 'passkey', expires: new Date(s.expires).toISOString()}));
}

// --- credentials
export function listPasskeys(db) {
  return db.prepare('SELECT handle, origin, created, transports FROM credentials ORDER BY created').all()
    .map(c => ({handle: c.handle, origin: c.origin, created: new Date(c.created).toISOString(), transports: safeJson(c.transports, [])}));
}

export function revokeCredential(db, handle) {
  return transaction(db, () => {
    const row = db.prepare('SELECT id FROM credentials WHERE handle=?').get(handle);
    if (!row) return false;
    db.prepare('DELETE FROM sessions WHERE credential_id=?').run(row.id);
    db.prepare('DELETE FROM credentials WHERE handle=?').run(handle);
    return true;
  });
}

export function addCredential(db, {id, publicKey, counter = 0, transports = [], origin = 'local', now = Date.now()}) {
  const handle = token().slice(0, 12);
  db.prepare('INSERT INTO credentials(handle,id,public_key,counter,transports,created,origin) VALUES(?,?,?,?,?,?,?)')
    .run(handle, id, Buffer.from(publicKey), counter, JSON.stringify(transports || []), now, origin);
  return handle;
}

const CRED_ID_RE = /^[A-Za-z0-9_-]{16,1400}$/;
const HANDLE_RE = /^[A-Za-z0-9_-]{6,32}$/;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

// Rows exported from the Topic Board: [{id, public_key_b64, counter, transports, created, handle?}].
// Idempotent: an existing id keeps its row; only a higher counter is taken over.
export function importPasskeys(db, rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array of credential rows');
  const clean = rows.map((r, i) => {
    const where = `row ${i + 1}`;
    if (!r || typeof r !== 'object') throw new Error(`${where}: not an object`);
    if (typeof r.id !== 'string' || !CRED_ID_RE.test(r.id)) throw new Error(`${where}: id must be base64url`);
    if (typeof r.public_key_b64 !== 'string' || !/^[A-Za-z0-9+/_=-]+$/.test(r.public_key_b64)) throw new Error(`${where}: public_key_b64 missing`);
    const publicKey = Buffer.from(r.public_key_b64, 'base64');
    if (publicKey.length < 16) throw new Error(`${where}: public key too short`);
    const counter = Number(r.counter ?? 0);
    if (!Number.isSafeInteger(counter) || counter < 0) throw new Error(`${where}: bad counter`);
    let transports = typeof r.transports === 'string' ? safeJson(r.transports, null) : r.transports;
    if (transports == null) transports = [];
    if (!Array.isArray(transports) || transports.some(t => !TRANSPORTS.has(t))) throw new Error(`${where}: bad transports`);
    let created = typeof r.created === 'string' && !/^\d+$/.test(r.created) ? Date.parse(r.created) : Number(r.created ?? now);
    if (!Number.isFinite(created) || created <= 0) created = now;
    if (created < 1e12) created *= 1000; // seconds to ms
    const handle = typeof r.handle === 'string' && HANDLE_RE.test(r.handle) ? r.handle : null;
    return {id: r.id, publicKey, counter, transports, created, handle};
  });
  const result = {inserted: 0, updated: 0, unchanged: 0};
  transaction(db, () => {
    for (const c of clean) {
      const existing = db.prepare('SELECT counter FROM credentials WHERE id=?').get(c.id);
      if (existing) {
        if (c.counter > existing.counter) { db.prepare('UPDATE credentials SET counter=? WHERE id=?').run(c.counter, c.id); result.updated++; }
        else result.unchanged++;
        continue;
      }
      let handle = c.handle;
      if (!handle || db.prepare('SELECT 1 FROM credentials WHERE handle=?').get(handle)) handle = token().slice(0, 12);
      db.prepare('INSERT INTO credentials(handle,id,public_key,counter,transports,created,origin) VALUES(?,?,?,?,?,?,?)')
        .run(handle, c.id, c.publicKey, c.counter, JSON.stringify(c.transports), c.created, 'board');
      result.inserted++;
    }
  });
  return result;
}

// --- ceremonies
export function saveChallenge(db, kind, challenge, enrollment = null, expires = Date.now() + CHALLENGE_TTL) {
  const secret = token();
  db.prepare('INSERT INTO challenges VALUES(?,?,?,?,?)').run(hash(secret), kind, challenge, enrollment, expires);
  return secret;
}
export function takeChallenge(db, secret, kind, now = Date.now()) {
  if (typeof secret !== 'string' || !TOKEN_RE.test(secret)) return null;
  return db.prepare('DELETE FROM challenges WHERE hash=? AND kind=? AND expires>? RETURNING *').get(hash(secret), kind, now) || null;
}

// --- rate limit: fixed 5 minute window per key, persisted
export function rateLimit(db, key, now = Date.now()) {
  db.prepare('DELETE FROM limits WHERE start<?').run(now - LIMIT_WINDOW);
  const k = hash('auth:' + key);
  const row = db.prepare('SELECT count FROM limits WHERE key=?').get(k);
  if (row && row.count >= LIMIT_MAX) throw fail(429);
  db.prepare('INSERT INTO limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(k, now);
}

export function prune(db, now = Date.now()) {
  ensureAuthTables(db);
  for (const table of ['enrollments', 'sessions', 'challenges', 'operator_links']) db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(now);
  db.prepare('DELETE FROM limits WHERE start<?').run(now - LIMIT_WINDOW);
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}
