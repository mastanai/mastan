// Topic Board client for mastan-me. The service of record stays on https://mastan.ai/board/;
// this client reads a cached snapshot and writes straight to the board API as actor "mastan-me".
//
// Item shape (what snapshot().items and list() return; Track B renders these):
//   {
//     id: 't042',                       // board id, stable
//     title: 'Short title',             // <= 120 chars
//     area: 'Mastan',                   // one of AREAS below (every area, Work included since 26 Oct)
//     lane: 'open' | 'in_progress' | 'later' | 'done'   // legacy 'interest' is shown as 'later'
//     priority: 'high' | 'medium' | 'low' | null,
//     needs_you: true | false,          // Owner must act
//     note: '...', next: '...',         // <= 600 chars each, may be ''
//     updated: 'YYYY-MM-DD',            // last change date (board's own field)
//     created: 'YYYY-MM-DD' | null,     // from the board history (first 'add')
//     last_by: 'owner' | 'claude' | 'mastan-me' | ..., last_ts: ISO time | null,
//     version: 'sha256 hex'             // optimistic lock; the client handles it for you
//   }
//
// snapshot() -> {items, synced_at, updated_at, updated_by, areas, lanes, priorities, source,
//                read_only?, last_error?, unavailable?}
//   Synchronous, reads workspace/board/snapshot.json. source: 'api' (live sync) or 'mirror' (pushed from
//   Owner's Mac by bin/push-board-mirror, read only). No token: the mirror items plus
//   read_only: 'writer token not approved yet' (UI hides write controls); with no mirror either:
//   {items: [], synced_at: null, unavailable: 'board token not set'}. Never synced: unavailable = 'not synced yet'.
// list({lane, area, needsYou}) -> items (sync, from the cache, ordered like board.py)
// get(id) -> item | null (sync, from the cache)
// async sync() -> snapshot             GET /board/api/board, cache written (0600)
// async add({title, area, lane?, priority?, note?, next?, needs_you?}) -> item
// async update(id, patch) -> item      patch keys: title, area, lane, priority ('none' clears), note, next, needs_you
// async done(id, {note}?) -> item
// importMirror({data, meta}) -> snapshot   read-only snapshot from the Mac mirror (the diary never comes)
// Writes: on 409 the client reloads and retries once, then refreshes the cache from the reply.
// Without a token every write throws 'Board is read-only until the writer token is approved'.
// Errors carry .status (HTTP) and a plain message; they never contain the token.
import {readFileSync, writeFileSync, mkdirSync, renameSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const AREAS = ['Mastan', 'Clients', 'Website', 'Mac mini', 'Work', 'Business', 'Personal'];
export const LANES = ['open', 'in_progress', 'later', 'done'];
export const LANE_NAMES = {open: 'Open', in_progress: 'In progress', later: 'Later', done: 'Done'};
export const PRIORITIES = ['high', 'medium', 'low'];
const LANE_ALIASES = {interest: 'later', progress: 'in_progress', 'in-progress': 'in_progress'};
const ACTOR = 'mastan-me';
const BOARD_ORIGIN = 'https://mastan.ai';
const MAX_BODY = 8_000_000;

function boardError(message, status = 0) { return Object.assign(new Error(message), {status}); }

function baseUrl(config) {
  const raw = String(config.boardUrl || 'https://mastan.ai/board/').replace(/\/+$/, '');
  const u = new URL(raw);
  const live = raw === 'https://mastan.ai/board';
  const loopbackTest = u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === '/board';
  if (!live && !loopbackTest) throw boardError('board URL must be https://mastan.ai/board/');
  return raw;
}

function laneOf(lane) { return LANE_ALIASES[lane] || lane; }

function request(config, path, {method = 'GET', body} = {}) {
  const url = new URL(baseUrl(config) + path);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = {Authorization: 'Bearer ' + config.boardToken, Accept: 'application/json', 'User-Agent': 'mastan-me-board/1'};
  if (payload) Object.assign(headers, {'Content-Type': 'application/json', 'Content-Length': String(payload.length),
    Origin: BOARD_ORIGIN, 'X-Board-Token': 'board'});
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {method, headers, timeout: 20_000}, res => {
      const parts = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(boardError('board reply too large')); else parts.push(c); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch {}
        const status = res.statusCode;
        if (status >= 200 && status < 300 && json) return resolve(json);
        if (status === 409) return reject(Object.assign(boardError('Changed elsewhere on the board.', 409), {result: json}));
        if (status === 401) return reject(boardError('board token rejected (401)', 401));
        if (status === 403) return reject(boardError('board refused the request (403)', 403));
        if (status === 400) return reject(boardError(`board rejected the change: ${String(json?.error || 'bad request').slice(0, 200)}`, 400));
        reject(boardError(`board request failed (${status})`, status || 502));
      });
    });
    req.on('timeout', () => req.destroy(boardError('board request timed out', 504)));
    req.on('error', e => reject(e.status ? e : boardError('board is unreachable', 503)));
    if (payload) req.write(payload);
    req.end();
  });
}

// board.py order: lane, priority, then newest first, id as tie-break.
function ordered(items) {
  const lanes = ['open', 'in_progress', 'later', 'done'];
  const prio = [...PRIORITIES, null];
  return [...items].sort((a, b) => lanes.indexOf(a.lane) - lanes.indexOf(b.lane)
    || prio.indexOf(a.priority) - prio.indexOf(b.priority)
    || String(b.updated).localeCompare(String(a.updated)) || String(b.id).localeCompare(String(a.id)));
}

// API snapshot -> cache document.
export const READ_ONLY = 'writer token not approved yet';

export function toCache(result, syncedAt = new Date().toISOString(), source = 'api') {
  const data = result?.data;
  if (!data || !Array.isArray(data.items)) throw boardError('board snapshot has no items', 502);
  const versions = result.versions || {};
  const created = {}, last = {};
  for (const e of result.history || []) {
    if (!e || typeof e.id !== 'string') continue;
    if (e.op === 'add' && !created[e.id]) created[e.id] = String(e.ts || '').slice(0, 10) || null;
    last[e.id] = {by: e.by || null, ts: e.ts || null};
  }
  // Mirror pushes carry per-item history facts instead of the raw history (the diary stays on the Mac).
  for (const [id, m] of Object.entries(result.meta || {})) {
    if (m?.created && !created[id]) created[id] = String(m.created).slice(0, 10);
    if (m?.last_by || m?.last_ts) last[id] = {by: m.last_by || null, ts: m.last_ts || null};
  }
  const items = [];
  for (const it of data.items) {
    if (!it || typeof it.id !== 'string' || typeof it.title !== 'string') continue;
    items.push({
      id: it.id, title: it.title, area: it.area, lane: laneOf(it.lane), priority: it.priority || null,
      needs_you: Boolean(it.needs_you), note: it.note || '', next: it.next || '', updated: it.updated || null,
      created: created[it.id] || null, last_by: last[it.id]?.by || null, last_ts: last[it.id]?.ts || null,
      version: versions[it.id] || null,
    });
  }
  const doc = {source, synced_at: syncedAt, updated_at: data.updated_at || null, updated_by: data.updated_by || null,
    areas: AREAS, lanes: LANES, priorities: PRIORITIES, items: ordered(items)};
  if (source === 'mirror') doc.read_only = READ_ONLY;
  return doc;
}

function clip(field, value, max) {
  if (typeof value !== 'string') throw boardError(`${field} must be text`, 400);
  const v = value.trim();
  if (field === 'title' && !v) throw boardError('title cannot be empty', 400);
  if (v.length > max) throw boardError(`${field} must be at most ${max} characters`, 400);
  return v;
}

// Validate and normalise a write body. Same rules as the board server.
export function cleanFields(input, {adding = false} = {}) {
  const allowed = ['title', 'area', 'lane', 'priority', 'note', 'next', 'needs_you'];
  const out = {};
  for (const [k, raw] of Object.entries(input || {})) {
    if (raw === undefined || raw === null) continue;
    if (!allowed.includes(k)) throw boardError(`unknown field: ${k}`, 400);
    if (k === 'title') out.title = clip('title', raw, 120);
    else if (k === 'note' || k === 'next') out[k] = clip(k, raw, 600);
    else if (k === 'area') {
      if (!AREAS.includes(raw)) throw boardError(`area must be one of: ${AREAS.join(', ')}`, 400);
      out.area = raw;
    } else if (k === 'lane') {
      const lane = laneOf(raw);
      if (!LANES.includes(lane)) throw boardError(`lane must be one of: ${LANES.join(', ')}`, 400);
      out.lane = lane;
    } else if (k === 'priority') {
      if (![...PRIORITIES, 'none'].includes(raw)) throw boardError('priority must be high, medium, low or none', 400);
      out.priority = raw;
    } else if (k === 'needs_you') {
      if (typeof raw !== 'boolean') throw boardError('needs_you must be true or false', 400);
      out.needs_you = raw;
    }
  }
  if (adding) {
    if (!out.title || !out.area) throw boardError('title and area are required', 400);
    out.lane ||= 'open';
    if (out.priority === 'none') delete out.priority;
  } else if (!Object.keys(out).length) throw boardError('update needs at least one field', 400);
  return out;
}

export function createBoardClient(config) {
  const dir = join(config.workspace, 'board');
  const cachePath = join(dir, 'snapshot.json');
  const statePath = join(dir, 'sync-state.json');
  const hasToken = () => Boolean(config.boardToken);
  const needToken = () => { if (!hasToken()) throw boardError('Board is read-only until the writer token is approved', 503); };

  const writeJson = (p, value) => {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
    renameSync(tmp, p);
  };
  const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
  const setState = patch => writeJson(statePath, {...(readJson(statePath) || {}), ...patch});

  function snapshot() {
    const cache = existsSync(cachePath) ? readJson(cachePath) : null;
    if (!hasToken()) {
      if (cache?.source === 'mirror') return {...cache, read_only: READ_ONLY};
      return {items: [], synced_at: null, unavailable: 'board token not set'};
    }
    const state = readJson(statePath) || {};
    if (!cache) return {items: [], synced_at: null, unavailable: 'not synced yet', ...(state.last_error ? {last_error: state.last_error} : {})};
    const out = {...cache};
    if (state.last_error && state.last_error_at > (cache.synced_at || '')) { out.last_error = state.last_error; out.last_error_at = state.last_error_at; }
    return out;
  }

  function list({lane, area, needsYou} = {}) {
    return (snapshot().items || []).filter(i => (!lane || i.lane === laneOf(lane)) && (!area || i.area === area)
      && (needsYou === undefined || i.needs_you === needsYou));
  }

  function get(id) { return (snapshot().items || []).find(i => i.id === id) || null; }

  // Read-only snapshot pushed from the Mac mirror. synced_at = the mirror's own updated_at.
  function importMirror(input) {
    const data = input?.data;
    if (!data || !Array.isArray(data.items)) throw boardError('mirror has no items', 400);
    const doc = toCache({data: {...data, diary: undefined}, meta: input.meta || {}}, data.updated_at || new Date().toISOString(), 'mirror');
    doc.imported_at = new Date().toISOString();
    writeJson(cachePath, doc);
    setState({last_mirror: doc.imported_at});
    return doc;
  }

  function store(result) {
    const doc = toCache(result);
    writeJson(cachePath, doc);
    setState({last_ok: doc.synced_at, last_error: null, last_error_at: null});
    return doc;
  }

  async function sync() {
    needToken();
    try { return store(await request(config, '/api/board')); }
    catch (e) {
      try { setState({last_error: e.message.slice(0, 200), last_error_at: new Date().toISOString()}); } catch {}
      throw e;
    }
  }

  // Fresh item + version from the API (never the cache).
  async function fresh(id) {
    const result = await request(config, '/api/board');
    const item = result.data?.items?.find(i => i.id === id);
    if (!item) throw boardError(`unknown item: ${id}`, 404);
    return {result, item, version: result.versions?.[id]};
  }

  const itemFrom = (result, id) => {
    const doc = store(result);
    return doc.items.find(i => i.id === (id || result.item?.id)) || null;
  };

  async function writeItem(id, path, body) {
    needToken();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(id))) throw boardError('bad item id', 400);
    for (let attempt = 0; ; attempt++) {
      const {version} = await fresh(id);
      if (!version) throw boardError(`no version for ${id}; try again after a sync`, 409);
      try {
        const result = await request(config, `/api/items/${encodeURIComponent(id)}${path}`, {method: 'POST', body: {...body, version}});
        return itemFrom(result, id);
      } catch (e) {
        if (e.status !== 409 || attempt >= 1) {
          if (e.status === 409) throw boardError(`${id} changed on the board twice while saving; reload and check it`, 409);
          throw e;
        }
      }
    }
  }

  async function add(item) {
    needToken();
    const body = cleanFields(item, {adding: true});
    const result = await request(config, '/api/items', {method: 'POST', body});
    return itemFrom(result, result.item?.id);
  }

  async function update(id, patch) {
    const body = cleanFields(patch);
    return writeItem(id, '', body);
  }

  async function done(id, {note} = {}) {
    const body = note === undefined || note === null ? {} : {note: clip('note', note, 600)};
    return writeItem(id, '/done', body);
  }

  return {snapshot, list, get, sync, add, update, done, importMirror, hasToken, actor: ACTOR, cachePath};
}
