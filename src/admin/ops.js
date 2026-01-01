// Lead's operator commands: notify, sim, status, import-atlas.
import {createHash} from 'node:crypto';
import {readFileSync, existsSync, readdirSync, cpSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {config} from '../config.js';
import {atlas, parseDoc} from '../atlas/store.js';

const internalToken = () => createHash('sha256').update(config.sessionSecret + ':internal').digest('hex');

async function internal(path, body, timeoutMs = 20 * 60_000) {
  const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: {'Content-Type': 'application/json', 'X-Internal-Token': internalToken()}, body: JSON.stringify(body)});
  if (!res.ok) throw new Error(`internal ${path}: HTTP ${res.status}`);
  return res.json();
}

export const commands = {
  schedules: {help: 'schedules [--runs <id>] : list schedules or their firing history (simulation details included)', async run(args) {
    if (args.length && (args.length !== 2 || args[0] !== '--runs' || !/^[1-9]\d*$/.test(args[1]))) throw new Error('Usage: schedules [--runs <id>]');
    const out = await internal('/internal/admin/schedules', args.length ? {runs: Number(args[1])} : {});
    console.log(JSON.stringify(out));
  }},
  'schedule-fire': {help: 'schedule-fire <id> : set the next firing to now', async run(args) {
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) throw new Error('Usage: schedule-fire <id>');
    console.log(JSON.stringify(await internal('/internal/admin/schedule-fire', {id: Number(args[0])})));
  }},
  notify: {help: 'notify <file> [--silent] : send the file text to Owner on Telegram (owner chat); --silent = no sound', async run([file, flag]) {
    if (!file) throw new Error('Usage: notify <file> [--silent]');
    // Sent by the running service, which holds the bot credential; the CLI never reads the token.
    const out = await internal('/internal/notify', {text: readFileSync(file, 'utf8'), silent: flag === '--silent'}, 60_000);
    console.log(`Sent ${out.messages} message(s).`);
  }},
  sim: {help: 'sim "<text>" [wait_s] [reply_to] [--wait-tasks] : run a fake owner Telegram message through the service, print captured replies', async run(args) {
    const waitTasks = args.includes('--wait-tasks');
    const [text, wait = waitTasks ? '3600' : '0', replyTo] = args.filter(a => a !== '--wait-tasks');
    const waitMs = Number(wait) * 1000;
    const out = await internal('/internal/telegram-sim', {text, wait_ms: waitMs, reply_to: replyTo ? Number(replyTo) : undefined, until_tasks_done: waitTasks}, Math.max(20 * 60_000, waitMs + 60_000));
    for (const c of out.calls) {
      if (c.filename) console.log(`[${c.method}] ${c.filename} (${c.mime}, ${c.size} bytes)${c.caption ? `: ${c.caption}` : ''}\n`);
      else if (c.text && c.method !== 'sendChatAction') console.log(`[${c.method}] ${String(c.text).slice(0, 1500)}\n`);
    }
    console.log(`(${out.calls.length} calls captured)`);
  }},
  'import-atlas': {help: 'import-atlas <release-dir> : merge a seed release into the workspace atlas (keeps anything Owner touched)', async run([dir]) {
    if (!dir || !existsSync(join(dir, 'atlas'))) throw new Error('Usage: import-atlas <release-dir> (containing atlas/)');
    const a = atlas();
    const counts = {added: 0, updated: 0, kept: 0};
    for (const kind of ['positions', 'people', 'questions']) {
      const src = join(dir, 'atlas', kind);
      if (!existsSync(src)) continue;
      for (const f of readdirSync(src).filter(x => x.endsWith('.md'))) {
        const {meta, body} = parseDoc(readFileSync(join(src, f), 'utf8'));
        if (!meta.id || meta.id + '.md' !== f) continue;
        const cur = a.get(kind, meta.id);
        const touched = cur && (cur.status === 'active' || cur.status === 'superseded' || cur.last_confirmed || (kind === 'questions' && cur.status !== 'open'));
        if (touched) { counts.kept++; continue; }
        a.put(kind, {...meta, body});
        counts[cur ? 'updated' : 'added']++;
      }
    }
    if (existsSync(join(dir, 'atlas', 'USER.md'))) cpSync(join(dir, 'atlas', 'USER.md'), join(config.workspace, 'USER.md'));
    a.renderAtlasMd();
    a.commit(`import seed release ${dir.split('/').filter(Boolean).at(-1)}`);
    console.log(JSON.stringify({...counts, stats: a.stats()}));
  }},
};
