// Preview of the chat with a fake agent and a fake gate: node test/chat-preview.mjs, then open http://127.0.0.1:3198/chat
import {mkdtempSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
const DATA = mkdtempSync(join(tmpdir(), 'mastan-me-preview-'));
process.env.MASTAN_ME_DATA = DATA; process.env.MASTAN_ME_HOSTNAME = '127.0.0.1:3198'; process.env.MASTAN_ME_RP_ID = 'localhost';
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const A = await import('../src/web/auth.js');
mkdirSync(config.workspace, {recursive: true});
const REPLY = "**prod-01 is healthy.** Disk 34%, memory fine, no failed units.\n\n1. `mastan-public` active\n2. nginx config test passes\n\nI asked to restart `mastan-web` on client-a-01. The card is above your message box.";
const agent = {
  async turn({text, onDelta, onTool}) {
    onTool('Bash', {command: 'mastan-fleet check prod-01 disk'});
    await new Promise(r => setTimeout(r, 500));
    for (let i = 20; i <= REPLY.length; i += 20) { onDelta(REPLY.slice(0, i)); await new Promise(r => setTimeout(r, 40)); }
    return {text: REPLY, durationMs: 5, sessionId: 's', model: 'fake'};
  },
  stop: () => false, newSession() {}, warm: () => false,
};
const now = Date.now();
const rows = [
  {id: 'a'.repeat(32), server: 'client-a-01', command: 'systemctl restart mastan-web', reason: 'Web unit failed 12 minutes ago', state: 'pending', exit_code: null, output: null, kind: 'command', timeout_s: 120, created: now, expires: now + 1800000},
  {id: 'b'.repeat(32), server: 'prod-01', command: 'systemctl reload nginx', reason: 'Pick up the new vhost', state: 'pending', exit_code: null, output: null, kind: 'command', timeout_s: 120, created: now, expires: now + 1800000},
];
const fleetTransport = async req => {
  if (req.op === 'pending') return {ok: true, pending: rows.filter(r => r.state === 'pending')};
  if (req.op === 'windows') return {ok: true, windows: [{server: 'mastan-server', expires: Date.now() + 720000}]};
  if (req.op === 'deny') { const r = rows.find(x => x.id === req.id); r.state = 'denied'; return {ok: true, ...r}; }
  if (req.op === 'live') return {ok: true, ...rows.find(x => x.id === req.id)};
  return {ok: true};
};
const db = openDb();
const chat = new WebChat({agent, runBusy: async () => ({text: JSON.stringify({reply: 'Queued.', queue: true})})});
const web = createWeb({config, db, atlas: null, brain: null, board: null, chat}, {fleetTransport});
A.addCredential(db, {id: 'cHJldmlldy1jcmVk', publicKey: new Uint8Array(40).fill(3), origin: 'local'});
const session = A.createSession(db, 'cHJldmlldy1jcmVk');
// __Host cookies need https, so the preview adds the session itself.
http.createServer((req, res) => {
  req.headers.cookie = `${COOKIE}=${session.value}`;
  req.headers['x-real-ip'] = '127.0.0.1';
  if (req.headers.origin) req.headers.origin = `https://${config.host}`;
  delete req.headers['sec-fetch-site'];
  web(req, res);
}).listen(3198, '127.0.0.1', () => console.log('http://127.0.0.1:3198/chat'));
