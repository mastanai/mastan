// mastan-me-youtube against an injected fake fetch. Invented videos, comments and key; nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {run, workDir} from '../src/youtube/cli.js';
import {parseVideoId, parseChannelRef} from '../src/youtube/parse.js';
import {QuotaLedger, riyadhDay, stateDir, DAILY_CAP} from '../src/youtube/quota.js';
import {formatDuration, decodeEntities} from '../src/youtube/api.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'AIzaSyINVENTED-key_0123456789abcdefgh';
const VID = 'dQw4w9WgXcQ';
const NOON = new Date('2026-10-31T09:00:00Z');   // 12:00 in Riyadh
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const tmp = () => mkdtempSync(join(tmpdir(), 'mm-youtube-'));

// ---- fakes ----------------------------------------------------------------------------------------------
function fakeApi(handler) {
  const calls = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    const call = {endpoint: u.pathname.split('/').pop(), params: Object.fromEntries(u.searchParams), url: String(url), opts};
    calls.push(call);
    const r = await handler(call, calls.length);
    return {ok: r.status >= 200 && r.status < 300, status: r.status, async json() { if (r.garbage) throw new SyntaxError('Unexpected token'); return r.body; }};
  };
  return {fetch, calls, of: name => calls.filter(c => c.endpoint === name)};
}
const reply = (status, body) => ({status, body});
const googleError = (status, reason, message = 'invented message') => reply(status, {error: {code: status, message, errors: [{reason, message}]}});

function videoBody({id = VID, title = 'Invented video', commentCount = 1234, description = 'About the video.', duration = 'PT12M34S'} = {}) {
  return {items: [{id, snippet: {title, channelTitle: 'Invented Channel', channelId: 'UC' + 'a'.repeat(22), publishedAt: '2026-10-01T08:30:00Z', description},
    contentDetails: {duration}, statistics: {viewCount: '123456', likeCount: '7890', ...(commentCount === null ? {} : {commentCount: String(commentCount)})}}]};
}
const thread = (i, withReplies) => ({
  id: `Ug${i}`,
  snippet: {totalReplyCount: i % 3, topLevelComment: {snippet: {authorDisplayName: `User ${i}`, textDisplay: `comment ${i}`, likeCount: (i * 7) % 50, publishedAt: '2026-10-30T10:00:00Z'}}},
  ...(withReplies ? {replies: {comments: Array.from({length: 7}, (_, r) => ({snippet: {authorDisplayName: `Replier ${r}`, textDisplay: `reply ${i}.${r}`, likeCount: r, publishedAt: '2026-10-30T11:00:00Z'}}))}} : {}),
});
// A video with `total` top-level comments served 100 at a time through pageTokens p100, p200, ...
function commentsApi(total, video = {}) {
  return fakeApi(call => {
    if (call.endpoint === 'videos') return reply(200, videoBody(video));
    if (call.endpoint === 'commentThreads') {
      const offset = call.params.pageToken ? Number(call.params.pageToken.slice(1)) : 0;
      const end = Math.min(offset + 100, total);
      const items = Array.from({length: end - offset}, (_, k) => thread(offset + k, call.params.part.includes('replies')));
      return reply(200, {items, ...(end < total ? {nextPageToken: 'p' + end} : {})});
    }
    return reply(404, {});
  });
}

function setup({fetch, env = {}, now = NOON} = {}) {
  const dir = tmp();
  const out = [], err = [];
  const e = {YOUTUBE_API_KEY: KEY, MASTAN_ME_STATE_DIR: join(dir, 'state'), MASTAN_ME_WORKSPACE: join(dir, 'ws'), ...env};
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const exec = argv => run(argv, {env: e, fetch, now: () => now, stdout: t => out.push(t), stderr: t => err.push(t)});
  return {dir, env: e, out, err, exec, text: () => out.join(''), errText: () => err.join(''), errJson: () => JSON.parse(err.join('').trim()),
    ledger: () => JSON.parse(readFileSync(join(dir, 'state', 'youtube-quota.json'), 'utf8'))};
}
const jsonl = file => readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const fileOf = text => text.match(/^File: (.+)$/m)[1];

// ---- parsing --------------------------------------------------------------------------------------------
test('video links in every supported form give the id', () => {
  for (const input of [
    VID,
    `https://www.youtube.com/watch?v=${VID}`,
    `https://youtube.com/watch?v=${VID}&t=42s&list=PLinvented`,
    `youtube.com/watch?v=${VID}`,
    `https://m.youtube.com/watch?v=${VID}`,
    `https://music.youtube.com/watch?v=${VID}&si=x`,
    `https://youtu.be/${VID}?si=abc`,
    `https://www.youtube.com/shorts/${VID}`,
    `https://www.youtube.com/live/${VID}?feature=share`,
    `https://www.youtube.com/embed/${VID}`,
    `https://www.youtube-nocookie.com/embed/${VID}`,
    `  https://youtu.be/${VID}  `,
  ]) assert.equal(parseVideoId(input), VID, input);
  assert.equal(parseVideoId('abc_DEF-123'), 'abc_DEF-123');
});

test('anything else is bad_input', () => {
  for (const input of ['', 'abc', 'abcdefghijkl', `https://example.com/watch?v=${VID}`, 'https://www.youtube.com/watch', 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@handle', `https://youtu.be/`, `javascript:alert(1)//${VID}`, `ftp://youtu.be/${VID}`, undefined]) {
    assert.throws(() => parseVideoId(input), e => e.code === 'bad_input', String(input));
  }
});

test('channels by @handle, URL and UC id', () => {
  const uc = 'UC' + 'x'.repeat(10) + 'Y_-' + '0'.repeat(9);
  assert.equal(uc.length, 24);
  assert.deepEqual(parseChannelRef('@Some.Handle_1'), {type: 'handle', value: '@Some.Handle_1'});
  assert.deepEqual(parseChannelRef('https://www.youtube.com/@Some.Handle_1'), {type: 'handle', value: '@Some.Handle_1'});
  assert.deepEqual(parseChannelRef('https://www.youtube.com/@Some.Handle_1/videos'), {type: 'handle', value: '@Some.Handle_1'});
  assert.deepEqual(parseChannelRef('youtube.com/@%C3%BCnl%C3%BC'), {type: 'handle', value: '@ünlü'});
  assert.deepEqual(parseChannelRef(uc), {type: 'id', value: uc});
  assert.deepEqual(parseChannelRef(`https://www.youtube.com/channel/${uc}`), {type: 'id', value: uc});
  assert.deepEqual(parseChannelRef(`https://m.youtube.com/channel/${uc}/videos`), {type: 'id', value: uc});
  for (const bad of ['', '@', 'plainname', 'https://www.youtube.com/c/Name', 'https://www.youtube.com/user/Name', 'https://example.com/@x', 'UCshort', 'https://www.youtube.com/channel/UCshort', '@bad name']) {
    assert.throws(() => parseChannelRef(bad), e => e.code === 'bad_input', bad);
  }
});

test('durations and entities read well', () => {
  assert.equal(formatDuration('PT12M34S'), '12:34');
  assert.equal(formatDuration('PT1H2M3S'), '1:02:03');
  assert.equal(formatDuration('PT45S'), '0:45');
  assert.equal(formatDuration('P1DT1H'), '25:00:00');
  assert.equal(formatDuration('PT0S'), '0:00');
  assert.equal(formatDuration('nonsense'), null);
  assert.equal(decodeEntities('Tom &amp; Jerry&#39;s &quot;best&quot; &#x1F600;'), 'Tom & Jerry\'s "best" \u{1F600}');
});

// ---- quota ledger ---------------------------------------------------------------------------------------
test('ledger counts units, refuses the call that would pass the cap, and leaves no temp files', () => {
  const dir = tmp();
  const ledger = new QuotaLedger({dir, now: () => NOON});
  assert.deepEqual(ledger.usage(), {day: '2026-10-31', used: 0, cap: DAILY_CAP, remaining: DAILY_CAP});
  assert.equal(existsSync(join(dir, 'youtube-quota.json')), false, 'usage() does not write');
  ledger.reserve(1);
  ledger.reserve(100);
  assert.equal(ledger.usage().used, 101);
  const file = JSON.parse(readFileSync(join(dir, 'youtube-quota.json'), 'utf8'));
  assert.equal(file['2026-10-31'].units, 101);
  assert.equal(file['2026-10-31'].requests, 2);
  assert.deepEqual(readdirSync(dir).sort(), ['youtube-quota.json'], 'no temp or lock file left behind');
  ledger.reserve(1899);                       // exactly the cap
  assert.equal(ledger.usage().remaining, 0);
  assert.throws(() => ledger.reserve(1), e => e.code === 'quota_cap' && /2000 of 2000/.test(e.message));
  assert.equal(ledger.usage().used, 2000, 'a refused call is not counted');
});

test('a search that does not fit is refused while cheap calls still fit', () => {
  const ledger = new QuotaLedger({dir: tmp(), now: () => NOON});
  ledger.reserve(1950);
  assert.throws(() => ledger.reserve(100), e => e.code === 'quota_cap');
  ledger.reserve(50);
  assert.equal(ledger.usage().used, 2000);
});

test('the day rolls over at midnight in Riyadh, not UTC', () => {
  assert.equal(riyadhDay(new Date('2026-10-31T20:59:59Z')), '2026-10-31');
  assert.equal(riyadhDay(new Date('2026-10-31T21:00:00Z')), '2026-11-01');
  let t = new Date('2026-10-31T20:59:00Z');
  const ledger = new QuotaLedger({dir: tmp(), cap: 10, now: () => t});
  ledger.reserve(10);
  assert.throws(() => ledger.reserve(1), e => e.code === 'quota_cap');
  t = new Date('2026-10-31T21:00:00Z');       // 00:00 on 1 Nov in Riyadh
  assert.deepEqual(ledger.usage(), {day: '2026-11-01', used: 0, cap: 10, remaining: 10});
  ledger.reserve(4);
  assert.equal(ledger.usage().used, 4);
  const file = JSON.parse(readFileSync(ledger.file, 'utf8'));
  assert.deepEqual(Object.keys(file), ['2026-10-31', '2026-11-01'], 'keyed by Riyadh date');
});

test('old days are pruned and a corrupt ledger fails closed', () => {
  const dir = tmp();
  const days = Object.fromEntries(Array.from({length: 20}, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, {units: 1, requests: 1}]));
  writeFileSync(join(dir, 'youtube-quota.json'), JSON.stringify(days));
  const ledger = new QuotaLedger({dir, now: () => NOON});
  ledger.reserve(1);
  assert.equal(Object.keys(JSON.parse(readFileSync(ledger.file, 'utf8'))).length, 14);
  writeFileSync(ledger.file, '{"2026-10-3');
  assert.throws(() => ledger.reserve(1), e => e.code === 'quota_cap' && /not valid JSON/.test(e.message));
  assert.throws(() => ledger.usage(), e => e.code === 'quota_cap');
});

test('a stale lock file does not block the ledger, a fresh one is waited for', () => {
  const dir = tmp();
  const ledger = new QuotaLedger({dir, now: () => NOON});
  writeFileSync(ledger.lock, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(ledger.lock, old, old);
  ledger.reserve(1);
  assert.equal(ledger.usage().used, 1);
  assert.equal(existsSync(ledger.lock), false);
});

test('state directory defaults', () => {
  assert.equal(stateDir({MASTAN_ME_STATE_DIR: '/x/state'}), '/x/state');
  assert.equal(stateDir({MASTAN_ME_DATA: '/x/data'}), '/x/data/state');
  assert.equal(stateDir({}), '/var/lib/mastan-me/state');
  assert.equal(workDir({}), '/var/lib/mastan-me/work/youtube');
  assert.equal(workDir({MASTAN_ME_DATA: '/x/data'}), '/x/data/work/youtube');
  assert.equal(workDir({MASTAN_ME_WORKSPACE: '/x/ws', MASTAN_ME_DATA: '/x/data'}), '/x/ws/work/youtube');
});

// ---- video ----------------------------------------------------------------------------------------------
test('video prints the fields, cuts the description at 500 characters and costs 1 unit', async () => {
  const api = fakeApi(() => reply(200, videoBody({description: 'd'.repeat(900)})));
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['video', `https://youtu.be/${VID}`]), 0);
  const v = JSON.parse(h.text());
  assert.deepEqual(Object.keys(v), ['id', 'title', 'channel', 'published', 'duration', 'views', 'likes', 'comments', 'description']);
  assert.equal(v.id, VID);
  assert.equal(v.title, 'Invented video');
  assert.equal(v.channel, 'Invented Channel');
  assert.equal(v.duration, '12:34');
  assert.equal(v.views, 123456);
  assert.equal(v.likes, 7890);
  assert.equal(v.comments, 1234);
  assert.equal(v.description, 'd'.repeat(500) + '...');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].endpoint, 'videos');
  assert.equal(api.calls[0].params.id, VID);
  assert.equal(h.ledger()['2026-10-31'].units, 1);
});

test('video without a comment count says so', async () => {
  const h = setup({fetch: fakeApi(() => reply(200, videoBody({commentCount: null}))).fetch});
  assert.equal(await h.exec(['video', VID]), 0);
  const v = JSON.parse(h.text());
  assert.equal(v.comments, null);
  assert.match(v.note, /may be disabled/);
});

// ---- comments: pagination -------------------------------------------------------------------------------
test('comments page through 100 at a time and stop at the last page', async () => {
  const api = commentsApi(250);
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID]), 0);      // default --max 300
  const pages = api.of('commentThreads');
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(p => p.params.pageToken), [undefined, 'p100', 'p200']);
  assert.ok(pages.every(p => p.params.maxResults === '100' && p.params.videoId === VID && p.params.order === 'relevance' && p.params.textFormat === 'plainText'));
  assert.equal(jsonl(fileOf(h.text())).length, 250);
  assert.match(h.text(), /fetched 250 top-level of 1,234 total/);
  assert.match(h.text(), /every top-level comment YouTube returned/);
  assert.equal(h.ledger()['2026-10-31'].units, 4, 'video info plus three pages');
});

test('comments stop at --max, even in the middle of a page', async () => {
  const api = commentsApi(1000);
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID, '--max', '150']), 0);
  assert.equal(api.of('commentThreads').length, 2, 'no third page');
  const rows = jsonl(fileOf(h.text()));
  assert.equal(rows.length, 150);
  assert.equal(rows[149].text, 'comment 149');
  assert.match(h.text(), /Stopped at --max 150\./);

  const api2 = commentsApi(1000);
  const h2 = setup({fetch: api2.fetch});
  await h2.exec(['comments', VID, '--max=100']);
  assert.equal(api2.of('commentThreads').length, 1, 'exactly one page for 100');
  assert.equal(jsonl(fileOf(h2.text())).length, 100);
});

test('asking for exactly what exists reads as complete, not as stopped at --max', async () => {
  const h = setup({fetch: commentsApi(100).fetch});
  await h.exec(['comments', VID, '--max', '100']);
  assert.match(h.text(), /every top-level comment YouTube returned/);
  assert.doesNotMatch(h.text(), /Stopped at/);
});

test('--max above 2000 is capped, and --order time is passed on', async () => {
  const api = commentsApi(5000);
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID, '--max', '9999', '--order', 'time']), 0);
  assert.equal(api.of('commentThreads').length, 20);
  assert.ok(api.of('commentThreads').every(p => p.params.order === 'time'));
  assert.equal(jsonl(fileOf(h.text())).length, 2000);
  assert.match(h.text(), /Stopped at --max 2000 \(capped/);
});

test('a repeated page token or an empty page ends the loop', async () => {
  let n = 0;
  const loop = fakeApi(call => call.endpoint === 'videos' ? reply(200, videoBody()) : reply(200, {items: [thread(n++)], nextPageToken: 'same'}));
  const h = setup({fetch: loop.fetch});
  assert.equal(await h.exec(['comments', VID, '--max', '500']), 0);
  assert.ok(loop.of('commentThreads').length <= 3, `stopped after ${loop.of('commentThreads').length} pages`);
  const empty = fakeApi(call => call.endpoint === 'videos' ? reply(200, videoBody()) : reply(200, {items: [], nextPageToken: 'more'}));
  const h2 = setup({fetch: empty.fetch});
  assert.equal(await h2.exec(['comments', VID]), 0);
  assert.equal(empty.of('commentThreads').length, 1);
});

test('bad --max and --order values are refused before any request', async () => {
  const api = commentsApi(10);
  for (const args of [['--max', '0'], ['--max', 'many'], ['--max', '-5'], ['--max'], ['--order', 'popular'], ['--bogus']]) {
    const h = setup({fetch: api.fetch});
    assert.equal(await h.exec(['comments', VID, ...args]), 2, args.join(' '));
    assert.equal(h.errJson().error, 'bad_input');
  }
  assert.equal(api.calls.length, 0);
});

// ---- comments: replies ----------------------------------------------------------------------------------
test('replies are requested and saved only with --replies, five per thread at most', async () => {
  const plain = commentsApi(5);
  const h1 = setup({fetch: plain.fetch});
  await h1.exec(['comments', VID]);
  assert.equal(plain.of('commentThreads')[0].params.part, 'snippet');
  const rows1 = jsonl(fileOf(h1.text()));
  assert.ok(rows1.every(r => !('replies' in r)));
  assert.ok(rows1.some(r => r.reply_count > 0), 'reply_count is always there');
  assert.match(h1.text(), /Replies: not requested/);

  const withReplies = commentsApi(5);
  const h2 = setup({fetch: withReplies.fetch});
  assert.equal(await h2.exec(['comments', VID, '--replies']), 0);
  assert.equal(withReplies.of('commentThreads')[0].params.part, 'snippet,replies');
  assert.equal(withReplies.of('commentThreads').length, 1, 'no extra calls for replies');
  const rows2 = jsonl(fileOf(h2.text()));
  assert.ok(rows2.every(r => r.replies.length === 5));
  assert.deepEqual(rows2[0].replies[0], {author: 'Replier 0', text: 'reply 0.0', likes: 0, published: '2026-10-30T11:00:00Z'});
  assert.match(h2.text(), /Replies: up to 5 per thread included \(25 reply texts saved\)/);
});

// ---- comments: files and summary ------------------------------------------------------------------------
test('JSONL fields and default path under the workspace', async () => {
  const h = setup({fetch: commentsApi(3).fetch});
  assert.equal(await h.exec(['comments', VID]), 0);
  const file = fileOf(h.text());
  assert.equal(file, join(h.dir, 'ws', 'work', 'youtube', `${VID}-20261031.jsonl`));
  const rows = jsonl(file);
  assert.deepEqual(Object.keys(rows[1]), ['id', 'author', 'text', 'likes', 'published', 'reply_count']);
  assert.deepEqual(rows[1], {id: 'Ug1', author: 'User 1', text: 'comment 1', likes: 7, published: '2026-10-30T10:00:00Z', reply_count: 1});
  assert.equal(statSync(file).mode & 0o077, 0, 'private file');
});

test('the file name uses the Riyadh date', async () => {
  const h = setup({fetch: commentsApi(1).fetch, now: new Date('2026-10-31T21:30:00Z')});
  await h.exec(['comments', VID]);
  assert.match(fileOf(h.text()), /dQw4w9WgXcQ-20261101\.jsonl$/);
});

test('without MASTAN_ME_WORKSPACE the file goes under MASTAN_ME_DATA/work/youtube', async () => {
  const dir = tmp();
  const h = setup({fetch: commentsApi(1).fetch, env: {MASTAN_ME_WORKSPACE: undefined, MASTAN_ME_DATA: dir}});
  await h.exec(['comments', VID]);
  assert.equal(fileOf(h.text()), join(dir, 'work', 'youtube', `${VID}-20261031.jsonl`));
});

test('--out writes where asked and creates the folder', async () => {
  const h = setup({fetch: commentsApi(4).fetch});
  const out = join(h.dir, 'deep', 'er', 'c.jsonl');
  assert.equal(await h.exec(['comments', VID, '--out', out]), 0);
  assert.equal(fileOf(h.text()), out);
  assert.equal(jsonl(out).length, 4);
  assert.equal(existsSync(join(h.dir, 'ws')), false, 'default folder is not created');
  assert.deepEqual(readdirSync(dirname(out)), ['c.jsonl'], 'no temp file left');
});

test('summary: title, fetched against total, path and the 10 most liked, cut at 280', async () => {
  const api = fakeApi(call => {
    if (call.endpoint === 'videos') return reply(200, videoBody({title: 'My Video', commentCount: 40}));
    const items = Array.from({length: 30}, (_, i) => thread(i));
    items[3].snippet.topLevelComment.snippet.likeCount = 900;
    items[3].snippet.topLevelComment.snippet.textDisplay = 'x'.repeat(400);
    items[9].snippet.topLevelComment.snippet.likeCount = 1500;
    items[9].snippet.topLevelComment.snippet.textDisplay = 'line one\n\nline two';
    return reply(200, {items});
  });
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID]), 0);
  const lines = h.text().split('\n');
  assert.match(lines[0], /^Video: My Video \(dQw4w9WgXcQ\) by Invented Channel, published 2026-10-01$/);
  assert.match(lines[1], /^Comments: fetched 30 top-level of 40 total on the video/);
  assert.ok(lines.some(l => l.startsWith('File: ')));
  const top = lines.slice(lines.findIndex(l => l.startsWith('Top ')) + 1).filter(Boolean);
  assert.equal(top.length, 10);
  assert.equal(top[0], '1. 1,500 likes | User 9: line one line two');
  assert.equal(top[1], `2. 900 likes | User 3: ${'x'.repeat(280)}...`);
  const likes = top.map(l => Number(l.match(/^\d+\. ([\d,]+) likes/)[1].replace(/,/g, '')));
  assert.deepEqual(likes, [...likes].sort((a, b) => b - a));
  assert.equal(jsonl(fileOf(h.text())).find(r => r.id === 'Ug3').text.length, 400, 'the file keeps full text');
});

test('a run that fails after the first page keeps the file and says PARTIAL', async () => {
  const api = fakeApi((call, n) => {
    if (call.endpoint === 'videos') return reply(200, videoBody());
    return call.params.pageToken ? googleError(500, 'backendError') : reply(200, {items: Array.from({length: 100}, (_, i) => thread(i)), nextPageToken: 'p100'});
  });
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID]), 1);
  assert.match(h.text(), /PARTIAL: stopped early after 1 page \(api_error\)/);
  assert.equal(jsonl(fileOf(h.text())).length, 100);
  const e = h.errJson();
  assert.equal(e.error, 'api_error');
  assert.equal(e.partial, true);
});

// ---- channel and search ---------------------------------------------------------------------------------
const UC = 'UC' + 'b'.repeat(22);
function channelApi() {
  return fakeApi(call => {
    if (call.endpoint === 'channels') return reply(200, {items: [{id: UC, snippet: {title: 'Invented Channel', customUrl: '@invented'}, contentDetails: {relatedPlaylists: {uploads: 'UU' + 'b'.repeat(22)}}}]});
    if (call.endpoint === 'playlistItems') return reply(200, {items: [
      {snippet: {title: 'Newest', publishedAt: '2026-10-30T00:00:00Z', resourceId: {videoId: 'aaaaaaaaaaa'}}, contentDetails: {videoId: 'aaaaaaaaaaa', videoPublishedAt: '2026-10-30T08:00:00Z'}},
      {snippet: {title: 'Private video', resourceId: {videoId: 'pppppppppp1'}}, contentDetails: {videoId: 'pppppppppp1'}},
      {snippet: {title: 'Older', publishedAt: '2026-10-20T00:00:00Z', resourceId: {videoId: 'bbbbbbbbbbb'}}, contentDetails: {videoId: 'bbbbbbbbbbb'}},
    ]});
    return reply(404, {});
  });
}

test('channel by handle: uploads playlist, 2 units, private videos left out', async () => {
  const api = channelApi();
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['channel', 'https://www.youtube.com/@invented', '--max', '3']), 0);
  assert.equal(api.calls[0].endpoint, 'channels');
  assert.equal(api.calls[0].params.forHandle, '@invented');
  assert.equal(api.calls[1].endpoint, 'playlistItems');
  assert.equal(api.calls[1].params.playlistId, 'UU' + 'b'.repeat(22));
  assert.equal(api.calls[1].params.maxResults, '3');
  const out = JSON.parse(h.text());
  assert.deepEqual(out.channel, {id: UC, title: 'Invented Channel', handle: '@invented'});
  assert.deepEqual(out.videos, [
    {id: 'aaaaaaaaaaa', title: 'Newest', published: '2026-10-30T08:00:00Z'},
    {id: 'bbbbbbbbbbb', title: 'Older', published: '2026-10-20T00:00:00Z'},
  ]);
  assert.equal(h.ledger()['2026-10-31'].units, 2);
});

test('channel by id uses the id parameter, default 10, hard max 50', async () => {
  const api = channelApi();
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['channel', UC]), 0);
  assert.equal(api.calls[0].params.id, UC);
  assert.equal(api.calls[0].params.forHandle, undefined);
  assert.equal(api.calls[1].params.maxResults, '10');
  const h2 = setup({fetch: api.fetch});
  await h2.exec(['channel', `https://www.youtube.com/channel/${UC}`, '--max', '500']);
  assert.equal(api.calls[3].params.maxResults, '50');
});

test('channel not found, either from an empty list or a 404', async () => {
  const h = setup({fetch: fakeApi(() => reply(200, {items: []})).fetch});
  assert.equal(await h.exec(['channel', '@nobody']), 1);
  assert.equal(h.errJson().error, 'not_found');
});

test('search costs 100 units, says so in help, and decodes titles', async () => {
  const api = fakeApi(() => reply(200, {items: [
    {id: {videoId: 'aaaaaaaaaaa'}, snippet: {title: 'Tom &amp; Jerry&#39;s &quot;cut&quot;', channelTitle: 'A &amp; B', publishedAt: '2026-10-01T00:00:00Z'}},
    {id: {kind: 'youtube#channel'}, snippet: {title: 'not a video'}},
  ]}));
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['search', 'ai', 'agents', '--max', '5']), 0);
  assert.equal(api.calls[0].endpoint, 'search');
  assert.equal(api.calls[0].params.q, 'ai agents');
  assert.equal(api.calls[0].params.type, 'video');
  assert.equal(api.calls[0].params.maxResults, '5');
  assert.deepEqual(JSON.parse(h.text()), {query: 'ai agents', results: [{id: 'aaaaaaaaaaa', title: 'Tom & Jerry\'s "cut"', channel: 'A & B', published: '2026-10-01T00:00:00Z'}]});
  assert.equal(h.ledger()['2026-10-31'].units, 100);
  const help = setup({});
  assert.equal(await help.exec(['help']), 0);
  assert.match(help.text(), /COSTS 100 UNITS/);
});

test('the cap stops a search before any request is made', async () => {
  const api = fakeApi(() => reply(200, {items: []}));
  const h = setup({fetch: api.fetch});
  mkdirSync(join(h.dir, 'state'), {recursive: true});
  writeFileSync(join(h.dir, 'state', 'youtube-quota.json'), JSON.stringify({'2026-10-31': {units: 1950, requests: 30}}));
  assert.equal(await h.exec(['search', 'x']), 1);
  assert.equal(h.errJson().error, 'quota_cap');
  assert.match(h.errJson().message, /1950 of 2000 units/);
  assert.equal(api.calls.length, 0);
  assert.equal(await h.exec(['video', VID]), 1, 'video fails here only because the fake has no items');
  assert.equal(api.calls.length, 1, 'a 1 unit call still fits');
});

test('quota command reads the ledger', async () => {
  const h = setup({});
  assert.equal(await h.exec(['quota']), 0);
  assert.deepEqual(JSON.parse(h.text()), {day: '2026-10-31', used: 0, cap: 2000, remaining: 2000, timezone: 'Asia/Riyadh', note: JSON.parse(h.text()).note});
  mkdirSync(join(h.dir, 'state'), {recursive: true});
  writeFileSync(join(h.dir, 'state', 'youtube-quota.json'), JSON.stringify({'2026-10-30': {units: 1999}, '2026-10-31': {units: 321}}));
  h.out.length = 0;
  await h.exec(['quota']);
  const q = JSON.parse(h.text());
  assert.equal(q.used, 321);
  assert.equal(q.remaining, 1679);
});

// ---- errors ---------------------------------------------------------------------------------------------
async function failing(argv, response, env) {
  const api = fakeApi(typeof response === 'function' ? response : () => response);
  const h = setup({fetch: api.fetch, env});
  const code = await h.exec(argv);
  return {code, h, api, err: h.errJson()};
}

test('comments disabled', async () => {
  const api = fakeApi(call => call.endpoint === 'videos' ? reply(200, videoBody({title: 'Quiet video', commentCount: null})) : googleError(403, 'commentsDisabled'));
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID]), 1);
  const e = h.errJson();
  assert.equal(e.error, 'comments_disabled');
  assert.match(e.message, /turned off/);
  assert.equal(e.video, 'Quiet video');
  assert.equal(h.text(), '', 'nothing on stdout');
  assert.equal(existsSync(join(h.dir, 'ws')), false, 'no empty file written');
});

test('Google quotaExceeded is its own code', async () => {
  const {code, err} = await failing(['video', VID], googleError(403, 'quotaExceeded'));
  assert.equal(code, 1);
  assert.equal(err.error, 'quota_exceeded');
  assert.match(err.message, /Pacific/);
});

test('not found: empty list, 404 and a notFound reason', async () => {
  for (const [argv, response] of [
    [['video', VID], reply(200, {items: []})],
    [['video', VID], googleError(404, 'videoNotFound')],
    [['comments', VID], googleError(404, 'videoNotFound')],
    [['video', VID], googleError(400, 'notFound')],
  ]) {
    const {code, err} = await failing(argv, response);
    assert.equal(code, 1);
    assert.equal(err.error, 'not_found');
  }
});

test('bad input exits 2 and never reaches the network', async () => {
  const api = fakeApi(() => reply(200, {}));
  for (const argv of [['video', 'nope'], ['video'], ['video', VID, VID], ['comments', 'https://example.com/x'], ['channel', 'plain'], ['search'], ['search', '   '], ['quota', 'extra'], ['frobnicate'], ['video', VID, '--max', '3']]) {
    const h = setup({fetch: api.fetch});
    assert.equal(await h.exec(argv), 2, argv.join(' '));
    assert.equal(h.errJson().error, 'bad_input');
  }
  assert.equal(api.calls.length, 0);
});

test('network failures: thrown fetch, timeout, unreadable reply', async () => {
  const net = setup({fetch: async () => { throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNRESET'}}); }});
  assert.equal(await net.exec(['video', VID]), 1);
  assert.equal(net.errJson().error, 'network');
  assert.match(net.errJson().message, /ECONNRESET/);
  const slow = setup({fetch: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}); }});
  assert.equal(await slow.exec(['video', VID]), 1);
  assert.match(slow.errJson().message, /timed out/);
  const junk = await failing(['video', VID], {status: 200, garbage: true});
  assert.equal(junk.err.error, 'api_error');
});

test('other API errors are api_error with the status, a bad key says so', async () => {
  let r = await failing(['video', VID], googleError(500, 'backendError'));
  assert.equal(r.err.error, 'api_error');
  assert.match(r.err.message, /HTTP 500, reason backendError/);
  r = await failing(['video', VID], reply(400, {error: {code: 400, message: 'API key not valid', errors: [{reason: 'badRequest'}], details: [{reason: 'API_KEY_INVALID'}]}}));
  assert.equal(r.err.error, 'api_error');
  assert.match(r.err.message, /rejected the key/);
  r = await failing(['video', VID], reply(429, {}));
  assert.match(r.err.message, /rate limiting/);
  r = await failing(['video', VID], googleError(403, 'forbidden'));
  assert.equal(r.err.error, 'api_error');
  assert.match(r.err.message, /HTTP 403, reason forbidden/);
});

test('no key: key_missing, before any request or ledger write', async () => {
  const api = fakeApi(() => reply(200, videoBody()));
  const h = setup({fetch: api.fetch, env: {YOUTUBE_API_KEY: undefined}});
  assert.equal(await h.exec(['video', VID]), 1);
  assert.equal(h.errJson().error, 'key_missing');
  assert.match(h.errJson().message, /youtube\.env/);
  assert.equal(api.calls.length, 0);
  assert.equal(existsSync(join(h.dir, 'state')), false);
  const blank = setup({fetch: api.fetch, env: {YOUTUBE_API_KEY: '   '}});
  assert.equal(await blank.exec(['comments', VID]), 1);
  assert.equal(blank.errJson().error, 'key_missing');
  const q = setup({fetch: api.fetch, env: {YOUTUBE_API_KEY: undefined}});
  assert.equal(await q.exec(['quota']), 0, 'quota needs no key');
});

test('errors are one line of JSON with a code from the list', async () => {
  const allowed = ['key_missing', 'quota_cap', 'quota_exceeded', 'comments_disabled', 'not_found', 'bad_input', 'network', 'api_error'];
  for (const [argv, response] of [[['video', VID], googleError(403, 'quotaExceeded')], [['video', 'x'], reply(200, {})], [['video', VID], reply(500, {})]]) {
    const {h, err} = await failing(argv, response);
    assert.equal(h.errText().trim().split('\n').length, 1);
    assert.ok(allowed.includes(err.error));
    assert.equal(typeof err.message, 'string');
  }
});

// ---- the key never leaks --------------------------------------------------------------------------------
test('the key is sent to Google but never appears in stdout, stderr, error JSON, the ledger or the comment file', async () => {
  const leaky = [
    ['video', googleError(403, 'quotaExceeded', `quota used for key ${KEY}`)],
    ['video', googleError(400, 'keyInvalid', `API key ${KEY} is not valid`)],
    ['video', reply(400, {error: {code: 400, message: `bad ${KEY}`, errors: [{reason: `reason-${KEY}`}], details: [{reason: KEY}]}})],
    ['video', reply(500, {error: {message: `https://www.googleapis.com/youtube/v3/videos?id=${VID}&key=${KEY}`}})],
    ['video', null],            // fetch throws with the URL (and key) in its message
    ['comments', null],
    ['channel', null],
    ['search', null],
  ];
  let sentKey = false;
  for (const [command, response] of leaky) {
    const api = fakeApi(call => { if (call.url.includes(`key=${KEY}`)) sentKey = true; return response; });
    const h = setup({fetch: response ? api.fetch : async url => {
      sentKey = sentKey || String(url).includes(`key=${KEY}`);
      throw Object.assign(new TypeError(`fetch failed for ${url}`), {cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), {code: 'ECONNREFUSED'})});
    }});
    const arg = command === 'channel' ? '@someone' : command === 'search' ? 'query' : VID;
    assert.notEqual(await h.exec([command, arg]), 0);
    const everything = h.text() + h.errText() + readFileSync(join(h.dir, 'state', 'youtube-quota.json'), 'utf8');
    assert.ok(!everything.includes(KEY), `${command}: key leaked`);
    assert.ok(!everything.includes('googleapis.com'), `${command}: request URL leaked`);
    assert.ok(!everything.includes('key='), `${command}: query string leaked`);
    assert.equal(h.errJson().error !== undefined, true);
  }
  assert.ok(sentKey, 'the key does go to Google in the request');
});

test('a key pasted inside a comment is blanked from the printed summary', async () => {
  const api = fakeApi(call => {
    if (call.endpoint === 'videos') return reply(200, videoBody({title: `title with ${KEY}`}));
    const items = [thread(0)];
    items[0].snippet.topLevelComment.snippet.textDisplay = `my key is ${KEY}`;
    return reply(200, {items});
  });
  const h = setup({fetch: api.fetch});
  assert.equal(await h.exec(['comments', VID]), 0);
  assert.ok(!h.text().includes(KEY));
  assert.match(h.text(), /my key is \[key\]/);
});

// ---- the real entry points ------------------------------------------------------------------------------
test('cli.js as a process: help, bad input, key_missing, quota (no network is possible without a key)', () => {
  const state = tmp();
  const env = {PATH: process.env.PATH, MASTAN_ME_STATE_DIR: state};
  const cli = join(ROOT, 'src', 'youtube', 'cli.js');
  let r = spawnSync(process.execPath, [cli, 'help'], {env, encoding: 'utf8'});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /COSTS 100 UNITS/);
  r = spawnSync(process.execPath, [cli, 'video', 'nope'], {env, encoding: 'utf8'});
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error, 'bad_input');
  r = spawnSync(process.execPath, [cli, 'comments', VID], {env, encoding: 'utf8'});
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error, 'key_missing');
  r = spawnSync(process.execPath, [cli, 'quota'], {env, encoding: 'utf8'});
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).cap, 2000);
});

test('the wrapper follows the board pattern and runs', { skip: process.getuid?.() === 0 }, () => {
  const wrapper = readFileSync(join(ROOT, 'bin', 'mastan-me-youtube'), 'utf8');
  const board = readFileSync(join(ROOT, 'bin', 'mastan-me-board'), 'utf8');
  assert.ok(statSync(join(ROOT, 'bin', 'mastan-me-youtube')).mode & 0o111, 'executable');
  assert.match(wrapper, /^#!\/bin\/sh\nset -eu\n|^#!\/bin\/sh\n(#.*\n)+set -eu\n/);
  assert.match(wrapper, /setpriv --reuid=mastan --regid=mastan --init-groups --reset-env/);
  assert.match(wrapper, /\/etc\/mastan-me\/youtube\.env/);
  assert.match(wrapper, /\[ -z "\$\{YOUTUBE_API_KEY:-\}" \]/);
  assert.match(wrapper, /src\/youtube\/cli\.js/);
  const norm = s => s.split('\n').filter(l => !l.startsWith('#')).join('\n').replaceAll('BOARD_WRITER_TOKEN', 'KEY').replaceAll('YOUTUBE_API_KEY', 'KEY').replaceAll('board.env', 'X.env').replaceAll('youtube.env', 'X.env').replaceAll('board/cli.js', 'X/cli.js').replaceAll('youtube/cli.js', 'X/cli.js');
  assert.equal(norm(wrapper), norm(board), 'same shape as mastan-me-board');
  const r = spawnSync('sh', [join(ROOT, 'bin', 'mastan-me-youtube'), 'quota'], {env: {PATH: process.env.PATH, MASTAN_ME_STATE_DIR: tmp()}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).used, 0);
});

