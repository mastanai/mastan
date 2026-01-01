// mastan-me-board: the agent's board tool. Reads the cache, writes to the board API as mastan-me.
//   list [--lane L] [--area A] [--needs-you] [--json] [--fresh]
//   show <id> [--json]
//   add --title T --area A [--lane L] [--priority P] [--note N] [--next X] [--needs-you]
//   update <id> [--title T] [--area A] [--lane L] [--priority P|none] [--note N] [--next X] [--needs-you yes|no]
//   done <id> [--note N]
//   sync
import {config} from '../config.js';
import {createBoardClient, LANE_NAMES, AREAS, LANES} from './client.js';

const USAGE = `Usage: mastan-me-board <command>
  list [--lane open|in_progress|later|done] [--area A] [--needs-you] [--json] [--fresh]
  show <id> [--json]
  add --title "T" --area A [--lane L] [--priority high|medium|low] [--note "N"] [--next "X"] [--needs-you]
  update <id> [--title "T"] [--area A] [--lane L] [--priority P|none] [--note "N"] [--next "X"] [--needs-you yes|no]
  done <id> [--note "N"]
  sync
  import-mirror < mirror.json   (read-only snapshot from Owner's Mac, see bin/push-board-mirror)
Areas: ${AREAS.join(', ')}. Lanes: ${LANES.join(', ')}.`;

function parse(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (['json', 'fresh'].includes(key)) { opts[key] = true; continue; }
    if (key === 'needs-you' && (argv[i + 1] === undefined || argv[i + 1].startsWith('--') || !['yes', 'no'].includes(argv[i + 1]))) { opts.needs_you = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    opts[key.replace(/-/g, '_')] = key === 'needs-you' ? val === 'yes' : val;
  }
  return {pos, opts};
}

function line(i) {
  const flags = [i.priority ? `[${i.priority}]` : '', i.needs_you ? '[needs you]' : ''].filter(Boolean).join(' ');
  return `${i.id}  ${i.lane}  ${i.area}${flags ? '  ' + flags : ''}  ${String(i.title).replace(/\s+/g, ' ')}`;
}

function detail(i) {
  return [`${i.id}: ${i.title}`, `Area: ${i.area}. Lane: ${LANE_NAMES[i.lane] || i.lane}.${i.priority ? ` Priority: ${i.priority}.` : ''}${i.needs_you ? ' Needs Owner.' : ''}`,
    i.note ? `Note: ${i.note}` : '', i.next ? `Next: ${i.next}` : '',
    `Updated ${i.updated || '?'}${i.last_by ? ` by ${i.last_by}` : ''}${i.created ? `, added ${i.created}` : ''}.`].filter(Boolean).join('\n');
}

const fields = o => {
  const out = {};
  for (const k of ['title', 'area', 'lane', 'priority', 'note', 'next', 'needs_you']) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const {pos, opts} = parse(rest);
  const board = createBoardClient(config);
  switch (cmd) {
    case 'import-mirror': {
      // stdin: {data: {schema, updated_at, updated_by, items}, meta: {id: {created, last_by, last_ts}}}
      const parts = []; let size = 0;
      for await (const c of process.stdin) { size += c.length; if (size > 4_000_000) throw new Error('mirror input too large'); parts.push(c); }
      const s = board.importMirror(JSON.parse(Buffer.concat(parts).toString('utf8')));
      console.log(`Imported ${s.items.length} items from the mirror, mirror updated ${s.synced_at}. Read only.`);
      return;
    }
    case 'sync': {
      const s = await board.sync();
      console.log(`Synced ${s.items.length} items at ${s.synced_at}.`);
      return;
    }
    case 'list': {
      if (opts.fresh) await board.sync();
      const snap = board.snapshot();
      if (snap.unavailable) throw new Error(`Board unavailable: ${snap.unavailable}`);
      if (snap.read_only && !opts.json) console.log(`(read only: ${snap.read_only}; copy of the board from ${snap.synced_at})`);
      const items = board.list({lane: opts.lane, area: opts.area, needsYou: opts.needs_you ? true : undefined});
      if (opts.json) { console.log(JSON.stringify(items, null, 2)); return; }
      for (const i of items) console.log(line(i));
      console.log(`(${items.length} items, ${snap.source === 'mirror' ? 'mirror from' : 'synced'} ${snap.synced_at}${snap.last_error ? `, last sync error: ${snap.last_error}` : ''})`);
      return;
    }
    case 'show': {
      if (!pos[0]) throw new Error('show needs an id');
      if (opts.fresh) await board.sync();
      const i = board.get(pos[0]);
      if (!i) throw new Error(`unknown item: ${pos[0]} (run "mastan-me-board sync" if it is new)`);
      console.log(opts.json ? JSON.stringify(i, null, 2) : detail(i));
      return;
    }
    case 'add': {
      const i = await board.add(fields(opts));
      console.log(`Added ${i.id}: lane=${i.lane}`);
      return;
    }
    case 'update': {
      if (!pos[0]) throw new Error('update needs an id');
      const i = await board.update(pos[0], fields(opts));
      console.log(`Updated ${i.id}: lane=${i.lane}`);
      return;
    }
    case 'done': {
      if (!pos[0]) throw new Error('done needs an id');
      const i = await board.done(pos[0], {note: opts.note});
      console.log(`Done ${i.id}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exitCode = 2; });
