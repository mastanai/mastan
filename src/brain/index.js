// The brain loop: an answer or a dump goes through the extractor role, which returns JSON
// changes; we apply them to the atlas, file the conversation, rebuild ATLAS.md and commit.
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {config, today} from '../config.js';
import {atlas, DOMAINS, POSITION_LINKS} from '../atlas/store.js';
import {runRole, parseJson} from '../providers/index.js';

const MAX_OPEN_QUESTIONS = 12;
let queue = Promise.resolve();
const serial = work => (queue = queue.then(work, work));

const RULES = `Rules:
- Domains, exactly one of: ${DOMAINS.join('; ')}.
- Statements: first person, one plain sentence, how Owner would say it. No em dashes.
- Positions Owner states directly in this text: status "active", confidence 0.7 to 0.9. Inferred ones: status "needs_confirmation", confidence at most 0.6.
- Prefer updating an existing position over creating a near duplicate. Use only ids that exist in the lists given.
- Link types for positions: supports, depends, tension, about_person (person-/org-/project- ids).
- "Decisions I delegate" statements start with GREEN (act), YELLOW (act and tell) or RED (ask first).
- quote: Owner's own words from the text, 15 words max.
- followups: at most 2, Andrej Simunaj style: specific, personal, quote what Owner said, push on a tension or a missing number or date. Plain words, short.
Return ONLY one JSON object, no prose:
{"summary": "one or two short plain lines for Owner on what changed",
 "create": [{"domain": "", "statement": "", "confidence": 0.8, "status": "active", "reasoning": "", "quote": "", "links": [{"id": "", "type": "supports"}], "tags": []}],
 "update": [{"id": "", "statement": "optional", "confidence": 0.8, "status": "active|superseded|needs_confirmation", "note": "why"}],
 "people": [{"id": "person-x or org-x or project-x", "name": "", "kind": "person|org|project", "relationship": "", "role": "", "context": ""}],
 "followups": [{"domain": "", "text": "", "why": "", "positions": [""]}]}`;

// Positions Owner rejected from the web or in chat, with his reason: the extractor must not create them again.
export function rejectedLines(a, limit = 40) {
  const list = a.rejected(limit);
  if (!list.length) return '';
  return `\n\nRejected by Owner (do not create these again, in any wording; a note with the reason is in each):\n${list.map(r => `${r.id} | ${r.date} | ${r.statement}${r.reason ? ` | reason: ${r.reason}` : ''}`).join('\n')}`;
}

function catalog(a) {
  const pos = a.positions().map(p => `${p.id} | ${p.domain} | ${p.status} | ${p.confidence} | ${p.statement}`).join('\n');
  const people = a.people().map(p => `${p.id} | ${p.name} | ${p.relationship || p.kind}`).join('\n');
  return `Existing positions (id | domain | status | confidence | statement):\n${pos}\n\nExisting people/orgs/projects:\n${people}${rejectedLines(a)}`;
}

function userMd() {
  const p = join(config.workspace, 'USER.md');
  return existsSync(p) ? readFileSync(p, 'utf8').slice(0, 6000) : '';
}

async function extract(task, prompt) {
  const result = await runRole('extractor', {task, prompt, cwd: config.workspace, timeoutMs: 10 * 60_000});
  return parseJson(result.text);
}

function apply(a, changes, source) {
  const date = today();
  const exists = id => a.get('positions', id) || a.people().some(p => p.id === id);
  const created = [], changed = [], followups = [], people = [];
  for (const person of changes.people || []) {
    if (!person?.id || !/^(person|org|project)-[a-z0-9-]+$/.test(person.id) || a.people().some(p => p.id === person.id)) continue;
    a.put('people', {id: person.id, kind: person.kind || 'person', name: person.name, relationship: person.relationship || 'other',
      role: person.role || '', context: person.context || '', since: date, status: 'needs_confirmation',
      sources: [{file: source.file, date}], links: [{id: 'person-owner', type: 'related'}], tags: []});
    people.push(person.id);
  }
  const reverse = [];
  for (const c of changes.create || []) {
    if (!c?.statement || !DOMAINS.includes(c.domain)) continue;
    const active = c.status === 'active';
    const id = a.uniqueId('positions', c.statement.replace(/^(I|I'm|I am|My|We)\s+/i, '').split(/\s+/).slice(0, 7).join(' '));
    const links = (c.links || []).filter(l => l?.id && POSITION_LINKS.includes(l.type) && exists(l.id));
    a.put('positions', {id, domain: c.domain, statement: c.statement,
      confidence: Math.min(active ? 0.95 : 0.6, Number(c.confidence) || 0.5), since: date,
      last_confirmed: active ? date : null, status: active ? 'active' : 'needs_confirmation',
      sources: [{file: source.file, date, quote: String(c.quote || '').split(/\s+/).slice(0, 15).join(' ')}],
      links, tags: Array.isArray(c.tags) ? c.tags : [], body: c.reasoning || ''});
    for (const l of links) if (l.type === 'tension') reverse.push([l.id, id]);
    created.push(id);
  }
  for (const u of changes.update || []) {
    const p = u?.id && a.get('positions', u.id);
    if (!p) continue;
    if (u.statement) p.statement = u.statement;
    if (u.confidence !== undefined) p.confidence = Math.max(0, Math.min(1, Number(u.confidence)));
    if (['active', 'superseded', 'needs_confirmation'].includes(u.status)) p.status = u.status;
    if (p.status === 'active') p.last_confirmed = date;
    p.sources = [...(p.sources || []), {file: source.file, date}];
    if (u.note) p.body = `${p.body || ''}\n\n${date}: ${u.note}`.trim();
    a.put('positions', p);
    changed.push(u.id);
  }
  for (const [onId, otherId] of reverse) {
    const p = a.get('positions', onId);
    if (p && !(p.links || []).some(l => l.id === otherId)) { p.links = [...(p.links || []), {id: otherId, type: 'tension'}]; a.put('positions', p); }
  }
  let open = a.questions('open').length;
  for (const f of changes.followups || []) {
    if (open >= MAX_OPEN_QUESTIONS || !f?.text) break;
    const id = a.uniqueId('questions', f.text.split(/\s+/).slice(0, 6).join(' '));
    a.put('questions', {id, domain: DOMAINS.includes(f.domain) ? f.domain : 'Self & psychology', text: f.text, why: f.why || '',
      status: 'open', asked_at: date, answered_at: null, answer: null,
      positions: (f.positions || []).filter(x => a.get('positions', x)), positions_created: [], positions_changed: [], source: source.file});
    followups.push(id); open++;
  }
  return {summary: String(changes.summary || '').slice(0, 600), created, changed, followups, people};
}

function diffLines(a, result) {
  const line = id => { const p = a.get('positions', id); return p ? `- ${id}: ${p.statement} (${p.confidence}, ${p.status})` : `- ${id}`; };
  return [`### Changes`, `Summary: ${result.summary}`, '',
    result.created.length ? `Created:\n${result.created.map(line).join('\n')}` : 'Created: none',
    result.changed.length ? `Changed:\n${result.changed.map(line).join('\n')}` : 'Changed: none',
    result.followups.length ? `Follow-up questions: ${result.followups.join(', ')}` : 'Follow-up questions: none',
    result.people.length ? `New people: ${result.people.join(', ')}` : ''].filter(Boolean).join('\n');
}

export const brain = {
  // Marks the question answered right away (sync), then processes in the background.
  answer(questionId, text, channel = 'web') {
    const a = atlas();
    const q = a.get('questions', questionId);
    if (!q) throw Object.assign(new Error('Question not found'), {status: 404});
    if (!String(text).trim()) throw Object.assign(new Error('Empty answer'), {status: 400});
    a.setQuestionStatus(questionId, 'answered', String(text).trim());
    const conv = a.newConversation(`Answer: ${questionId}`, {question: questionId, channel});
    a.appendConversation(conv, `## Question (${q.domain})\n\n${q.text}\n\n## Owner's answer (${channel})\n\n${String(text).trim()}\n`);
    a.commit(`answer ${questionId}`);
    const promise = serial(async () => {
      const related = (q.positions || []).map(id => a.get('positions', id)).filter(Boolean)
        .map(p => `${p.id}: ${p.statement}\n${p.body || ''}`).join('\n\n');
      const prompt = `You maintain Owner's Worldview Atlas. Owner just answered one of its questions. Update the atlas.

Question (${q.domain}): ${q.text}
Why it was asked: ${q.why || ''}
Positions it was about:
${related || '(none listed)'}

Owner's answer:
"""
${String(text).trim()}
"""

${catalog(a)}

About Owner (USER.md excerpt):
${userMd()}

Positions this answer confirms should be updated to status "active" with the confidence Owner's words support. Positions it contradicts: lower confidence or mark "superseded" and create the corrected one.
${RULES}`;
      let result;
      try {
        result = apply(a, await extract(`answer:${questionId}`, prompt), {file: `conversations/${conv}.md`});
      } catch (e) {
        a.appendConversation(conv, `### Brain\n\nCould not process this answer automatically (${e.message.slice(0, 120)}). It is saved; the nightly job will retry.`);
        const qq = a.get('questions', questionId); qq.needs_processing = true; a.put('questions', qq);
        a.commit(`answer ${questionId}: brain failed`);
        throw e;
      }
      const qq = a.get('questions', questionId);
      Object.assign(qq, {positions_created: result.created, positions_changed: result.changed, needs_processing: false});
      a.put('questions', qq);
      a.appendConversation(conv, diffLines(a, result));
      a.renderAtlasMd();
      a.commit(`brain: answer ${questionId} (+${result.created.length} ~${result.changed.length} q${result.followups.length})`);
      return result;
    });
    promise.catch(() => {});
    return promise;
  },

  // Files the dump right away, then lets the brain make something of it.
  dump(text, channel = 'web') {
    const a = atlas();
    if (!String(text).trim()) throw Object.assign(new Error('Empty dump'), {status: 400});
    const {id} = a.addDump(String(text), channel);
    a.commit(`dump ${id}`);
    const promise = serial(async () => {
      const prompt = `You maintain Owner's Worldview Atlas. Owner dropped a raw idea or note (a "dump"). File what it says about how he thinks: new or updated positions, people, and at most one follow-up question if something is unclear. If it is just a task or a reminder, create nothing and say so in the summary.

Dump:
"""
${String(text).trim()}
"""

${catalog(a)}
${RULES}`;
      try {
        const result = apply(a, await extract(`dump:${id}`, prompt), {file: `dumps/${id}.md`});
        a.updateDump(id, {status: 'filed', positions_created: result.created, positions_changed: result.changed}, `## What I made of it\n\n${diffLines(a, result)}`);
        a.renderAtlasMd();
        a.commit(`brain: dump ${id} (+${result.created.length} ~${result.changed.length})`);
        return {id, ...result};
      } catch (e) {
        a.updateDump(id, {status: 'needs_processing'});
        a.commit(`dump ${id}: brain failed`);
        throw e;
      }
    });
    promise.catch(() => {});
    return Object.assign(promise, {dumpId: id});
  },
};
