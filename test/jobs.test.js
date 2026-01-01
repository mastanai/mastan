// Jobs with invented fixture data in a temp data dir. No network, no real atlas.
import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

const base = existsSync('/private/tmp/claude-501') ? '/private/tmp/claude-501' : tmpdir();
const data = mkdtempSync(join(base, 'mm-jobs-'));
process.env.MASTAN_ME_DATA = data;
process.env.MASTAN_ME_BACKUP_DIR = join(data, 'backups');
const ws = join(data, 'workspace');
mkdirSync(ws, {recursive: true});
execFileSync('git', ['init', '-q', ws]);

const {Atlas} = await import('../src/atlas/store.js');
const {today} = await import('../src/config.js');
const a = new Atlas(join(ws, 'atlas'), ws);

function pos(id, statement, extra = {}) {
  a.put('positions', {id, domain: 'Work & building', statement, confidence: 0.5, since: '2026-01-01', last_confirmed: null,
    status: 'needs_confirmation', sources: [{file: 'fixture.md', date: '2026-01-01', quote: statement.slice(0, 40)}], links: [], tags: ['t'], ...extra});
}

before(() => {
  pos('p-ship-fast', 'I ship small things fast.', {status: 'active', confidence: 0.8, last_confirmed: '2026-01-02'});
  pos('p-ship-quick', 'I like to ship quickly.');
  pos('p-plan-long', 'I plan in years, not weeks.', {links: [{id: 'p-ship-quick', type: 'tension'}]});
  pos('p-fresh', 'I read before I decide.', {status: 'active', confidence: 0.9, last_confirmed: today()});
  a.put('questions', {id: 'q-fixture-one', domain: 'Work & building', text: 'Fixture question one about pace?', status: 'open', asked_at: '2026-10-20'});
  a.commit('fixture');
});

test('consolidate: stale marking, merges, questions, USER.md; second run changes nothing new', async () => {
  const {run} = await import('../src/jobs/consolidate.js');
  let prompts = 0;
  const reply = {
    merges: [{keep: 'p-ship-fast', drop: ['p-ship-quick'], why: 'same idea'}, {keep: 'p-missing', drop: ['p-fresh']}],
    questions: [
      {domain: 'Work & building', text: 'You said "I ship small things fast". You also plan in years. Which wins?', why: 'tension', positions: ['p-ship-fast', 'p-plan-long']},
      {domain: 'Work & building', text: 'A second question in the same domain should be dropped here.', why: 'x'},
      {domain: 'Health & body', text: 'What is the one health number you would track every week?', why: 'missing number'},
      {domain: 'Nowhere', text: 'This has a bad domain and must be dropped.', why: 'x'},
    ],
    user_md: '# Owner\n\n' + 'Fixture line — with a dash.\n'.repeat(20),
  };
  const fake = async () => { prompts++; return {text: JSON.stringify(reply)}; };
  const parseJson = t => JSON.parse(t);
  const out = await run({a, runRole: fake, parseJson});
  assert.equal(out.status, 'ok', out.detail);
  assert.equal(prompts, 1);
  // 90-day rule
  assert.equal(a.get('positions', 'p-ship-fast').status, 'needs_confirmation');
  assert.equal(a.get('positions', 'p-fresh').status, 'active');
  // merge
  const dropped = a.get('positions', 'p-ship-quick');
  assert.equal(dropped.status, 'superseded');
  assert.equal(dropped.superseded_by, 'p-ship-fast');
  assert.ok(dropped.links.some(l => l.id === 'p-ship-fast'));
  assert.equal(a.get('positions', 'p-ship-fast').sources.length, 2);
  assert.ok(a.get('positions', 'p-plan-long').links.some(l => l.id === 'p-ship-fast' && l.type === 'tension'), 'links re-pointed');
  assert.equal(a.get('positions', 'p-fresh').status, 'active', 'bad merge ignored');
  // questions: one per domain, valid domains only
  const added = a.questions('open').filter(q => q.source === 'consolidate');
  assert.equal(added.length, 2);
  // USER.md, no em dashes
  const user = readFileSync(join(ws, 'USER.md'), 'utf8');
  assert.ok(!user.includes('—'));
  assert.ok(existsSync(join(ws, 'atlas', 'ATLAS.md')));
  // second run: same reply, nothing new
  const before = a.questions().length;
  const out2 = await run({a, runRole: fake, parseJson});
  assert.equal(out2.status, 'ok');
  assert.equal(a.questions().length, before, 'no new questions on the same day');
  assert.match(out2.detail, /0 merged/);
});

test('consolidate: extractor failure still rebuilds ATLAS.md and reports partial', async () => {
  const {run} = await import('../src/jobs/consolidate.js');
  const out = await run({a, runRole: async () => { throw new Error('cli down'); }, parseJson: JSON.parse});
  assert.equal(out.status, 'partial');
  assert.match(out.detail, /extractor step failed/);
});

test('morning-set sends questions once per day', async () => {
  const {run} = await import('../src/jobs/morning-set.js');
  const sent = [];
  const telegram = {enabled: () => true, sendQuestions: async (qs, {intro}) => { sent.push({qs, intro}); return qs.map((_, i) => i + 1); }};
  const out = await run({a, telegram});
  assert.equal(out.status, 'ok', out.detail);
  assert.ok(sent[0].qs.length >= 1 && sent[0].qs.length <= 5);
  const perDomain = {};
  for (const q of sent[0].qs) perDomain[q.domain] = (perDomain[q.domain] || 0) + 1;
  assert.ok(Object.values(perDomain).every(n => n <= 2));
  assert.equal(a.get('questions', sent[0].qs[0].id).times_sent, 1);
  const again = await run({a, telegram});
  assert.equal(again.status, 'skipped');
  assert.equal(sent.length, 1);
});

test('backup writes a verified bundle and a db copy, 0600, keeps 14', async () => {
  const {run, prune} = await import('../src/jobs/backup.js');
  const {openDb, kvSet} = await import('../src/db.js');
  openDb(); kvSet('fixture', 1);
  const dir = process.env.MASTAN_ME_BACKUP_DIR;
  const out = await run({now: new Date('2026-10-26T00:00:00Z')});
  assert.equal(out.status, 'ok', out.detail);
  const files = readdirSync(dir);
  const bundle = files.find(f => f.endsWith('.bundle'));
  const db = files.find(f => f.endsWith('.sqlite'));
  assert.equal(bundle, 'workspace-20261026T000000Z.bundle');
  assert.equal(statSync(join(dir, bundle)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, db)).mode & 0o777, 0o600);
  execFileSync('git', ['bundle', 'verify', '-q', join(dir, bundle)], {cwd: ws});
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `workspace-2026010${String(i).padStart(2, '0')}.bundle`), 'x');
  assert.equal(prune(dir, 'workspace-', '.bundle'), 7);
  assert.equal(readdirSync(dir).filter(f => f.endsWith('.bundle')).length, 14);
});

test('health: restarts only after two failures or a stale poll, with a 10 minute gap', async () => {
  const {check} = await import('../src/jobs/health.js');
  const state = join(data, 'health.json');
  let restarts = 0;
  const restart = () => { restarts++; };
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const fine = async () => ({ok: true, uptime_s: 50, telegram: {last_poll_age_s: 3}});
  const stale = async () => ({ok: true, uptime_s: 900, telegram: {last_poll_age_s: 400}});
  const noTg = async () => ({ok: true, uptime_s: 900, telegram: {last_poll_age_s: null}});
  let t = 1_000_000_000;
  assert.equal((await check({fetch: down, restart, state, now: t})).restarted, false);
  assert.equal((await check({fetch: down, restart, state, now: t += 300_000})).restarted, true);
  assert.equal(restarts, 1);
  assert.equal((await check({fetch: fine, restart, state, now: t += 300_000})).status, 'ok');
  const held = await check({fetch: stale, restart, state, now: t += 60_000});
  assert.match(held.detail, /held/);
  assert.equal(restarts, 1);
  assert.equal((await check({fetch: stale, restart, state, now: t += 700_000})).restarted, true);
  assert.equal(restarts, 2);
  assert.equal((await check({fetch: noTg, restart, state, now: t += 900_000})).status, 'ok');
  assert.equal(restarts, 2);
});

test('runJob records the run in job_runs', async () => {
  const {runJob} = await import('../src/jobs/run.js');
  const out = await runJob('board-sync');
  assert.equal(out.status, 'skipped'); // no board token in tests
  const {lastJobRuns} = await import('../src/db.js');
  assert.ok(lastJobRuns().some(r => r.job === 'board-sync' && r.status === 'skipped'));
  assert.ok(readFileSync(join(ws, 'jobs', 'runs.log'), 'utf8').includes('board-sync skipped'));
});
