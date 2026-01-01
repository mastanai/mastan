// WhatsApp channel: Owner's own number as a linked device (Baileys), allowlisted senders only, replies only.
// It never writes first: one unprompted message from a new number's linked device got prod-01 locked
// out for 6 h on 2026-10-22. Background tasks and schedules stay on Telegram and the web for now.
import {mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {config, today} from '../config.js';
import {inlineImage} from '../files.js';
import {toolLine} from './tool-line.js';

const log = (...a) => console.log('[whatsapp]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sec = ms => (ms / 1000).toFixed(1);

export const authDir = () => join(config.dataDir, 'whatsapp', 'auth');
export const digits = s => String(s || '').replace(/\D/g, '');
export const allowList = (env = process.env) => String(env.WHATSAPP_ALLOW || '').split(',').map(digits).filter(Boolean);
export const enabled = (env = process.env) => env.MASTAN_ME_WHATSAPP === 'on' && allowList(env).length > 0;
const MAX_AGE_S = 30 * 60; // older messages arrive as backlog after a reconnect; answering them late confuses more than it helps
const STOP_CODES = {401: 'logged out', 403: 'forbidden by WhatsApp', 440: 'replaced by another session', 411: 'multidevice mismatch'};

const HELP = `Mastan Me on WhatsApp.
Write anything: I answer with your memory, skills and atlas.

/new  fresh conversation
/stop  stop the running reply
Background tasks, schedules, questions and the board: Telegram or ${config.origin}`;

// Markdown from the model to WhatsApp's own marks: *bold*, _italic_, ~strike~, ```code```.
export function toWhatsApp(md) {
  return String(md)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');
}

export function chunks(text, size = 3500) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

// Wrappers WhatsApp puts around the real content (disappearing messages, view once, captioned documents).
export function unwrap(message) {
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    const inner = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage;
    if (!inner?.message) break;
    m = inner.message;
  }
  return m || {};
}

export function textOf(m) {
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption
    || m.documentMessage?.caption || '').trim();
}

const EXT = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'video/mp4': '.mp4'};
export function mediaOf(m, id) {
  for (const kind of ['imageMessage', 'documentMessage', 'audioMessage', 'videoMessage']) {
    const node = m[kind];
    if (!node) continue;
    const mime = String(node.mimetype || 'application/octet-stream').split(';')[0];
    const short = kind.replace('Message', '');
    const name = node.fileName || `${short}-${id}${EXT[mime] || ''}`;
    return {kind: short, mime, size: Number(node.fileLength || 0), name: name.replace(/[^\w.-]/g, '_')};
  }
  return null;
}

// Senders can arrive as a phone JID or as a LID (WhatsApp's private id). The allowlist is phone numbers.
export async function senderPhone(key, {lidLookup, dir = authDir()} = {}) {
  const jid = String(key.remoteJid || '');
  if (jid.endsWith('@s.whatsapp.net')) return digits(jid.split('@')[0].split(':')[0]);
  if (!/@(hosted\.)?lid$/.test(jid)) return null;
  if (String(key.remoteJidAlt || '').endsWith('@s.whatsapp.net')) return digits(key.remoteJidAlt.split('@')[0].split(':')[0]);
  const lid = jid.split('@')[0].split(':')[0];
  try {
    const mapped = JSON.parse(readFileSync(join(dir, `lid-mapping-${lid}_reverse.json`), 'utf8'));
    if (digits(mapped)) return digits(mapped);
  } catch {}
  try { const pn = await lidLookup?.getPNForLID?.(jid); if (pn) return digits(String(pn).split('@')[0].split(':')[0]); } catch {}
  return null;
}

// Baileys wants a pino-shaped logger. Only warnings and errors reach the journal, one short line each.
function quietLogger(level = 'warn') {
  const rank = {trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60};
  const make = () => {
    const l = {level, child: () => make()};
    for (const [name, r] of Object.entries(rank)) l[name] = (obj, msg) => {
      if (r < rank[level]) return;
      const text = typeof obj === 'string' ? obj : msg || obj?.msg || obj?.err?.message || '';
      if (text) log(`baileys ${name}:`, String(text).slice(0, 200));
    };
    return l;
  };
  return make();
}

export async function connectBaileys({dir, onQr, handlers}) {
  const B = await import('baileys');
  const {state, saveCreds} = await B.useMultiFileAuthState(dir);
  let version;
  try { ({version} = await B.fetchLatestBaileysVersion()); } catch {}
  const logger = quietLogger();
  const sock = B.makeWASocket({auth: {creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger)}, logger,
    ...(version ? {version} : {}), browser: B.Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false,
    printQRInTerminal: false, generateHighQualityLinkPreview: false});
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', u => { if (u.qr) onQr?.(u.qr); handlers.connection(u); });
  sock.ev.on('messages.upsert', handlers.upsert);
  return {sock, download: msg => B.downloadMediaMessage(msg, 'buffer', {}, {logger, reuploadRequest: sock.updateMediaMessage})};
}

export class WhatsAppChannel {
  constructor({agent, env = process.env, connect = connectBaileys, now = () => Date.now()}) {
    this.agent = agent;
    this.env = env;
    this.connectFn = connect;
    this.now = now;
    this.sock = null;
    this.download = null;
    this.state = 'off';
    this.problem = null;
    this.me = null;
    this.lastMessage = 0;
    this.backoff = 0;
    this.stopped = false;
    this.seen = new Set();
    this.jids = new Map(); // phone digits -> the JID to reply to
    this.queue = new Map();
  }

  status() {
    return {enabled: enabled(this.env), state: this.state, me: this.me, problem: this.problem,
      last_message_age_s: this.lastMessage ? Math.round((this.now() - this.lastMessage) / 1000) : null};
  }

  async start() {
    if (!enabled(this.env)) { log('disabled: MASTAN_ME_WHATSAPP is not on or WHATSAPP_ALLOW is empty'); return; }
    this.stopped = false;
    const dir = authDir();
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.state = 'connecting';
    try {
      const {sock, download} = await this.connectFn({dir, onQr: qr => this.onQr(qr), handlers: {
        connection: u => this.onConnection(u),
        upsert: e => this.onUpsert(e).catch(err => log('handler error:', String(err.message).slice(0, 200)))}});
      this.sock = sock; this.download = download;
    } catch (e) {
      this.state = 'error'; this.problem = 'connect failed';
      log('connect failed:', String(e.message).slice(0, 200));
      this.retry();
    }
  }

  // Pairing is a fallback (the login normally moves from another server). The QR goes to a 0600 file for qrencode.
  onQr(qr) {
    this.state = 'waiting for pairing';
    const file = join(config.dataDir, 'whatsapp', 'qr.txt');
    writeFileSync(file, qr + '\n', {mode: 0o600}); chmodSync(file, 0o600);
    log(`not paired: scan the QR in ${file} (qrencode -t ANSIUTF8 < ${file})`);
  }

  onConnection({connection, lastDisconnect}) {
    if (connection === 'open') {
      this.state = 'open'; this.problem = null; this.backoff = 0;
      this.me = digits(String(this.sock?.user?.id || '').split('@')[0].split(':')[0]) || null;
      log(`connected as +${this.me || '?'}`);
      return;
    }
    if (connection !== 'close' || this.stopped) return;
    const code = lastDisconnect?.error?.output?.statusCode;
    this.sock = null;
    if (STOP_CODES[code]) {
      this.state = 'stopped'; this.problem = STOP_CODES[code];
      log(`closed (${code}): ${STOP_CODES[code]}; not reconnecting`);
      return;
    }
    this.state = 'reconnecting';
    log(`closed (${code || 'no status'}); reconnecting`);
    this.retry(code === 515 ? 0 : undefined);
  }

  retry(delay) {
    if (this.stopped) return;
    this.backoff = delay ?? Math.min(60_000, this.backoff ? this.backoff * 2 : 2000);
    setTimeout(() => { if (!this.stopped) void this.start(); }, this.backoff + Math.random() * 500).unref();
  }

  async onUpsert({messages, type}) {
    if (type !== 'notify') return;
    for (const msg of messages || []) await this.handle(msg);
  }

  async handle(msg) {
    const key = msg?.key || {};
    const jid = String(key.remoteJid || '');
    if (!msg?.message || key.fromMe || !jid || /@(g\.us|broadcast|newsletter)$/.test(jid)) return;
    if (key.id) {
      if (this.seen.has(key.id)) return;
      this.seen.add(key.id);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    }
    const m = unwrap(msg.message);
    if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return;
    const phone = await senderPhone(key, {lidLookup: this.sock?.signalRepository?.lidMapping});
    if (!phone || !allowList(this.env).includes(phone)) { log(`message from a number not on the allowlist ignored (${phone ? '...' + phone.slice(-4) : 'unknown'})`); return; }
    const age = this.now() / 1000 - Number(msg.messageTimestamp || 0);
    if (msg.messageTimestamp && age > MAX_AGE_S) { log(`old message ignored (${Math.round(age / 60)} min)`); return; }
    this.jids.set(phone, jid);
    this.lastMessage = this.now();
    log(`message received ${Math.max(0, Math.round(age))}s after it was sent`);
    Promise.resolve(this.sock?.readMessages?.([key])).catch(() => {});
    let text = textOf(m);
    if (text.startsWith('/')) return this.command(phone, text);
    const media = mediaOf(m, key.id || this.now());
    if (media) {
      const saved = await this.saveMedia(msg, media).catch(e => { log('download failed:', String(e.message).slice(0, 120)); return null; });
      if (saved) text = `${text || 'Owner sent this file.'}\n\n[Attached: ${saved.path} (${saved.mime}, ${saved.size} bytes)]`;
      else if (!text) return this.send(phone, 'I could not download that file. Try sending it again.');
    }
    if (!text) return;
    return this.enqueue(phone, text);
  }

  async saveMedia(msg, media) {
    if (media.size > 20_000_000) throw new Error('file over 20 MB');
    const buf = await this.download(msg);
    const dir = join(config.workspace, 'inbox', today());
    mkdirSync(dir, {recursive: true});
    let path = join(dir, `wa-${media.name}`);
    for (let n = 2; existsSync(path); n++) path = join(dir, `wa-${n}-${media.name}`);
    writeFileSync(path, buf);
    return {path, mime: media.mime, size: buf.length};
  }

  async command(phone, text) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/new') { this.agent.newSession('whatsapp', phone); return this.send(phone, 'Fresh session. The atlas and memory are still here.'); }
    if (cmd === '/stop') return this.send(phone, this.agent.stop('whatsapp', phone) ? 'Stopping.' : 'Nothing is running.');
    if (cmd === '/help' || cmd === '/start') return this.send(phone, HELP);
    return this.send(phone, `That command works on Telegram or ${config.origin}. Here: /new, /stop, /help.`);
  }

  enqueue(phone, text) {
    if (this.agent.busy('whatsapp', phone) || this.queue.get(phone)?.length) {
      const q = this.queue.get(phone) || [];
      q.push(text); this.queue.set(phone, q);
      return this.send(phone, 'Got it. I will answer this after the current reply.');
    }
    return this.runTurn(phone, text);
  }

  advance(phone) {
    setImmediate(() => {
      if (this.agent.busy('whatsapp', phone)) return;
      const next = this.queue.get(phone)?.shift();
      if (next) void this.runTurn(phone, next);
    });
  }

  presence(phone, kind) {
    const jid = this.jids.get(phone);
    if (jid) Promise.resolve(this.sock?.sendPresenceUpdate?.(kind, jid)).catch(() => {});
  }

  // A reply that finishes during a reconnect waits for the socket instead of being dropped.
  async open(timeoutMs = 60_000) {
    const deadline = this.now() + timeoutMs;
    while (!(this.sock && this.state === 'open') && !this.stopped && this.now() < deadline) await sleep(500);
    return Boolean(this.sock && this.state === 'open');
  }

  // One turn: "typing" while the agent works, a short progress line every 3 minutes, then the reply.
  // No streamed edits: each WhatsApp edit is a new event on Owner's phone.
  async runTurn(phone, text) {
    const started = this.now();
    this.presence(phone, 'composing');
    const typing = setInterval(() => this.presence(phone, 'composing'), 8000);
    let status = null, nextProgress = started + 180_000;
    const progress = setInterval(() => {
      if (this.now() < nextProgress) return;
      nextProgress += 180_000;
      void this.send(phone, `Still working (${Math.round((this.now() - started) / 60_000)} min)${status ? ', ' + status.toLowerCase().replace(/\.\.\.$/, '') : ''}.`);
    }, 10_000);
    const settle = () => { clearInterval(typing); clearInterval(progress); this.presence(phone, 'paused'); };
    try {
      const result = await this.agent.turn({channel: 'whatsapp', chatId: phone, text, onTool: (name, input) => { status = toolLine(name, input); }});
      settle();
      await this.send(phone, result.text || '(no reply)');
      log(`turn done in ${sec(this.now() - started)}s (model ${sec(result.durationMs || 0)}s)`);
    } catch (e) {
      settle();
      await this.send(phone, e.code === 'ABORTED' ? 'Stopped.' : `That failed (${String(e.message).slice(0, 160)}). Try again, or /new for a fresh session.`);
      log('turn failed:', e.code || e.exitCode || 'error', `after ${sec(this.now() - started)}s`);
    } finally {
      this.advance(phone);
    }
  }

  async send(phone, text) {
    const jid = this.jids.get(phone);
    if (!jid || !await this.open()) { log('send skipped: no open chat with this number'); return []; }
    const sent = [];
    for (const part of chunks(toWhatsApp(text))) {
      const r = await this.sock.sendMessage(jid, {text: part});
      sent.push(r?.key?.id);
    }
    return sent;
  }

  // mastan-me-send for a WhatsApp chat. Only into a chat Owner has written to since the last restart.
  async sendArtifact(phone, a) {
    const jid = this.jids.get(String(phone));
    if (!jid || !await this.open()) return {status: 'failed', error: 'WhatsApp is not connected to this chat right now.'};
    const data = await readFile(a.stored_path);
    const content = inlineImage(a.mime)
      ? {image: data, mimetype: a.mime, ...(a.caption ? {caption: a.caption} : {})}
      : {document: data, mimetype: a.mime, fileName: a.name, ...(a.caption ? {caption: a.caption} : {})};
    try {
      const r = await this.sock.sendMessage(jid, content);
      return r?.key?.id ? {status: 'sent', receipt: r.key.id} : {status: 'uncertain', error: 'No receipt from WhatsApp. Do not resend.'};
    } catch { return {status: 'uncertain', error: 'WhatsApp did not confirm the file. It may have arrived. Do not resend.'}; }
  }

  shutdown() {
    this.stopped = true;
    try { this.sock?.end?.(undefined); } catch {}
    this.sock = null;
    this.state = 'off';
  }
}
