// Atlas store: markdown files with YAML frontmatter inside the workspace git repo.
// positions/, people/, questions/, dumps/, conversations/, plus generated ATLAS.md.
import {readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync, renameSync, appendFileSync, linkSync, unlinkSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';
import {config, today} from '../config.js';

export const DOMAINS = ['Self & psychology', 'Work & building', 'Money & investing', 'Meaning & spirituality',
  'Family & parenting', 'Technology & AI', 'Science & cosmos', 'Health & body', 'Mastan & product', 'Decisions I delegate'];
export const POSITION_LINKS = ['supports', 'depends', 'tension', 'about_person'];
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KINDS = {positions: 'p-', questions: 'q-', people: ''};
const MAX_NOTES = 60;

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// One workspace commit at a time across processes (service, admin CLI inside agent turns, jobs). A dead
// holder's lock is taken over; after waitMs the caller goes ahead anyway and relies on git's own index.lock.
export function takeLock(path, waitMs = 20_000) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      // The lock appears with its pid already inside. An empty lock would read as a dead holder and be taken over.
      const tmp = `${path}.${process.pid}`;
      writeFileSync(tmp, String(process.pid), {mode: 0o600});
      try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
      return () => { try { if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(readFileSync(path, 'utf8').trim()); } catch { continue; } // just released: the next holder's lock must not be removed
      if (pid && !pidAlive(pid)) { try { unlinkSync(path); } catch {} continue; }
      if (Date.now() > end) return null;
      execFileSync('sleep', ['0.1']);
    }
  }
}

export function parseDoc(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return {meta: {}, body: text};
  return {meta: YAML.parse(m[1]) || {}, body: m[2].trim()};
}
export function renderDoc(meta, body = '') {
  return `---\n${YAML.stringify(meta, {lineWidth: 0}).trim()}\n---\n${body ? body.trim() + '\n' : ''}`;
}

export function slug(text, max = 50) {
  let s = String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length > max) { s = s.slice(0, max + 1); s = s.slice(0, s.lastIndexOf('-') > 10 ? s.lastIndexOf('-') : max); }
  return s.replace(/-$/, '') || 'item';
}

export class Atlas {
  constructor(dir = config.atlasDir, workspace = config.workspace) {
    this.dir = dir;
    this.workspace = workspace;
    for (const sub of ['positions', 'people', 'questions', 'dumps', 'conversations']) mkdirSync(join(dir, sub), {recursive: true});
    this.cache = new Map();
  }

  path(kind, id) {
    if (!ID_RE.test(id)) throw new Error('Bad id');
    return join(this.dir, kind, id + '.md');
  }

  // Cached by mtime, so the agent editing files directly is picked up.
  // Git drops empty folders (for example after a reset), so every read and write tolerates a missing one.
  ensure(kind) { mkdirSync(join(this.dir, kind), {recursive: true}); return join(this.dir, kind); }

  readKind(kind) {
    const dir = this.ensure(kind);
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const p = join(dir, f);
      const mtime = statSync(p).mtimeMs;
      let hit = this.cache.get(p);
      if (!hit || hit.mtime !== mtime) {
        try {
          const {meta, body} = parseDoc(readFileSync(p, 'utf8'));
          hit = {mtime, doc: {...meta, id: meta.id || f.slice(0, -3), body, file: `${kind}/${f}`}};
        } catch {
          hit = {mtime, doc: null};
        }
        this.cache.set(p, hit);
      }
      if (hit.doc) out.push(hit.doc);
    }
    return out;
  }

  get(kind, id) {
    const p = this.path(kind, id);
    if (!existsSync(p)) return null;
    const {meta, body} = parseDoc(readFileSync(p, 'utf8'));
    return {...meta, id, body};
  }

  put(kind, doc) {
    const {body = '', file, ...meta} = doc;
    this.ensure(kind);
    const p = this.path(kind, meta.id);
    const tmp = p + '.tmp';
    writeFileSync(tmp, renderDoc(meta, body));
    renameSync(tmp, p);
    return this.get(kind, meta.id);
  }

  uniqueId(kind, base) {
    let id = (KINDS[kind] && !base.startsWith(KINDS[kind]) ? KINDS[kind] : '') + slug(base);
    id = id.slice(0, 70);
    let n = 2, candidate = id;
    while (existsSync(join(this.dir, kind, candidate + '.md'))) candidate = `${id}-${n++}`;
    return candidate;
  }

  positions({includeSuperseded = false} = {}) {
    return this.readKind('positions').filter(p => includeSuperseded || p.status !== 'superseded');
  }
  people() { return this.readKind('people'); }
  questions(status) {
    const all = this.readKind('questions');
    return status ? all.filter(q => (Array.isArray(status) ? status : [status]).includes(q.status)) : all;
  }
  dumps() {
    return readdirSync(this.ensure('dumps')).filter(f => f.endsWith('.md')).sort().reverse()
      .map(f => ({id: f.slice(0, -3), ...parseDoc(readFileSync(join(this.dir, 'dumps', f), 'utf8'))}))
      .map(({id, meta, body}) => ({...meta, id, body}));
  }

  // --- positions
  setPositionStatus(id, status, extra = {}) {
    const p = this.get('positions', id);
    if (!p) throw Object.assign(new Error('Not found'), {status: 404});
    p.status = status;
    if (status === 'active') { p.last_confirmed = today(); p.confidence = Math.max(Number(p.confidence) || 0, 0.8); }
    Object.assign(p, extra);
    return this.put('positions', p);
  }
  // Owner rejected it: superseded, dated, with his reason (frontmatter and body) so the extractor never re-infers it.
  rejectPosition(id, reason = '') {
    const date = today();
    const extra = {rejected_at: date};
    const p = this.get('positions', id);
    if (!p) throw Object.assign(new Error('Not found'), {status: 404});
    if (reason) { extra.rejected_reason = reason; extra.body = `${p.body || ''}\n\n${date} rejected by Owner: ${reason}`.trim(); }
    return this.setPositionStatus(id, 'superseded', extra);
  }
  // Positions Owner rejected, newest first: the extractor and the consolidate job list them as "do not recreate".
  rejected(limit = 40) {
    return this.readKind('positions').filter(p => p.status === 'superseded' && p.rejected_at)
      .sort((a, b) => String(b.rejected_at).localeCompare(String(a.rejected_at)) || a.id.localeCompare(b.id)).slice(0, limit)
      .map(p => ({id: p.id, statement: p.statement || '', reason: p.rejected_reason || '', date: p.rejected_at}));
  }
  // Dated note on a position or a person, written from the web panel or by the agent. notes: [{date, by, text}].
  addNote(kind, id, {by = 'owner', text}) {
    if (!['positions', 'people'].includes(kind)) throw new Error('Bad kind');
    const doc = this.get(kind, id);
    if (!doc) throw Object.assign(new Error('Not found'), {status: 404});
    const notes = Array.isArray(doc.notes) ? doc.notes.filter(n => n && typeof n === 'object') : [];
    notes.push({date: today(), by, text: String(text).trim()});
    doc.notes = notes.slice(-MAX_NOTES);
    return this.put(kind, doc);
  }
  // id -> ISO date the file first entered the workspace repo (git), birth time when git has no record. Cached per HEAD.
  addedAt() {
    let head = '';
    try { head = execFileSync('git', ['-C', this.workspace, 'rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch {}
    const map = this.addedCache && this.addedCache.head === head ? this.addedCache.map : this.addedFromGit();
    this.addedCache = {head, map};
    // files git has not seen yet (written since the last commit): their birth time, not cached
    let extra = null;
    for (const kind of ['positions', 'people']) {
      for (const doc of this.readKind(kind)) {
        if (map.has(doc.id)) continue;
        try { const st = statSync(join(this.dir, doc.file)); (extra ||= new Map(map)).set(doc.id, new Date(st.birthtimeMs || st.mtimeMs).toISOString()); } catch {}
      }
    }
    return extra || map;
  }
  addedFromGit() {
    const map = new Map();
    try {
      const out = execFileSync('git', ['-C', this.workspace, 'log', '--reverse', '--diff-filter=A', '--no-renames', '--format=%ct', '--name-only', '--', 'atlas/positions', 'atlas/people'],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024});
      let ts = 0;
      for (const line of out.split('\n')) {
        if (/^\d{9,}$/.test(line)) { ts = Number(line) * 1000; continue; }
        const m = line.match(/^atlas\/(positions|people)\/([a-z0-9-]+)\.md$/);
        if (m && ts && !map.has(m[2])) map.set(m[2], new Date(ts).toISOString());
      }
    } catch {}
    return map;
  }

  // --- questions
  setQuestionStatus(id, status, answer = null) {
    const q = this.get('questions', id);
    if (!q) throw Object.assign(new Error('Not found'), {status: 404});
    q.status = status;
    if (status === 'later') q.asked_at = today(); // back of the queue
    if (answer !== null) { q.answer = answer; q.answered_at = new Date().toISOString(); }
    return this.put('questions', q);
  }

  // Morning set: up to 5 open questions, oldest first, at most 2 per domain.
  morningSet(limit = 5) {
    const open = this.questions('open').sort((a, b) => String(a.asked_at).localeCompare(String(b.asked_at)) || a.id.localeCompare(b.id));
    const per = {}, out = [];
    for (const q of open) {
      if ((per[q.domain] || 0) >= 2) continue;
      per[q.domain] = (per[q.domain] || 0) + 1;
      out.push(q);
      if (out.length >= limit) break;
    }
    return out;
  }

  // --- dumps and conversations
  addDump(text, source = 'web') {
    const date = today();
    this.ensure('dumps');
    const id = this.uniqueIdIn('dumps', `${date}-${slug(text, 40)}`);
    const doc = renderDoc({id, date, created: new Date().toISOString(), source, status: 'new'}, `## Raw\n\n${text.trim()}\n`);
    writeFileSync(join(this.dir, 'dumps', id + '.md'), doc);
    return {id, file: `dumps/${id}.md`};
  }
  updateDump(id, metaPatch, appendBody = '') {
    const p = join(this.dir, 'dumps', id + '.md');
    const {meta, body} = parseDoc(readFileSync(p, 'utf8'));
    writeFileSync(p, renderDoc({...meta, ...metaPatch}, body + (appendBody ? `\n\n${appendBody.trim()}\n` : '')));
  }
  uniqueIdIn(sub, base) {
    let n = 2, c = base;
    while (existsSync(join(this.dir, sub, c + '.md'))) c = `${base}-${n++}`;
    return c;
  }
  newConversation(title, meta = {}) {
    const date = today();
    const existing = readdirSync(this.ensure('conversations')).filter(f => f.startsWith(date)).length;
    const id = this.uniqueIdIn('conversations', `${date}-${existing + 1}`);
    writeFileSync(join(this.dir, 'conversations', id + '.md'), renderDoc({id, date, title, ...meta}, ''));
    return id;
  }
  appendConversation(id, text) {
    appendFileSync(join(this.dir, 'conversations', id + '.md'), `\n${text.trim()}\n`);
  }
  // Short daily log line for every chat reply (one file per day).
  logChat(channel, userText, replyText) {
    const date = today();
    const p = join(this.ensure('conversations'), `${date}-chat.md`);
    if (!existsSync(p)) writeFileSync(p, renderDoc({id: `${date}-chat`, date, title: 'Chat log'}, ''));
    const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
    const time = new Intl.DateTimeFormat('en-GB', {timeZone: config.tz, hour: '2-digit', minute: '2-digit'}).format(new Date());
    appendFileSync(p, `- ${time} ${channel}: Owner: ${clip(userText, 200)} | Me: ${clip(replyText, 200)}\n`);
  }

  // --- derived views
  linkPairs() {
    const ids = new Set([...this.positions().map(p => p.id), ...this.people().map(p => p.id)]);
    const pairs = new Map();
    for (const doc of [...this.positions(), ...this.people()]) {
      for (const l of doc.links || []) {
        if (!l || !ids.has(l.id) || l.id === doc.id) continue;
        const key = [doc.id, l.id].sort().join('|');
        if (!pairs.has(key)) pairs.set(key, {source: doc.id, target: l.id, type: l.type || 'related'});
        else if (l.type === 'tension') pairs.get(key).type = 'tension';
      }
    }
    return [...pairs.values()];
  }

  stats() {
    const pairs = this.linkPairs();
    let last = 0;
    try { last = Number(execFileSync('git', ['-C', this.workspace, 'log', '-1', '--format=%ct'], {encoding: 'utf8'}).trim()) * 1000; } catch {}
    return {
      positions: this.positions().length,
      needs_confirmation: this.positions().filter(p => p.status === 'needs_confirmation').length,
      people: this.people().length,
      connections: pairs.length,
      tensions: pairs.filter(p => p.type === 'tension').length,
      dumps: this.dumps().length,
      open_questions: this.questions('open').length,
      last_updated: last ? new Date(last).toISOString() : null,
    };
  }

  graph() {
    const added = this.addedAt();
    const nodes = [
      ...this.positions().map(p => ({id: p.id, kind: 'position', label: p.statement, domain: p.domain, confidence: p.confidence, status: p.status, added: added.get(p.id) || null})),
      ...this.people().map(p => ({id: p.id, kind: p.kind || 'person', label: p.name, domain: 'People', relationship: p.relationship, role: p.role, added: added.get(p.id) || null})),
    ];
    return {nodes, links: this.linkPairs()};
  }

  tensions() {
    const byId = new Map(this.positions().map(p => [p.id, p]));
    return this.linkPairs().filter(l => l.type === 'tension' && byId.has(l.source) && byId.has(l.target))
      .map(l => ({a: byId.get(l.source), b: byId.get(l.target)}));
  }

  // ATLAS.md: what every agent session reads first. Kept under about 4,000 tokens.
  renderAtlasMd() {
    const s = this.stats();
    const lines = [`# Atlas of Owner (generated ${new Date().toISOString().slice(0, 16)}Z, do not edit by hand)`, '',
      `${s.positions} positions (${s.needs_confirmation} need confirmation), ${s.people} people/orgs/projects, ${s.connections} connections, ${s.tensions} tensions, ${s.dumps} dumps, ${s.open_questions} open questions.`,
      'Confidence 0 to 1. Status: active = Owner confirmed; needs_confirmation = inferred, treat as a guess. Files: atlas/positions/<id>.md.', ''];
    const positions = this.positions();
    const budget = 7500; // characters for the per-domain lists (keeps ATLAS.md near 3,000 tokens)
    const perDomain = DOMAINS.map(d => positions.filter(p => p.domain === d)
      .sort((a, b) => (b.status === 'active') - (a.status === 'active') || (b.confidence || 0) - (a.confidence || 0)));
    const total = positions.length || 1;
    perDomain.forEach((list, i) => {
      if (!list.length) return;
      lines.push(`## ${DOMAINS[i]} (${list.length})`);
      let room = Math.max(400, Math.floor(budget * list.length / total));
      let shown = 0;
      for (const p of list) {
        const line = `- ${p.id}: ${p.statement} (${p.confidence ?? '?'}${p.status === 'active' ? ', confirmed' : ''})`;
        if (room - line.length < 0 && shown >= 3) break;
        room -= line.length; shown++;
        lines.push(line);
      }
      if (shown < list.length) lines.push(`- ... ${list.length - shown} more in atlas/positions/`);
      lines.push('');
    });
    const t = this.tensions();
    if (t.length) {
      lines.push(`## Tensions (${t.length})`);
      for (const {a, b} of t.slice(0, 15)) lines.push(`- ${a.id} <> ${b.id}`);
      lines.push('');
    }
    const people = this.people();
    if (people.length) {
      const degree = new Map();
      for (const l of this.linkPairs()) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) || 0) + 1);
      people.sort((a, b) => (a.relationship === 'self' ? -1 : 0) - (b.relationship === 'self' ? -1 : 0) || (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
      lines.push(`## People, orgs, projects (${people.length}, top 25)`);
      for (const p of people.slice(0, 25)) lines.push(`- ${p.id}: ${p.name}${p.role ? ', ' + p.role : ''} (${p.relationship || p.kind})`);
      lines.push('');
    }
    const open = this.questions('open');
    if (open.length) {
      lines.push(`## Open questions (${open.length})`);
      for (const q of open.slice(0, 12)) lines.push(`- ${q.id}: ${String(q.text).slice(0, 160)}`);
      lines.push('');
    }
    const text = lines.join('\n');
    writeFileSync(join(this.dir, 'ATLAS.md'), text);
    return text;
  }

  // One commit per change, author mastan-me. Safe to call when nothing changed. Serialised across processes
  // with run/workspace.lock (chat threads, the admin CLI inside agent turns and jobs all commit the same repo).
  commit(message) {
    const git = (...args) => execFileSync('git', ['-C', this.workspace, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    const unlock = takeLock(join(config.dataDir, 'run', 'workspace.lock'));
    try {
      for (let i = 0; i < 5; i++) {
        try {
          git('add', '-A');
          if (!git('status', '--porcelain').trim()) return false;
          git('-c', 'user.name=mastan-me', '-c', 'user.email=mastan-me@localhost', 'commit', '-q', '-m', message.slice(0, 200));
          return true;
        } catch (e) {
          if (!String(e.stderr || e.message).includes('index.lock') || i === 4) throw e;
          execFileSync('sleep', ['0.5']);
        }
      }
      return false;
    } finally { unlock?.(); }
  }
}

let shared;
export function atlas() { return shared ||= new Atlas(); }
