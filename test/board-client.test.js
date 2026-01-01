import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, statSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBoardClient, cleanFields} from '../src/board/client.js';
import {startMockBoard, TOKEN} from './mock-board.js';

const base = process.env.TEST_TMP || (existsSync('/private/tmp/claude-501') ? '/private/tmp/claude-501' : tmpdir());
let mock, ws, board;
before(async () => {
  mock = await startMockBoard();
  ws = mkdtempSync(join(base, 'mm-board-'));
  board = createBoardClient({workspace: ws, boardUrl: mock.url, boardToken: TOKEN});
});
after(() => mock.close());

test('no token: snapshot is unavailable and writes throw', async () => {
  const b = createBoardClient({workspace: ws, boardUrl: mock.url, boardToken: ''});
  assert.deepEqual(b.snapshot(), {items: [], synced_at: null, unavailable: 'board token not set'});
  await assert.rejects(b.add({title: 'x', area: 'Mastan'}), /read-only until the writer token is approved/);
  await assert.rejects(b.sync(), /read-only/);
});

test('no token: mirror import gives a read-only snapshot with every area', async () => {
  const dir = mkdtempSync(join(base, 'mm-board-'));
  const b = createBoardClient({workspace: dir, boardUrl: mock.url, boardToken: ''});
  const {fixture} = await import('./mock-board.js');
  const data = fixture();
  const s = b.importMirror({data, meta: {t001: {created: '2026-09-01', last_by: 'owner', last_ts: '2026-10-19T10:00:00+03:00'}}});
  assert.equal(s.source, 'mirror');
  assert.equal(s.synced_at, data.updated_at);
  assert.equal(s.items.length, 4);
  const snap = b.snapshot();
  assert.equal(snap.read_only, 'writer token not approved yet');
  assert.equal(snap.unavailable, undefined);
  assert.ok(snap.items.some(i => i.area === 'Work'), 'Work items are shown');
  assert.equal(b.get('t001').created, '2026-09-01');
  assert.equal(b.get('t001').last_by, 'owner');
  await assert.rejects(b.update('t001', {lane: 'done'}), /read-only/);
  const {run} = await import('../src/jobs/board-sync.js');
  const out = await run({board: b});
  assert.equal(out.status, 'skipped');
  assert.match(out.detail, /no token, mirror snapshot kept \(4 items/);
  assert.equal(b.snapshot().items.length, 4);
});

test('before the first sync the snapshot says so', () => {
  assert.equal(board.snapshot().unavailable, 'not synced yet');
});

test('sync caches every item, Work included, and maps legacy lanes', async () => {
  const s = await board.sync();
  assert.equal(s.hidden, undefined);
  assert.ok(s.synced_at);
  assert.deepEqual(s.items.map(i => i.id).sort(), ['t001', 't002', 't003', 't004']);
  assert.equal(s.items.find(i => i.id === 't004').lane, 'later');
  assert.equal(s.items.find(i => i.id === 't001').created, '2026-10-01');
  assert.ok(s.areas.includes('Work'));
  const cache = join(ws, 'board', 'snapshot.json');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  assert.ok(readFileSync(cache, 'utf8').includes('Fixture work item'));
  assert.equal(board.snapshot().items.length, 4);
  assert.equal(board.list({lane: 'open'}).length, 2);
  assert.equal(board.list({area: 'Work'}).map(i => i.id).join(), 't002');
  assert.equal(board.list({needsYou: true})[0].id, 't001');
  assert.equal(board.get('t002').area, 'Work');
});

test('add writes through the API as a JSON POST with the CSRF headers', async () => {
  const item = await board.add({title: 'New fixture task', area: 'Personal', lane: 'later', priority: 'low'});
  assert.equal(item.title, 'New fixture task');
  assert.equal(item.lane, 'later');
  const call = mock.calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.origin, 'https://mastan.ai');
  assert.equal(call.headers['x-board-token'], 'board');
  assert.equal(call.headers['sec-fetch-site'], undefined);
  assert.ok(board.get(item.id), 'cache refreshed after the write');
});

test('update sends the current version and refreshes the cache', async () => {
  const item = await board.update('t003', {lane: 'done', note: 'checked'});
  assert.equal(item.lane, 'done');
  assert.equal(board.get('t003').note, 'checked');
  assert.ok(JSON.parse(mock.calls.at(-1).body).version);
});

test('on 409 the client reloads and retries once', async () => {
  mock.conflict(1);
  const before = mock.calls.length;
  const item = await board.update('t001', {next: 'Water it'});
  assert.equal(item.next, 'Water it');
  const posts = mock.calls.slice(before).filter(c => c.method === 'POST');
  assert.equal(posts.length, 2);
});

test('two conflicts in a row give a clear error', async () => {
  mock.conflict(2);
  await assert.rejects(board.update('t001', {note: 'x'}), e => e.status === 409 && /changed on the board/.test(e.message));
});

test('done moves the item to done', async () => {
  const item = await board.done('t001', {note: 'Planted'});
  assert.equal(item.lane, 'done');
  assert.equal(item.needs_you, false);
});

test('Work items are written like any other area', async () => {
  const moved = await board.update('t004', {area: 'Work'});
  assert.equal(moved.area, 'Work');
  const edited = await board.update('t002', {note: 'now visible'});
  assert.equal(edited.note, 'now visible');
  assert.equal(mock.data.items.find(i => i.id === 't002').note, 'now visible');
  const added = await board.add({title: 'Work fixture add', area: 'Work'});
  assert.equal(added.area, 'Work');
  await assert.rejects(board.add({title: 'x', area: 'Nowhere'}), /area must be one of/);
});

test('field validation', () => {
  assert.throws(() => cleanFields({title: ''}, {adding: true}), /title/);
  assert.throws(() => cleanFields({title: 'a', area: 'Nowhere'}, {adding: true}), /area must be/);
  assert.throws(() => cleanFields({lane: 'someday'}), /lane must be/);
  assert.throws(() => cleanFields({bogus: 1}), /unknown field/);
  assert.throws(() => cleanFields({}), /at least one field/);
  assert.equal(cleanFields({lane: 'interest'}).lane, 'later');
});

test('only the live board URL or loopback http is allowed', async () => {
  await assert.rejects(createBoardClient({workspace: ws, boardUrl: 'https://evil.example/board/', boardToken: TOKEN}).sync(), /board URL/);
});

test('bad token gives a 401 error without the token in it', async () => {
  const b = createBoardClient({workspace: mkdtempSync(join(base, 'mm-board-')), boardUrl: mock.url, boardToken: 'W'.repeat(43)});
  await assert.rejects(b.sync(), e => e.status === 401 && !e.message.includes('W'.repeat(43)));
  assert.match(b.snapshot().last_error, /401/);
});
