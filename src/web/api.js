// /api/* routes behind a session. CSRF is checked by index.js before any POST reaches here.
// Every atlas write ends with renderAtlasMd() and commit() unless the brain does it.
import {DOMAINS, ID_RE} from '../atlas/store.js';
import {lastJobRuns} from '../db.js';
import {today, loadModels, saveModels} from '../config.js';

const LONG_BODY = 64 * 1024;
const BOARD_LANES = ['open', 'in_progress', 'later', 'done'];
const LANE_ALIASES = {interest: 'later', progress: 'in_progress', 'in-progress': 'in_progress'};
const BOARD_AREAS = ['Mastan', 'Clients', 'Website', 'Mac mini', 'Work', 'Business', 'Personal'];
const PRIORITIES = ['high', 'medium', 'low'];
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function daysBetween(fromDate, toDate) {
  const a = Date.parse(String(fromDate).slice(0, 10) + 'T00:00:00Z'), b = Date.parse(toDate + 'T00:00:00Z');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400_000)) : null;
}
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function normaliseItem(item) {
  const lane = LANE_ALIASES[item.lane] || item.lane;
  return {id: item.id, title: item.title || '', area: item.area || '', lane: BOARD_LANES.includes(lane) ? lane : 'open',
    note: item.note || '', next: item.next || '', needs_you: !!item.needs_you, priority: item.priority || null,
    updated: item.updated || null, updated_by: item.last_by || item.updated_by || null};
}

export function createApi(ctx, {readJson, onlyKeys, fail, json}) {
  const {atlas} = ctx;
  const models = ctx.models || {load: loadModels, save: saveModels};
  const bad = (status, message) => Object.assign(fail(status, message), {expose: true});
  const answers = new Map(); // question id -> {state, started, result}

  function persist(message) {
    try { atlas.renderAtlasMd(); } catch (e) { console.error(`[web] render atlas failed ${e.code || e.name}`); }
    try { atlas.commit(message); } catch (e) { console.error(`[web] atlas commit failed ${e.code || e.name}`); }
  }
  function str(value, field, max, {min = 1} = {}) {
    if (typeof value !== 'string') throw bad(400, `${field} is required.`);
    const v = value.replace(/\r\n/g, '\n').trim();
    if (v.length < min) throw bad(400, `${field} is required.`);
    if (v.length > max) throw bad(400, `${field} is too long (${max} characters at most).`);
    return v;
  }
  function atlasId(id) { if (!ID_RE.test(id)) throw fail(404); return id; }

  // --- views
  function questionView(q, now) {
    const waiting = q.asked_at ? daysBetween(q.asked_at, now) : null;
    return {id: q.id, text: q.text || '', why: q.why || '', domain: q.domain || 'Other', status: q.status, asked_at: q.asked_at || null,
      waiting_days: waiting, answering: answers.get(q.id)?.state === 'filing'};
  }
  const notesView = d => (Array.isArray(d.notes) ? d.notes.filter(n => n && typeof n === 'object' && n.text).slice(-60)
    .map(n => ({date: n.date || null, by: n.by || '', text: String(n.text).slice(0, 2000)})) : []);
  function positionView(p) {
    return {id: p.id, domain: p.domain || 'Other', statement: p.statement || '', confidence: p.confidence ?? null, status: p.status || 'needs_confirmation',
      since: p.since || null, last_confirmed: p.last_confirmed || null, sources: Array.isArray(p.sources) ? p.sources.slice(0, 20) : [],
      links: Array.isArray(p.links) ? p.links.slice(0, 40) : [], tags: Array.isArray(p.tags) ? p.tags : [], notes: notesView(p)};
  }
  const noteBy = session => (session?.operator ? 'operator' : 'owner');
  const domainOrder = d => { const i = DOMAINS.indexOf(d); return i < 0 ? DOMAINS.length : i; };

  async function boardSnapshot() {
    if (!ctx.board || typeof ctx.board.snapshot !== 'function') return null;
    const snap = await ctx.board.snapshot();
    if (!snap || snap.unavailable) return {unavailable: String(snap?.unavailable || 'no snapshot')};
    const items = (Array.isArray(snap.items) ? snap.items : []).filter(Boolean).map(normaliseItem);
    return {items, synced_at: snap.synced_at || null, last_error: snap.last_error ? 'Last sync failed.' : null,
      read_only: snap.read_only ? String(snap.read_only).slice(0, 200) : null};
  }
  async function boardItem(id) {
    if (!BOARD_ID_RE.test(id)) throw fail(404);
    let snap;
    try { snap = await boardSnapshot(); } catch { throw bad(503, 'Board unavailable.'); }
    if (!snap || snap.unavailable) throw bad(503, 'Board unavailable.');
    if (snap.read_only) throw bad(403, 'The board is read-only for now.');
    const item = snap.items.find(i => i.id === id);
    if (!item) throw fail(404);
    return item;
  }
  function boardFields(input, {adding}) {
    const out = {};
    if (adding || input.title !== undefined) out.title = str(input.title, 'Title', 120);
    if (adding || input.area !== undefined) {
      if (!BOARD_AREAS.includes(input.area)) throw bad(400, 'Pick an area.');
      out.area = input.area;
    }
    if (input.lane !== undefined || adding) {
      const lane = LANE_ALIASES[input.lane] || input.lane || 'open';
      if (!BOARD_LANES.includes(lane)) throw bad(400, 'Pick a lane.');
      out.lane = lane;
    }
    for (const f of ['note', 'next']) if (input[f] !== undefined) out[f] = str(input[f], f === 'note' ? 'Note' : 'Next', 600, {min: 0});
    if (input.needs_you !== undefined) { if (typeof input.needs_you !== 'boolean') throw fail(400); out.needs_you = input.needs_you; }
    if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
      if (![...PRIORITIES, 'none'].includes(input.priority)) throw bad(400, 'Pick a priority.');
      out.priority = input.priority;
    }
    return out;
  }
  async function boardWrite(work) {
    if (!ctx.board) throw bad(503, 'Board unavailable.');
    try { return await work(); }
    catch (e) {
      if (e?.status === 409) throw bad(409, 'Changed elsewhere. Reload and try again.');
      if (e?.status === 400 || e?.status === 404) throw bad(e.status, 'The board refused that change.');
      if (e?.status === 503) throw bad(503, 'Board unavailable.');
      console.error(`[web] board write failed ${e?.status || e?.code || e?.name || 'Error'}`);
      throw bad(502, 'Board write failed. Try again in a minute.');
    }
  }

  const routes = [
    ['GET', /^\/api\/stats$/, () => atlas.stats()],
    ['GET', /^\/api\/graph$/, () => {
      const g = atlas.graph();
      return {domains: DOMAINS, nodes: g.nodes, links: g.links};
    }],
    ['GET', /^\/api\/node\/([^/]+)$/, (req, [id]) => {
      atlasId(id);
      const p = atlas.get('positions', id);
      if (p) return {kind: 'position', ...positionView(p), body: clip(p.body, 4000)};
      const person = atlas.get('people', id);
      if (!person) throw fail(404);
      const {body, file, notes, ...meta} = person;
      return {...meta, kind: person.kind || 'person', name: person.name || id, context: clip(person.context || '', 1000), links: Array.isArray(person.links) ? person.links.slice(0, 40) : [],
        notes: notesView(person), body: clip(body, 4000)};
    }],
    // A dated note from the panel on a position or a person: {date, by, text} appended to the file's notes list.
    ['POST', /^\/api\/(positions|people)\/([^/]+)\/note$/, async (req, [kind, id], session) => {
      atlasId(id);
      const input = await readJson(req);
      onlyKeys(input, ['text']);
      const text = str(input.text, 'Note', 2000);
      if (!atlas.get(kind, id)) throw fail(404);
      const doc = atlas.addNote(kind, id, {by: noteBy(session), text});
      persist(`web: note on ${id}`);
      return {ok: true, notes: notesView(doc)};
    }],

    // --- questions
    ['GET', /^\/api\/questions$/, () => {
      const now = today();
      const all = atlas.questions();
      const sortQ = (a, b) => String(a.asked_at || '').localeCompare(String(b.asked_at || '')) || a.id.localeCompare(b.id);
      const open = all.filter(q => q.status === 'open').sort(sortQ);
      const groups = new Map();
      for (const q of open) {
        const d = q.domain || 'Other';
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(questionView(q, now));
      }
      const later = all.filter(q => q.status === 'later').sort(sortQ).map(q => questionView(q, now));
      return {today: now, stats: atlas.stats(), later,
        groups: [...groups.entries()].sort((a, b) => domainOrder(a[0]) - domainOrder(b[0])).map(([domain, questions]) => ({domain, count: questions.length, questions}))};
    }],
    ['POST', /^\/api\/questions\/([^/]+)\/answer$/, async (req, [id]) => {
      atlasId(id);
      const input = await readJson(req, LONG_BODY);
      onlyKeys(input, ['text']);
      const text = str(input.text, 'Answer', 20000);
      const q = atlas.get('questions', id);
      if (!q) throw fail(404);
      const running = answers.get(id);
      if (running?.state === 'filing') return {state: 'filing'};
      if (q.status === 'answered') throw bad(409, 'Already answered.');
      for (const [k, v] of answers) if (Date.now() - v.started > 3600_000) answers.delete(k);
      const job = {state: 'filing', started: Date.now(), result: null};
      answers.set(id, job);
      const work = ctx.brain && typeof ctx.brain.answer === 'function'
        ? Promise.resolve().then(() => ctx.brain.answer(id, text, 'web'))
        : Promise.resolve().then(() => { atlas.setQuestionStatus(id, 'answered', text); persist(`web: answer ${id}`); return {summary: 'Answer saved.', created: [], changed: [id], followups: []}; });
      work.then(result => { job.state = 'done'; job.result = result || {}; },
        e => { job.state = 'error'; console.error(`[web] brain answer failed ${e?.code || e?.name || 'Error'}`); });
      // Respond once the question is marked answered (the brain does that first), not when it finishes.
      const deadline = Date.now() + 8000;
      while (job.state === 'filing' && Date.now() < deadline) {
        if (atlas.get('questions', id)?.status === 'answered') break;
        await sleep(100);
      }
      if (job.state === 'error') { answers.delete(id); throw bad(502, 'Could not file the answer. Try again.'); }
      return {state: job.state};
    }],
    ['GET', /^\/api\/questions\/([^/]+)\/answer$/, (req, [id]) => {
      atlasId(id);
      const job = answers.get(id);
      if (!job) {
        const q = atlas.get('questions', id);
        return {state: q?.status === 'answered' ? 'done' : 'unknown', summary: '', followups: []};
      }
      if (job.state !== 'done') return {state: job.state, summary: '', followups: []};
      const r = job.result || {};
      const now = today();
      const followups = (Array.isArray(r.followups) ? r.followups : []).map(fid => {
        try { const q = ID_RE.test(fid) && atlas.get('questions', fid); return q ? questionView(q, now) : null; } catch { return null; }
      }).filter(Boolean);
      return {state: 'done', summary: clip(r.summary || '', 1200), created: (r.created || []).length, changed: (r.changed || []).length, followups};
    }],
    ['POST', /^\/api\/questions\/([^/]+)\/(later|skip|reopen)$/, async (req, [id, action]) => {
      atlasId(id);
      onlyKeys(await readJson(req), []);
      if (!atlas.get('questions', id)) throw fail(404);
      const status = {later: 'later', skip: 'skipped', reopen: 'open'}[action];
      atlas.setQuestionStatus(id, status);
      persist(`web: question ${id} ${status}`);
      return {ok: true, status};
    }],

    // --- positions
    ['GET', /^\/api\/positions$/, () => ({domains: DOMAINS, positions: atlas.positions().map(positionView)
      .sort((a, b) => domainOrder(a.domain) - domainOrder(b.domain) || (b.confidence || 0) - (a.confidence || 0) || a.id.localeCompare(b.id))})],
    // reject takes an optional {reason}: kept in the file (rejected_reason and the body) and shown to the extractor so
    // the same guess is not made again.
    ['POST', /^\/api\/positions\/([^/]+)\/(confirm|reject)$/, async (req, [id, action]) => {
      atlasId(id);
      const input = await readJson(req);
      onlyKeys(input, action === 'reject' ? ['reason'] : []);
      const reason = action === 'reject' && input.reason !== undefined && input.reason !== '' ? str(input.reason, 'Reason', 600) : '';
      if (!atlas.get('positions', id)) throw fail(404);
      const p = action === 'confirm' ? atlas.setPositionStatus(id, 'active') : atlas.rejectPosition(id, reason);
      persist(`web: ${action} position ${id}`);
      return {ok: true, position: positionView({...p, id})};
    }],
    ['POST', /^\/api\/positions\/([^/]+)\/edit$/, async (req, [id]) => {
      atlasId(id);
      const input = await readJson(req);
      onlyKeys(input, ['statement']);
      const statement = str(input.statement, 'Statement', 600);
      const p = atlas.get('positions', id);
      if (!p) throw fail(404);
      p.statement = statement;
      p.edited_at = today();
      const saved = atlas.put('positions', p);
      persist(`web: edit position ${id}`);
      return {ok: true, position: positionView({...saved, id})};
    }],

    // --- dumps
    ['GET', /^\/api\/dumps$/, () => ({dumps: atlas.dumps().slice(0, 40).map(d => {
      const raw = String(d.body || '').replace(/^## Raw\s*/, '').split(/\n## /)[0];
      return {id: d.id, date: d.date || null, created: d.created || null, source: d.source || null, status: d.status || 'new',
        preview: clip(raw.trim(), 280), summary: d.summary ? clip(d.summary, 400) : ''};
    })})],
    ['POST', /^\/api\/dumps$/, async (req) => {
      const input = await readJson(req, LONG_BODY);
      onlyKeys(input, ['text']);
      const text = str(input.text, 'Text', 50000);
      if (!ctx.brain || typeof ctx.brain.dump !== 'function') {
        const r = atlas.addDump(text, 'web');
        persist('web: dump');
        return {ok: true, state: 'saved', id: r.id};
      }
      // brain.dump files the dump synchronously and returns the processing promise (with .dumpId).
      let raw;
      try { raw = ctx.brain.dump(text, 'web'); }
      catch (e) { console.error(`[web] dump failed ${e?.code || e?.name || 'Error'}`); throw bad(e?.status === 400 ? 400 : 502, 'Could not save the dump. Try again.'); }
      const id = typeof raw?.dumpId === 'string' ? raw.dumpId : null;
      const work = Promise.resolve(raw);
      let filed = false;
      const outcome = work.then(r => { filed = true; return {ok: true, result: r}; }, e => ({ok: false, e}));
      outcome.then(r => { if (!r.ok) console.error(`[web] dump processing failed ${r.e?.code || r.e?.name || 'Error'}`); });
      return {ok: true, state: filed ? 'saved' : 'filing', id};
    }],

    // --- board
    ['GET', /^\/api\/board$/, async () => {
      let snap = null, reason = 'Board unavailable.';
      try { snap = await boardSnapshot(); } catch (e) { console.error(`[web] board snapshot failed ${e?.status || e?.code || e?.name || 'Error'}`); }
      if (!snap || snap.unavailable) {
        const why = {'board token not set': 'Board access is not set up yet.', 'not synced yet': 'The first board sync has not run yet.'}[snap?.unavailable];
        return {available: false, reason: why || reason, items: [], lanes: BOARD_LANES, areas: BOARD_AREAS};
      }
      return {available: true, read_only: snap.read_only, items: snap.items, synced_at: snap.synced_at, last_error: snap.last_error, lanes: BOARD_LANES, areas: BOARD_AREAS};
    }],
    ['POST', /^\/api\/board\/items$/, async (req) => {
      const input = await readJson(req);
      onlyKeys(input, ['title', 'area', 'lane', 'note', 'next', 'needs_you', 'priority']);
      const fields = boardFields(input, {adding: true});
      if (fields.priority === 'none') delete fields.priority;
      let snap = null;
      try { snap = await boardSnapshot(); } catch {}
      if (!snap || snap.unavailable) throw bad(503, 'Board unavailable.');
      if (snap.read_only) throw bad(403, 'The board is read-only for now.');
      const result = await boardWrite(() => ctx.board.add(fields));
      return {ok: true, item: result?.id ? normaliseItem(result) : result?.item?.id ? normaliseItem(result.item) : null};
    }],
    ['POST', /^\/api\/board\/items\/([^/]+)\/done$/, async (req, [id]) => {
      onlyKeys(await readJson(req), []);
      await boardItem(id);
      const result = await boardWrite(() => ctx.board.done(id));
      return {ok: true, item: result?.item?.id ? normaliseItem(result.item) : result?.id ? normaliseItem(result) : null};
    }],
    ['POST', /^\/api\/board\/items\/([^/]+)$/, async (req, [id]) => {
      const input = await readJson(req);
      onlyKeys(input, ['title', 'area', 'lane', 'note', 'next', 'needs_you', 'priority']);
      const patch = boardFields(input, {adding: false});
      if (!Object.keys(patch).length) throw fail(400);
      await boardItem(id);
      const result = await boardWrite(() => (patch.lane === 'done' && Object.keys(patch).length === 1 ? ctx.board.done(id) : ctx.board.update(id, patch)));
      return {ok: true, item: result?.item?.id ? normaliseItem(result.item) : result?.id ? normaliseItem(result) : null};
    }],

    // --- settings
    ['GET', /^\/api\/settings$/, (req, m, session) => {
      const m0 = models.load();
      let jobs = [];
      try { jobs = lastJobRuns().map(j => ({job: j.job, started: j.started ? new Date(j.started).toISOString() : null, finished: j.finished ? new Date(j.finished).toISOString() : null, status: j.status, detail: clip(j.detail || '', 300)})); } catch {}
      let stats = null;
      try { stats = atlas.stats(); } catch {}
      return {roles: m0.roles || {}, choices: m0.choices || {}, fallbacks: m0.fallbacks || {}, changed_by: m0.changed_by || null,
        changed_at: m0.changed_at || null, jobs, stats, operator: !!session.operator};
    }],
    ['POST', /^\/api\/settings\/models$/, async (req, m, session) => {
      if (session.operator) throw bad(403, 'Only Owner changes models.');
      const input = await readJson(req);
      onlyKeys(input, ['roles']);
      if (!input.roles || typeof input.roles !== 'object' || Array.isArray(input.roles)) throw fail(400);
      const current = models.load();
      const changed = [];
      for (const [name, model] of Object.entries(input.roles)) {
        const r = current.roles?.[name];
        if (!r) throw bad(400, 'Unknown role.');
        const choices = current.choices?.[r.provider] || [];
        if (typeof model !== 'string' || !choices.includes(model)) throw bad(400, `That model is not in the list for ${name}.`);
        if (r.model !== model) { r.model = model; changed.push(name); }
      }
      if (changed.length) models.save(current, 'owner');
      return {ok: true, changed};
    }],
  ];

  return async function api(req, res, path, session) {
    for (const [method, re, handler] of routes) {
      const m = path.match(re);
      if (!m) continue;
      if ((req.method === 'HEAD' ? 'GET' : req.method) !== method) continue;
      if (!atlas && !path.startsWith('/api/board') && !path.startsWith('/api/settings')) throw bad(503, 'Atlas unavailable.');
      let params;
      try { params = m.slice(1).map(decodeURIComponent); } catch { throw fail(404); }
      const out = await handler(req, params, session);
      return json(res, 200, out);
    }
    if (routes.some(([, re]) => re.test(path))) throw fail(405);
    throw fail(404);
  };
}
