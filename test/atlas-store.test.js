// Atlas store on a temp workspace: notes, rejected positions for the extractor, first-seen dates from git,
// and the cross-process commit lock. Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawn} from 'node:child_process';

const base = existsSync('/private/tmp/claude-501') ? '/private/tmp/claude-501' : tmpdir();
const data = mkdtempSync(join(base, 'mm-store-'));
process.env.MASTAN_ME_DATA = data;
const ws = join(data, 'workspace');
mkdirSync(ws, {recursive: true});
execFileSync('git', ['init', '-q', ws]);

const {Atlas, takeLock} = await import('../src/atlas/store.js');
const {rejectedLines} = await import('../src/brain/index.js');
const {buildPrompt} = await import('../src/jobs/consolidate.js');
const a = new Atlas(join(ws, 'atlas'), ws);
const pos = (id, statement, extra = {}) => a.put('positions', {id, domain: 'Work & building', statement, confidence: 0.5, since: '2026-01-01', last_confirmed: null,
  status: 'needs_confirmation', sources: [{file: 'fixture.md', date: '2026-01-01'}], links: [], tags: [], ...extra});
test.after(() => rmSync(data, {recursive: true, force: true}));

test('reject with a reason: file, body line, rejected() list, and both extractor prompts carry it', () => {
  pos('p-early-riser', 'I get up at five.');
  pos('p-reads-daily', 'I read every day.');
  a.put('people', {id: 'person-fixture-ann', kind: 'person', name: 'Ann Example', relationship: 'friend', role: '', links: []});
  a.commit('fixture');
  a.rejectPosition('p-early-riser', 'Never did. Seven at best.');
  const p = a.get('positions', 'p-early-riser');
  assert.equal(p.status, 'superseded');
  assert.equal(p.rejected_reason, 'Never did. Seven at best.');
  assert.match(p.body, /^\d{4}-\d{2}-\d{2} rejected by Owner: Never did\. Seven at best\.$/);
  assert.deepEqual(a.rejected().map(r => r.id), ['p-early-riser']);
  assert.ok(!a.positions().some(x => x.id === 'p-early-riser'), 'rejected positions leave the live list');
  assert.match(rejectedLines(a), /p-early-riser \| \d{4}-\d{2}-\d{2} \| I get up at five\. \| reason: Never did\. Seven at best\./);
  assert.match(rejectedLines(a), /Rejected by Owner \(do not create these again/);
  assert.match(buildPrompt(a, {wantQuestions: false}), /## Rejected by Owner[^\n]*\np-early-riser \| \d{4}-\d{2}-\d{2} \| I get up at five\. \| reason: Never did\. Seven at best\./);
  a.rejectPosition('p-reads-daily');
  assert.equal(a.get('positions', 'p-reads-daily').rejected_reason, undefined, 'no reason, no field');
  assert.equal(a.rejected().length, 2);
  assert.equal(a.rejected()[0].id, 'p-early-riser', 'same day: stable order by id');
});

test('notes: dated, attributed, kept to the last 60, on positions and people', () => {
  pos('p-walks', 'I walk after lunch.');
  a.addNote('positions', 'p-walks', {text: 'Only on work days.'});
  a.addNote('positions', 'p-walks', {by: 'agent', text: 'Confirmed in chat.'});
  const notes = a.get('positions', 'p-walks').notes;
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map(n => n.by), ['owner', 'agent']);
  assert.match(notes[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(readFileSync(join(ws, 'atlas/positions/p-walks.md'), 'utf8'), /notes:\n  - date: \d{4}-\d{2}-\d{2}\n    by: owner\n    text: Only on work days\./);
  a.addNote('people', 'person-fixture-ann', {text: 'Lives in Baku.'});
  assert.equal(a.get('people', 'person-fixture-ann').notes[0].text, 'Lives in Baku.');
  for (let i = 0; i < 70; i++) a.addNote('positions', 'p-walks', {text: `n${i}`});
  assert.equal(a.get('positions', 'p-walks').notes.length, 60);
  assert.throws(() => a.addNote('positions', 'p-missing', {text: 'x'}), /Not found/);
  assert.throws(() => a.addNote('dumps', 'x', {text: 'x'}), /Bad kind/);
});

test('addedAt: the date a file first entered the repo, cached per HEAD, birth time for uncommitted files', () => {
  a.commit('notes and rejects');
  const first = a.addedAt();
  assert.ok(first.get('p-early-riser'), 'committed in the fixture commit');
  assert.ok(first.get('person-fixture-ann'));
  const firstSeen = first.get('p-early-riser');
  pos('p-new-star', 'I am new here.');
  const second = a.addedAt();
  assert.equal(second.get('p-early-riser'), firstSeen, 'same HEAD: git dates come from the cache');
  assert.ok(second.get('p-new-star'), 'a file written since the last commit is dated from its birth time');
  a.commit('new star');
  const third = a.addedAt();
  assert.equal(third.get('p-early-riser'), firstSeen, 'an edit later does not move the first-seen date');
  assert.ok(third.get('p-new-star'));
  assert.ok(Date.parse(third.get('p-new-star')) >= Date.parse(firstSeen));
  pos('p-uncommitted', 'Not committed yet.');
  assert.ok(a.addedAt().get('p-uncommitted'), 'falls back to the file time');
  const g = a.graph();
  assert.ok(g.nodes.every(n => n.added));
});

test('commit lock: a live holder makes the next taker wait; a dead holder is taken over; commits serialise across processes', async () => {
  const lockPath = join(data, 'run', 'test.lock');
  const release = takeLock(lockPath);
  assert.equal(typeof release, 'function');
  const t0 = Date.now();
  assert.equal(takeLock(lockPath, 300), null, 'held by this live process: gives up after waitMs');
  assert.ok(Date.now() - t0 >= 250);
  release();
  assert.ok(!existsSync(lockPath));
  writeFileSync(lockPath, '999999999'); // a pid that is not alive
  const again = takeLock(lockPath, 300);
  assert.equal(typeof again, 'function', 'stale lock taken over');
  again();
  // two processes committing the same workspace at once: every change lands, no index.lock failure
  const script = `
    import {Atlas} from ${JSON.stringify(new URL('../src/atlas/store.js', import.meta.url).href)};
    const a = new Atlas(${JSON.stringify(join(ws, 'atlas'))}, ${JSON.stringify(ws)});
    for (let i = 0; i < 6; i++) {
      a.put('positions', {id: 'p-' + process.argv[2] + '-' + i, domain: 'Work & building', statement: 'Parallel ' + process.argv[2] + ' ' + i, confidence: 0.5, since: '2026-01-01', last_confirmed: null, status: 'needs_confirmation', sources: [], links: [], tags: []});
      a.commit('parallel ' + process.argv[2] + ' ' + i);
    }
    console.log('done');`;
  const file = join(data, 'parallel.mjs');
  writeFileSync(file, script);
  const run = tag => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file, tag], {env: {...process.env, MASTAN_ME_DATA: data}, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => { err += c; });
    p.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`${tag} exit ${code}: ${err.slice(0, 400)}`))));
  });
  await Promise.all([run('a'), run('b'), run('c')]);
  const files = execFileSync('git', ['-C', ws, 'ls-files', 'atlas/positions'], {encoding: 'utf8'}).split('\n').filter(f => /p-[abc]-\d\.md/.test(f));
  assert.equal(files.length, 18, 'every parallel write is committed');
  assert.equal(execFileSync('git', ['-C', ws, 'status', '--porcelain'], {encoding: 'utf8'}).trim(), '');
  assert.ok(!existsSync(join(data, 'run', 'workspace.lock')), 'lock released');
});
