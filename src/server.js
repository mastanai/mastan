// mastan-me: HTTP on 127.0.0.1:3100 (nginx in front), Telegram long polling, brain and agent.
import {createServer} from 'node:http';
import {config, loadModels, saveModels} from './config.js';
import {openDb} from './db.js';
import {atlas} from './atlas/store.js';
import {brain} from './brain/index.js';
import {Agent} from './agent/runner.js';
import {BackgroundTasks} from './agent/tasks.js';
import {Schedules} from './agent/schedules.js';
import {MailStore} from './mail/store.js';
import {MailboxAlerts} from './jobs/mailbox-alerts.js';
import {MailboxIdle} from './jobs/mailbox-idle.js';
import {MailAlerts} from './jobs/mail-alerts.js';
import {sendToOwner} from './channels/telegram-api.js';
import {sendOwnerNotice} from './channels/canary-notice.js';
import {TelegramChannel} from './channels/telegram.js';
import {WebChat} from './channels/web-chat.js';
import {WhatsAppChannel} from './channels/whatsapp.js';
import {createInternal} from './internal.js';

const started = Date.now();
const db = openDb();
const a = atlas();
const agent = new Agent();
const tasks = new BackgroundTasks();
const schedules = new Schedules({tasks});

let board = null;
try { board = (await import('./board/client.js')).createBoardClient(config); }
catch (e) { console.log('[server] board client not loaded:', e.code || e.message.slice(0, 120)); }

const telegram = new TelegramChannel({agent, board, tasks, schedules});
const chat = new WebChat({agent, tasks, schedules});
const whatsapp = new WhatsAppChannel({agent});
tasks.web = chat;
schedules.web = chat;
await tasks.recover();
const mailAlerts = new MailAlerts({db, notify: text => sendToOwner(text)});
const mail = new MailStore({config});
// New mail goes to canary Mastan (WhatsApp) first, Telegram only when that fails. IMAP IDLE triggers a run within seconds.
const mailboxAlerts = new MailboxAlerts({db, store: mail, send: notice => sendOwnerNotice(notice, {config}), notify: text => sendToOwner(text), origin: config.origin});
const mailboxIdle = new MailboxIdle({store: mail, onMail: () => mailboxAlerts.tick()});
const ctx = {mail, mailboxAlerts, mailAlerts, notifyOwner: text => sendToOwner(text), config, db, atlas: a, brain, board, agent, telegram, chat, whatsapp, tasks, schedules, models: {load: loadModels, save: saveModels}};
const internal = createInternal(ctx);

let web = null;
try { web = (await import('./web/index.js')).createWeb(ctx); }
catch (e) { console.log('[server] web not loaded:', e.code || e.message.slice(0, 160)); }

const server = createServer(async (req, res) => {
  if (req.url === '/healthz') {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-real-ip'];
    if (!local) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true, uptime_s: Math.round((Date.now() - started) / 1000), web: Boolean(web),
      board: Boolean(board), busy_turns: agent.busyCount(), residents: agent.residents(), telegram: telegram.status(), whatsapp: whatsapp.status()}));
    return;
  }
  if (req.url.startsWith('/internal/')) {
    try { return await internal(req, res); }
    catch { if (!res.headersSent) res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: 'Internal request failed.'})); return; }
  }
  if (!web) { res.writeHead(503, {'Content-Type': 'text/plain'}).end('Starting'); return; }
  try { await web(req, res); }
  catch { if (!res.headersSent) res.writeHead(500, {'Content-Type': 'text/plain'}); res.end('Request failed'); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, '127.0.0.1', () => {
  console.log(`[server] mastan-me listening on 127.0.0.1:${config.port}`);
  schedules.start().catch(() => console.log('[schedules] startup failed'));
  if (process.env.MASTAN_ME_MAIL_ALERTS !== 'off') { mailAlerts.start(); mailboxAlerts.start(); mailboxIdle.start(); }
});

if (process.env.MASTAN_ME_TELEGRAM !== 'off') telegram.start();
void whatsapp.start();

// Owner's own chats get their resident booted ahead and re-booted after an idle exit (MASTAN_ME_WARM=off disables).
if (process.env.MASTAN_ME_WARM !== 'off') {
  const warmAll = () => {
    try {
      if (config.ownerTelegramId) agent.warm('telegram', config.ownerTelegramId);
      chat.warm('owner');
    } catch (e) { console.log('[server] warm failed:', String(e.message).slice(0, 160)); }
  };
  setTimeout(warmAll, 1500).unref();
  setInterval(warmAll, 5 * 60_000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => {
  telegram.polling = false;
  whatsapp.shutdown();
  schedules.shutdown();
  mailAlerts.shutdown();
  mailboxAlerts.shutdown();
  mailboxIdle.shutdown();
  void mail.shutdown();
  tasks.shutdown();
  agent.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
process.on('unhandledRejection', e => console.log('[server] unhandled rejection:', String(e?.message || e).slice(0, 200)));
