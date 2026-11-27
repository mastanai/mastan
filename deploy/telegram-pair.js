// Links a new Telegram bot to its owner without any third-party bot.
// The owner sends a one-time code (shown only in the server terminal) to their own new bot;
// the sender of the first private message that is exactly the code becomes OWNER_TELEGRAM_ID.
// Usage: TG_TOKEN=... node telegram-pair.js check
//        TG_TOKEN=... TG_CODE=123456 node telegram-pair.js pair [seconds]
// Prints one line: OK <bot> | BOT <bot> | LINKED <id> <first name> | BADTOKEN | NETWORK | CONFLICT | TIMEOUT
// Run it only while the Mastan service is not polling this bot (it polls only once an owner ID is set).
const token = process.env.TG_TOKEN || '';
const code = String(process.env.TG_CODE || '');
const [mode = 'check', seconds = '600'] = process.argv.slice(2);
const base = process.env.TG_API || 'https://api.telegram.org'; // TG_API: tests only
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, body = {}) {
  const res = await fetch(`${base}/bot${token}/${method}`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000)});
  const json = await res.json().catch(() => ({}));
  if (!json.ok) { const e = new Error(json.description || `HTTP ${res.status}`); e.code = json.error_code || res.status; throw e; }
  return json.result;
}

export const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'you';

async function main() {
  let me;
  try { me = await api('getMe'); }
  catch (e) { console.log(e.code === 401 || e.code === 404 ? 'BADTOKEN' : 'NETWORK'); process.exit(3); }
  if (mode === 'check') { console.log(`OK ${me.username}`); return; }
  if (!/^\d{6}$/.test(code)) { console.log('NOCODE'); process.exit(2); }
  console.log(`BOT ${me.username}`);
  const end = Date.now() + Number(seconds) * 1000;
  let offset = 0;
  while (Date.now() < end) {
    let updates;
    try {
      const wait = Math.max(1, Math.min(25, Math.floor((end - Date.now()) / 1000)));
      updates = await api('getUpdates', {offset, timeout: wait, allowed_updates: ['message']});
    } catch (e) {
      if (e.code === 409) { console.log('CONFLICT'); process.exit(4); }
      await sleep(3000); continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m?.chat?.type !== 'private' || !m.from || String(m.text || '').trim() !== code) continue;
      await api('getUpdates', {offset, timeout: 0}).catch(() => {}); // mark the code and /start as read
      await api('sendMessage', {chat_id: m.chat.id,
        text: 'Linked. I am your Mastan, and I answer only you. If I stay quiet, finish the Claude step on your server.'}).catch(() => {});
      console.log(`LINKED ${m.from.id} ${cleanName(m.from.first_name)}`);
      return;
    }
  }
  console.log('TIMEOUT'); process.exit(5);
}

if (process.argv[1]?.endsWith('telegram-pair.js')) await main();
