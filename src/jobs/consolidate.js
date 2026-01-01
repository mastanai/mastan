// consolidate (nightly 03:00 Riyadh, before backup):
// 1. positions marked active but not confirmed for 90 days -> needs_confirmation (no model needed)
// 2. one extractor call (strict JSON): duplicate positions to merge, up to 3 new questions, a fresh USER.md
// 3. merges: the weaker position becomes superseded (superseded_by + link), sources and links move to the kept one
// 4. new questions only when fewer than 12 are open, and only once per day
// 5. rebuild ATLAS.md, commit. Safe to run twice: every step checks the current state first.
import {mkdirSync, readFileSync, writeFileSync, existsSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {config, today} from '../config.js';
import {atlas as sharedAtlas, DOMAINS} from '../atlas/store.js';
import {kvGet, kvSet} from '../db.js';

export const STALE_DAYS = 90;
export const MAX_OPEN = 12;
const MAX_MERGES = 40;

const noDash = s => String(s ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/ ,/g, ',');
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400_000);

export function markStale(a, date = today()) {
  const out = [];
  for (const p of a.positions()) {
    if (p.status !== 'active') continue;
    const last = String(p.last_confirmed || p.since || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) continue;
    if (daysBetween(last, date) > STALE_DAYS) {
      a.setPositionStatus(p.id, 'needs_confirmation', {stale_since: date});
      out.push(p.id);
    }
  }
  return out;
}

export function buildPrompt(a, {wantQuestions}) {
  const positions = a.positions();
  const pos = positions.map(p => `${p.id} | ${p.domain} | ${p.status} | ${p.confidence ?? '?'} | ${p.last_confirmed || '-'} | ${String(p.statement).replace(/\s+/g, ' ').slice(0, 220)}`);
  const people = a.people().slice(0, 60).map(p => `${p.id} | ${p.name} | ${p.relationship || p.kind || ''} | ${String(p.role || p.context || '').slice(0, 80)}`);
  const open = a.questions('open').map(q => `${q.id} | ${q.domain} | ${String(q.text).slice(0, 200)}`);
  const answered = a.questions(['answered']).sort((x, y) => String(y.answered_at).localeCompare(String(x.answered_at))).slice(0, 25)
    .map(q => `${q.id} | Q: ${String(q.text).slice(0, 160)} | A: ${String(q.answer || '').replace(/\s+/g, ' ').slice(0, 240)}`);
  const tensions = a.tensions().slice(0, 30).map(({a: x, b: y}) => `${x.id} <> ${y.id}`);
  const rejected = a.rejected(40).map(r => `${r.id} | ${r.date} | ${String(r.statement).slice(0, 160)}${r.reason ? ` | reason: ${String(r.reason).slice(0, 160)}` : ''}`);
  const userMd = existsSync(join(a.workspace, 'USER.md')) ? readFileSync(join(a.workspace, 'USER.md'), 'utf8').slice(0, 6000) : '(none yet)';
  return `You are the nightly consolidation step of Owner's Worldview Atlas.
Do not use any tools and do not edit files. Read the data below and reply with ONE JSON object only, no prose, no code fences.

JSON shape:
{
  "merges": [{"keep": "<position id>", "drop": ["<position id>"], "why": "<one short line>"}],
  "questions": [{"domain": "<one of the domains>", "text": "<the question>", "why": "<one line>", "positions": ["<position ids it is about>"]}],
  "user_md": "<markdown, one page>"
}

Rules for merges:
- Only true duplicates: two positions that say the same thing. Not positions that are merely related, and never two sides of a tension.
- keep = the stronger one (active over needs_confirmation, higher confidence, clearer statement). At most ${MAX_MERGES} merges. Empty list if none.

Rules for questions (${wantQuestions ? 'write exactly 3' : 'write none, return an empty list'}):
- Ask like a sharp friend who has read everything: specific, quote Owner's own words from a position in "double quotes", and push on a tension, a missing number or date, or a choice he has not made.
- Example form: You said "X". You also said "Y". When they collide, which one wins, and what would make you change it?
- One question per domain at most. Do not repeat or rephrase any open or answered question listed below.
- Domains (exact strings): ${DOMAINS.join(' | ')}

Rules for user_md (rebuild USER.md):
- One page, under 700 words. Sections: Who he is; Family and people; Work and projects; How he reads; How he decides; Current priorities (with dates).
- Use confirmed positions and answered questions first; mark inferred items as (unconfirmed). Keep what is still true from the current USER.md.
- Plain words, short lines, no em dashes. No phone numbers, emails, ids, addresses, tokens. Nothing about Work-project access content.

Everywhere: no em dashes, plain English.

## Positions (id | domain | status | confidence | last_confirmed | statement)
${pos.join('\n') || '(none)'}

## People, orgs, projects (id | name | relationship | role)
${people.join('\n') || '(none)'}

## Tensions
${tensions.join('\n') || '(none)'}

## Rejected by Owner (never ask about these again or suggest them in USER.md; id | date | statement | reason)
${rejected.join('\n') || '(none)'}

## Open questions
${open.join('\n') || '(none)'}

## Recently answered questions
${answered.join('\n') || '(none)'}

## Current USER.md
${userMd}
`;
}

export function applyMerges(a, merges = []) {
  const done = [];
  for (const m of merges.slice(0, MAX_MERGES)) {
    const keep = typeof m?.keep === 'string' && a.positions().find(p => p.id === m.keep);
    if (!keep) continue;
    for (const dropId of [].concat(m.drop || [])) {
      if (typeof dropId !== 'string' || dropId === keep.id) continue;
      const drop = a.positions().find(p => p.id === dropId);
      if (!drop) continue; // missing or already superseded: nothing to do (idempotent)
      const k = a.get('positions', keep.id);
      const seen = new Set((k.sources || []).map(s => `${s.file}|${s.quote}`));
      k.sources = [...(k.sources || []), ...(drop.sources || []).filter(s => !seen.has(`${s.file}|${s.quote}`))];
      k.tags = [...new Set([...(k.tags || []), ...(drop.tags || [])])];
      const linkIds = new Set((k.links || []).map(l => l.id));
      k.links = [...(k.links || []), ...(drop.links || []).filter(l => l?.id && l.id !== k.id && !linkIds.has(l.id))];
      k.confidence = Math.max(Number(k.confidence) || 0, Number(drop.confidence) || 0);
      if (drop.since && (!k.since || String(drop.since) < String(k.since))) k.since = drop.since;
      k.merged_from = [...new Set([...(k.merged_from || []), drop.id])];
      a.put('positions', k);
      const d = a.get('positions', drop.id);
      d.status = 'superseded';
      d.superseded_by = k.id;
      d.superseded_why = noDash(m.why || 'duplicate').slice(0, 200);
      d.links = [...(d.links || []).filter(l => l.id !== k.id), {id: k.id, type: 'supports'}];
      a.put('positions', d);
      // Re-point links from other docs so connections survive the merge.
      for (const kind of ['positions', 'people']) {
        for (const doc of (kind === 'positions' ? a.positions() : a.people())) {
          if (doc.id === k.id || !(doc.links || []).some(l => l.id === drop.id)) continue;
          const full = a.get(kind, doc.id);
          const has = (full.links || []).some(l => l.id === k.id);
          full.links = (full.links || []).flatMap(l => l.id !== drop.id ? [l] : has ? [] : [{...l, id: k.id}]);
          a.put(kind, full);
        }
      }
      done.push(`${drop.id}->${k.id}`);
    }
  }
  return done;
}

export function addQuestions(a, questions = [], date = today()) {
  const existing = new Set(a.questions().map(q => norm(q.text)));
  let open = a.questions('open').length;
  const added = [];
  const usedDomains = new Set();
  for (const q of questions) {
    if (open >= MAX_OPEN || added.length >= 3) break;
    const text = noDash(q?.text).trim().slice(0, 500);
    if (text.length < 15 || existing.has(norm(text))) continue;
    const domain = DOMAINS.includes(q.domain) ? q.domain : null;
    if (!domain || usedDomains.has(domain)) continue;
    const id = a.uniqueId('questions', text.split(/\s+/).slice(0, 6).join(' '));
    a.put('questions', {id, domain, text, why: noDash(q.why).slice(0, 300), status: 'open', asked_at: date, answered_at: null, answer: null,
      positions: [].concat(q.positions || []).filter(x => typeof x === 'string' && a.get('positions', x)).slice(0, 6),
      positions_created: [], positions_changed: [], source: 'consolidate'});
    existing.add(norm(text)); usedDomains.add(domain); added.push(id); open++;
  }
  return added;
}

export function writeUserMd(workspace, md, date = today()) {
  const text = noDash(md).trim();
  if (text.length < 200) return false;
  const body = `<!-- generated by consolidate on ${date} from the atlas; edit the atlas, not this file -->\n${text.slice(0, 8000)}\n`;
  const p = join(workspace, 'USER.md');
  writeFileSync(p + '.tmp', body);
  renameSync(p + '.tmp', p);
  return true;
}

export async function run({force = false, a = sharedAtlas(), runRole, parseJson, log = () => {}} = {}) {
  const date = today();
  const parts = [];
  let status = 'ok';

  const stale = markStale(a, date);
  if (stale.length) parts.push(`${stale.length} marked needs_confirmation (90 days)`);

  const wantQuestions = a.questions('open').length < MAX_OPEN && (force || kvGet('consolidate.questions_date') !== date);
  if (!runRole || !parseJson) ({runRole, parseJson} = await import('../providers/index.js'));
  let reply = null;
  if (a.positions().length) {
    try {
      const cwd = join(config.dataDir, 'tmp', 'consolidate');
      mkdirSync(cwd, {recursive: true, mode: 0o700});
      const r = await runRole('extractor', {task: 'consolidate', prompt: buildPrompt(a, {wantQuestions}), cwd, timeoutMs: 25 * 60_000});
      reply = parseJson(r.text);
    } catch (e) {
      status = 'partial';
      parts.push(`extractor step failed: ${String(e.message || e).slice(0, 120)}`);
    }
  } else parts.push('no positions yet');

  if (reply) {
    const merged = applyMerges(a, Array.isArray(reply.merges) ? reply.merges : []);
    parts.push(`${merged.length} merged`);
    if (wantQuestions) {
      const added = addQuestions(a, Array.isArray(reply.questions) ? reply.questions : [], date);
      parts.push(`${added.length} new questions`);
      if (added.length) kvSet('consolidate.questions_date', date);
    } else parts.push('no new questions needed');
    if (writeUserMd(a.workspace, reply.user_md, date)) parts.push('USER.md rebuilt');
    else parts.push('USER.md kept (reply too short)');
  }

  a.renderAtlasMd();
  const committed = a.commit(`consolidate ${date}: ${parts.join(', ')}`);
  parts.push(committed ? 'committed' : 'nothing to commit');
  log(parts.join(', '));
  return {status, detail: parts.join(', ')};
}
