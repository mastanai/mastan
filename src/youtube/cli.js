// mastan-me-youtube: the agent's YouTube tool (YouTube Data API v3, read only, API key).
//   video <url|id>
//   comments <url|id> [--max N] [--order relevance|time] [--replies] [--out FILE]
//   channel <@handle|channel url|channel id> [--max N]
//   search "<query>" [--max N]        (100 units per call)
//   quota
// Output is compact JSON or short plain text. Errors are one JSON line on stderr and a non-zero exit:
// {"error":"<code>","message":"..."}. The key is never printed; see errors.js and run() below.
import {mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {YouTubeError, badInput, errorLine} from './errors.js';
import {parseVideoId, parseChannelRef} from './parse.js';
import {QuotaLedger, DAILY_CAP, TZ, riyadhDay, stateDir} from './quota.js';
import {createClient} from './client.js';
import {getVideo, fetchComments, getChannelUploads, searchVideos,
  COMMENTS_DEFAULT, COMMENTS_HARD_MAX, LIST_DEFAULT, LIST_HARD_MAX, REPLIES_PER_THREAD} from './api.js';

export const USAGE = `Usage: mastan-me-youtube <command>
  video <url|id>
      Title, channel, published, duration, views, likes, comment count, first 500 chars of the description. 1 unit.
  comments <url|id> [--max N] [--order relevance|time] [--replies] [--out FILE]
      Fetch top-level comments (default ${COMMENTS_DEFAULT}, hard max ${COMMENTS_HARD_MAX}) to a JSONL file and print a summary
      with the 10 most liked. --replies adds up to ${REPLIES_PER_THREAD} replies per thread. About 1 unit per 100 comments, plus 1.
      Default file: $MASTAN_ME_WORKSPACE/work/youtube/<videoId>-<YYYYMMDD>.jsonl
  channel <@handle|channel url|UC id> [--max N]
      Latest uploads (default ${LIST_DEFAULT}, max ${LIST_HARD_MAX}) with id, title, published. 2 units.
  search "<query>" [--max N]
      Videos matching the query (default ${LIST_DEFAULT}, max ${LIST_HARD_MAX}). COSTS 100 UNITS per call. Use sparingly.
  quota
      Units used today (Asia/Riyadh day) and the daily cap of ${DAILY_CAP}.
Video links: youtube.com/watch?v=, youtu.be/, /shorts/, /live/, /embed/, m. and music. hosts, or the 11 character id.
Errors: one JSON line on stderr, exit 1 (exit 2 for bad input). Codes: key_missing, quota_cap, quota_exceeded,
comments_disabled, not_found, bad_input, network, api_error.`;

const SPEC = {
  video: {flags: {}, args: 1},
  comments: {flags: {max: 'value', order: 'value', out: 'value', replies: 'bool'}, args: 1},
  channel: {flags: {max: 'value'}, args: 1},
  search: {flags: {max: 'value'}, args: 'rest'},
  quota: {flags: {}, args: 0},
};

function parseArgs(command, argv) {
  const spec = SPEC[command];
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = spec.flags[name];
    if (!kind) throw badInput(`Unknown option --${name} for ${command}. Run "mastan-me-youtube help".`);
    if (kind === 'bool') { opts[name] = true; continue; }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw badInput(`--${name} needs a value.`);
    opts[name] = value;
  }
  if (spec.args === 'rest') { if (!pos.length) throw badInput(`${command} needs a query.`); return {pos: [pos.join(' ')], opts}; }
  if (pos.length !== spec.args) throw badInput(spec.args ? `${command} needs exactly one ${command === 'channel' ? 'channel' : command === 'search' ? 'query' : 'video link or id'}.` : `${command} takes no arguments.`);
  return {pos, opts};
}

function limit(value, def, hard) {
  if (value === undefined) return {n: def, capped: false};
  if (!/^\d+$/.test(value) || Number(value) < 1) throw badInput('--max needs a whole number of 1 or more.');
  return Number(value) > hard ? {n: hard, capped: true} : {n: Number(value), capped: false};
}

const fmt = n => (n === null || n === undefined ? '?' : Number(n).toLocaleString('en-US'));
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
function cut(s, n) {
  const chars = Array.from(String(s ?? ''));
  return chars.length > n ? chars.slice(0, n).join('') + '...' : chars.join('');
}

export function workDir(env = process.env) {
  return env.MASTAN_ME_WORKSPACE ? join(env.MASTAN_ME_WORKSPACE, 'work', 'youtube') : join(env.MASTAN_ME_DATA || '/var/lib/mastan-me', 'work', 'youtube');
}

function writeJsonl(file, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), {mode: 0o600});
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw badInput(`Cannot write the comments file ${file} (${/^[A-Z]{3,10}$/.test(e?.code) ? e.code : 'error'}).`);
  }
}

// run(argv, io) -> exit code. io is for tests: {env, fetch, now, stdout, stderr}.
export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const now = io.now ?? (() => new Date());
  const key = String(env.YOUTUBE_API_KEY ?? '').trim();
  // Last line of defence: whatever is printed, the key is blanked out of it.
  const scrub = text => (key.length >= 8 ? text.split(key).join('[key]') : text);
  const write = (stream, fallback) => (io[stream] ?? (t => fallback.write(t)));
  const stdout = line => write('stdout', process.stdout)(scrub(line) + '\n');
  const stderr = line => write('stderr', process.stderr)(scrub(line) + '\n');

  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { stdout(USAGE); return 0; }
  let context;
  try {
    if (!SPEC[command]) throw badInput(`Unknown command "${cut(command, 40)}". Run "mastan-me-youtube help".`);
    const {pos, opts} = parseArgs(command, rest);
    const ledger = new QuotaLedger({dir: stateDir(env), now});
    const client = createClient({key, ledger, fetch: io.fetch});

    if (command === 'quota') {
      stdout(JSON.stringify({...ledger.usage(), timezone: TZ, note: 'Counts this tool only. The same API key is used by other tools, so the real Google total can be higher (Google allows 10000 a day).'}));
      return 0;
    }
    if (command === 'video') {
      const id = parseVideoId(pos[0]);
      const v = await getVideo(client, id);
      stdout(JSON.stringify({id: v.id, title: v.title, channel: v.channel, published: v.published, duration: v.duration, views: v.views, likes: v.likes,
        comments: v.comments, ...(v.comments === null ? {note: 'comment count not reported, comments may be disabled'} : {}), description: cut(v.description, 500)}));
      return 0;
    }
    if (command === 'channel') {
      const ref = parseChannelRef(pos[0]);
      const {n} = limit(opts.max, LIST_DEFAULT, LIST_HARD_MAX);
      stdout(JSON.stringify(await getChannelUploads(client, ref, n)));
      return 0;
    }
    if (command === 'search') {
      const {n} = limit(opts.max, LIST_DEFAULT, LIST_HARD_MAX);
      const query = oneLine(pos[0]);
      if (!query) throw badInput('search needs a query.');
      stdout(JSON.stringify({query, results: await searchVideos(client, query, n)}));
      return 0;
    }

    // comments
    const videoId = parseVideoId(pos[0]);
    const {n: max, capped} = limit(opts.max, COMMENTS_DEFAULT, COMMENTS_HARD_MAX);
    const order = opts.order ?? 'relevance';
    if (!['relevance', 'time'].includes(order)) throw badInput('--order must be relevance or time.');
    const file = opts.out ? resolve(opts.out) : join(workDir(env), `${videoId}-${riyadhDay(now()).replaceAll('-', '')}.jsonl`);
    const video = await getVideo(client, videoId);
    context = {video: video.title};
    const res = await fetchComments(client, {videoId, max, order, replies: Boolean(opts.replies)});
    writeJsonl(file, res.comments);
    const top = res.comments.map((c, i) => ({c, i})).sort((a, b) => b.c.likes - a.c.likes || a.i - b.i).slice(0, 10).map(x => x.c);
    const replyTexts = opts.replies ? res.comments.reduce((sum, c) => sum + c.replies.length, 0) : 0;
    stdout([
      `Video: ${video.title} (${video.id}) by ${video.channel}, published ${video.published.slice(0, 10)}`,
      `Comments: fetched ${fmt(res.comments.length)} top-level of ${fmt(video.comments)} total on the video (the total counts replies too). Order: ${order}.`
        + (res.stopped === 'max' ? ` Stopped at --max ${max}${capped ? ' (capped, the hard maximum)' : ''}.` : res.stopped === 'last_page' ? ' That is every top-level comment YouTube returned.' : ''),
      opts.replies ? `Replies: up to ${REPLIES_PER_THREAD} per thread included (${fmt(replyTexts)} reply texts saved).` : 'Replies: not requested (reply_count is in the file).',
      ...(res.stopped === 'error' ? [`PARTIAL: stopped early after ${res.pages} page${res.pages === 1 ? '' : 's'} (${res.error.code}). The file holds what was fetched.`] : []),
      `File: ${file}`,
      `Top ${top.length} by likes:`,
      ...top.map((c, i) => `${i + 1}. ${fmt(c.likes)} likes | ${oneLine(c.author)}: ${cut(oneLine(c.text), 280)}`),
    ].join('\n'));
    if (res.stopped === 'error') { stderr(errorLine(res.error, {partial: true, file})); return 1; }
    return 0;
  } catch (e) {
    const known = e instanceof YouTubeError ? e : new YouTubeError('api_error', 'Unexpected failure inside mastan-me-youtube.');
    stderr(errorLine(known, context));
    return known.code === 'bad_input' ? 2 : 1;
  }
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = await run(process.argv.slice(2));
