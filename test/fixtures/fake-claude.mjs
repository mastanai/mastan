// Fake `claude` for provider tests. Speaks the stream-json protocol the resident expects: one init event
// per process, then for every user line a text delta or two and a result. Never talks to a model.
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
// Tests read the arguments back from <MASTAN_ME_DATA>/fake-claude-argv.log (one JSON line per process).
if (process.env.MASTAN_ME_DATA) appendFileSync(`${process.env.MASTAN_ME_DATA}/fake-claude-argv.log`, JSON.stringify(process.argv.slice(2)) + '\n');
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const i = process.argv.indexOf('--resume');
const session = i > 0 ? process.argv[i + 1] : `fake-${process.pid}`;
let inited = false;
createInterface({input: process.stdin}).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const text = String(msg.message?.content || '').slice(0, 40);
  if (!inited) { inited = true; out({type: 'system', subtype: 'init', session_id: session}); }
  out({type: 'stream_event', event: {type: 'message_start'}});
  out({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'ok: '}}});
  setTimeout(() => {
    out({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text}}});
    out({type: 'result', result: `ok: ${text}`, session_id: session, usage: {}, total_cost_usd: 0});
  }, 30);
});
