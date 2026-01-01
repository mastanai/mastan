// What clients want and their agents cannot do. Each Private server files short product needs here with its own token; this
// file stores them, groups the same need across servers, and tells Owner in one digest. The text comes from a client's agent, so
// it is untrusted data: it is shown as plain text, and only
// the triage agent of request-prs.js reads it, with no tools. Stage 1 of docs/CAPABILITY-REQUESTS.md.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {sendToOwner} from '../channels/telegram-api.js';

const MINUTE = 60_000, DAY = 1440 * MINUTE;
export const KINDS = ['capability', 'connection', 'bug', 'question'];
export const STATUSES = ['seen', 'planned', 'done', 'declined'];
export const MAX_TITLE = 120, MAX_NEED = 600, SYNC_BATCH = 10, PER_DAY = 20, DIGEST_LINES = 10;
export const HOLD = 10 * MINUTE, DIGEST_GAP = 30 * MINUTE;
const ID = /^[A-Za-z0-9_-]{8,64}$/, LAST_DIGEST = 'capability-requests:last-digest', TELL_CLOSED_FOR = 7 * DAY;
const hash = token => createHash('sha256').update(token).digest();
const clean = value => String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
// Same hours as the servers' notices: nothing before 8 in the morning, Riyadh time.
export const quietHours = at => new Date(at + 180 * MINUTE).getUTCHours() < 8;

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'my', 'our', 'their', 'his', 'her', 'please', 'with', 'and', 'on', 'in']);
// The same words in any order and any punctuation are one request. Servers dedupe with the same rule.
export const groupKey = title => [...new Set(clean(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(word => word && !STOP_WORDS.has(word)))].sort().join(' ');

// The server checks first. This is for a server that is old, broken or no longer ours: a key must not land in a digest either.
const REFUSED = [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/, /\bsk-[A-Za-z0-9_-]{16,}/, /\b[rsp]k_(?:test|live)_[A-Za-z0-9]{8,}/, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[A-Za-z0-9_-]{30,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/, /\b[0-9a-f]{32,}\b/i, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:password|passwd|pwd|secret|token|sig|api[ _-]?key|access[ _-]?key|account[ _-]?key|client[ _-]?secret|connection[ _-]?string)\s*[:=]\s*\S+/i,
  /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u, /(?<![\w+])\+?\d(?:[ .()-]*\d){9,14}(?!\d)/, /\b[a-z][a-z0-9+.-]*:\/\/\S+/i];
const longRandomText = text => (text.match(/[A-Za-z0-9_\-+/=]{32,}/g) || []).some(part => /[a-z]/.test(part) && /[A-Z]/.test(part) && /\d/.test(part));
export const refusedText = text => REFUSED.some(pattern => pattern.test(text)) || longRandomText(text);

// Plain words for a Telegram digest. sendText turns Markdown into HTML and then escapes the rest, so a client's text must not carry
// Markdown, links, /commands, @mentions or a line break that could pass for another entry.
export const digestText = (value, max = MAX_TITLE) => Array.from(clean(value).replace(/[`*_~#[\]()|\\]/g, ' ').replace(/[/@]/g, ' ')
  .replace(/([\p{L}\p{N}-])\.(?=\p{L}{2})/gu, '$1 ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');

export function requestsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS capability_request_servers(server TEXT PRIMARY KEY, token_hash BLOB UNIQUE NOT NULL, client TEXT,
      created_at INTEGER NOT NULL, last_seen INTEGER);
    CREATE TABLE IF NOT EXISTS capability_request_groups(key TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','seen','planned','done','declined')), status_at INTEGER,
      first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS capability_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, remote_id TEXT NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, need TEXT NOT NULL, key TEXT NOT NULL REFERENCES capability_request_groups(key),
      again_after TEXT, requested_at INTEGER NOT NULL, received_at INTEGER NOT NULL, notified_at INTEGER, UNIQUE(server, remote_id));
    CREATE INDEX IF NOT EXISTS capability_requests_waiting ON capability_requests(notified_at, received_at);
    CREATE INDEX IF NOT EXISTS capability_requests_key ON capability_requests(key);`);
}

export function createCapabilityRequests(ctx, {now = Date.now, notify = text => sendToOwner(text), log = message => console.log('[capability-requests]', message)} = {}) {
  const db = ctx.db, origin = () => ctx.config?.origin || 'https://me.example.com';
  requestsSchema(db);
  const refuse = message => Object.assign(new Error(message), {status: 400, expose: true});

  // Run on the hub by bin/capability-requests-connect. The token is shown once and only its hash stays here. A repeat replaces it.
  function connect(server, client = '') {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(server || '')) throw refuse('Use a server name such as client-d-01.');
    const token = randomBytes(32).toString('base64url'), name = clean(client).slice(0, 80) || null;
    db.prepare(`INSERT INTO capability_request_servers(server,token_hash,client,created_at) VALUES(?,?,?,?)
      ON CONFLICT(server) DO UPDATE SET token_hash=excluded.token_hash,client=coalesce(excluded.client,client)`).run(server, hash(token), name, now());
    return token;
  }

  // The name on the Clients page when there is one, so a rename there shows here too.
  const clientOf = (server, fallback) => {
    const named = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='clients'").get()
      ? db.prepare("SELECT name FROM clients WHERE server=? AND coalesce(name,'')<>'' LIMIT 1").get(server)?.name : null;
    return clean(named || fallback || '') || 'unknown client';
  };

  function record(row, server, at) {
    const key = groupKey(row.title), group = db.prepare('SELECT * FROM capability_request_groups WHERE key=?').get(key);
    // Someone wants a finished or declined need again. Owner decides again, and the digest says what it was.
    const again = ['done', 'declined'].includes(group?.status) ? group.status : null;
    if (!group) db.prepare('INSERT INTO capability_request_groups(key,kind,title,first_at,last_at) VALUES(?,?,?,?,?)').run(key, row.kind, row.title, at, at);
    else db.prepare(`UPDATE capability_request_groups SET last_at=?${again ? ",status='new',status_at=?" : ''} WHERE key=?`).run(...(again ? [at, at, key] : [at, key]));
    db.prepare(`INSERT INTO capability_requests(server,remote_id,kind,title,need,key,again_after,requested_at,received_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(server, row.id, row.kind, row.title, row.need, key, again, row.requested_at, at);
  }

  // A valid row, with its text as it will be stored, or null if it can never be accepted.
  function read(item) {
    const title = clean(item?.title), need = clean(item?.need);
    if (!KINDS.includes(item?.kind) || typeof item.title !== 'string' || typeof item.need !== 'string' || !groupKey(title) || !need) return null;
    if (Array.from(title).length > MAX_TITLE || Array.from(need).length > MAX_NEED || refusedText(title) || refusedText(need)) return null;
    return {id: item.id, kind: item.kind, title, need, requested_at: Number.isSafeInteger(item.created_at) ? item.created_at : null};
  }

  // Servers: POST /api/capability-requests/sync with their token. Sending again is safe. A request named in neither list stays on the
  // server and comes back later, so nothing is lost at the daily cap.
  function sync(authorization, input) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,64})$/.exec(authorization || '');
    if (!match) return null;
    const digest = hash(match[1]);
    const server = db.prepare('SELECT * FROM capability_request_servers WHERE token_hash=?').get(digest);
    if (!server || !timingSafeEqual(server.token_hash, digest)) return null;
    const at = now(), accepted = [], rejected = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE capability_request_servers SET last_seen=? WHERE server=?').run(at, server.server);
      let today = db.prepare('SELECT count(*) n FROM capability_requests WHERE server=? AND received_at>?').get(server.server, at - DAY).n;
      for (const item of Array.isArray(input?.requests) ? input.requests.slice(0, SYNC_BATCH) : []) {
        if (typeof item?.id !== 'string' || !ID.test(item.id)) continue;
        if (db.prepare('SELECT 1 FROM capability_requests WHERE server=? AND remote_id=?').get(server.server, item.id)) { accepted.push(item.id); continue; }
        const row = read(item);
        if (!row) { rejected.push(item.id); continue; }
        if (today >= PER_DAY) continue;
        record({...row, requested_at: row.requested_at ?? at}, server.server, at);
        today++; accepted.push(item.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Repeated for a week, so one lost answer does not hold a finished need open on the server. `closed` (done) lets the server file
    // the need again. `declined` is separate so a server may close its own record of it while still not asking again: a server that
    // only reads `closed` keeps holding a declined need, on purpose.
    const told = status => db.prepare(`SELECT r.remote_id FROM capability_requests r JOIN capability_request_groups g ON g.key=r.key
      WHERE r.server=? AND g.status=? AND g.status_at>? ORDER BY r.id DESC LIMIT 100`).all(server.server, status, at - TELL_CLOSED_FOR).map(row => row.remote_id);
    return {accepted, rejected, closed: told('done'), declined: told('declined')};
  }

  function digest(rows) {
    const lines = new Map();
    for (const row of rows) {
      const id = row.server + '\0' + row.key;
      if (lines.has(id)) { lines.get(id).times++; continue; }
      lines.set(id, {...row, times: 1});
    }
    const shown = [...lines.values()].slice(0, DIGEST_LINES).map(row => `${digestText(row.server, 64)} (${digestText(clientOf(row.server, row.client), 80)}), ${row.kind}: ${digestText(row.title)}`
      + (row.times > 1 ? ` (${row.times} times)` : '') + (row.again_after ? `. Asked again after ${row.again_after}` : ''));
    const more = lines.size - shown.length;
    return [`Client requests: ${rows.length} new`, ...shown, ...(more > 0 ? [`and ${more} more`] : []), `${origin()}/requests`].join('\n');
  }

  let sending = false;
  // One digest for however many arrive: waits for the burst to end, keeps a gap between digests, and holds through quiet hours.
  async function tick() {
    const at = now();
    if (sending || quietHours(at)) return false;
    const oldest = db.prepare('SELECT min(received_at) at FROM capability_requests WHERE notified_at IS NULL').get().at;
    if (oldest === null || at - oldest < HOLD) return false;
    const last = Number(db.prepare('SELECT value FROM kv WHERE key=?').get(LAST_DIGEST)?.value || 0);
    if (at - last < DIGEST_GAP) return false;
    const rows = db.prepare(`SELECT r.id,r.server,r.key,r.kind,r.title,r.again_after,s.client FROM capability_requests r
      LEFT JOIN capability_request_servers s ON s.server=r.server WHERE r.notified_at IS NULL ORDER BY r.received_at,r.id`).all();
    sending = true;
    try {
      await notify(digest(rows));
      const done = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const mark = db.prepare('UPDATE capability_requests SET notified_at=? WHERE id=?');
        for (const row of rows) mark.run(done, row.id);
        db.prepare('INSERT INTO kv VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(LAST_DIGEST, String(done), done);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return true;
    // Still waiting, so the next tick tries again. The error text can carry the request, so it stays out of the log.
    } catch { log(`digest failed, ${rows.length} waiting`); return false; }
    finally { sending = false; }
  }

  function list() {
    const needs = db.prepare('SELECT server,kind,need,received_at FROM capability_requests WHERE key=? ORDER BY id DESC LIMIT 5');
    const servers = db.prepare(`SELECT r.server,s.client,count(*) count,max(r.received_at) last_at FROM capability_requests r
      LEFT JOIN capability_request_servers s ON s.server=r.server WHERE r.key=? GROUP BY r.server ORDER BY last_at DESC`);
    const groups = db.prepare(`SELECT g.*,(SELECT count(*) FROM capability_requests r WHERE r.key=g.key) count FROM capability_request_groups g
      ORDER BY CASE WHEN g.status IN ('done','declined') THEN 1 ELSE 0 END, count DESC, g.last_at DESC LIMIT 500`).all();
    return {statuses: STATUSES, groups: groups.map(g => ({key: g.key, kind: g.kind, title: g.title, status: g.status, status_at: g.status_at, first_at: g.first_at, last_at: g.last_at, count: g.count,
        servers: servers.all(g.key).map(s => ({server: s.server, client: clientOf(s.server, s.client), count: s.count, last_at: s.last_at})),
        needs: needs.all(g.key).map(n => ({server: n.server, kind: n.kind, need: n.need, at: n.received_at}))})),
      connections: db.prepare('SELECT server,client,last_seen FROM capability_request_servers ORDER BY server').all().map(s => ({server: s.server, client: clientOf(s.server, s.client), last_seen: s.last_seen}))};
  }

  function setStatus(key, status) {
    if (!STATUSES.includes(status)) throw refuse('Choose seen, planned, done or declined.');
    if (typeof key !== 'string' || !db.prepare('UPDATE capability_request_groups SET status=?,status_at=? WHERE key=?').run(status, now(), key).changes) throw refuse('That request is gone.');
  }

  let timer = null;
  const start = () => { if (timer) return; timer = setInterval(() => { void tick(); }, MINUTE); timer.unref?.(); };
  return {connect, sync, tick, list, setStatus, start, shutdown: () => { clearInterval(timer); timer = null; }};
}
