// Minimal Telegram Bot API client. The token is read from (in order): TELEGRAM_BOT_TOKEN,
// the systemd credential "telegram" (LoadCredential, see the unit), or TELEGRAM_TOKEN_FILE.
import {readFileSync, existsSync, createReadStream} from 'node:fs';
import {join} from 'node:path';
import https from 'node:https';
import {config} from '../config.js';
import {openDb} from '../db.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const log = (...a) => console.log('[telegram]', ...a);

// Two keep-alive agents: the getUpdates long poll (up to 25 s per cycle) gets a socket of its own, so a
// typing signal or a reply never queues behind it. With one shared connection every send waited for the
// poll to return, which showed as 20 to 25 s of nothing before any message appeared.
const agents = {
  poll: new https.Agent({keepAlive: true, maxSockets: 1, timeout: 90_000}),
  send: new https.Agent({keepAlive: true, maxSockets: 6, timeout: 90_000}),
};
const SLOW_MS = 1500;

// Simulation for operator tests: inside simulate(), calls are captured instead of sent.
export const sim = new AsyncLocalStorage();
let simId = 1_000_000;

let cached;
export function token() {
  if (cached !== undefined) return cached;
  let t = config.telegramToken;
  const cred = process.env.CREDENTIALS_DIRECTORY && join(process.env.CREDENTIALS_DIRECTORY, 'telegram');
  if (!t && cred && existsSync(cred)) t = readFileSync(cred, 'utf8').trim();
  if (!t && process.env.TELEGRAM_TOKEN_FILE && existsSync(process.env.TELEGRAM_TOKEN_FILE)) t = readFileSync(process.env.TELEGRAM_TOKEN_FILE, 'utf8').trim();
  return (cached = t || '');
}
export const enabled = () => Boolean(token() && config.ownerTelegramId);

export async function call(method, params = {}, {timeoutMs = 30_000, signal} = {}) {
  const store = sim.getStore();
  if (store) {
    store.calls.push({method, text: params.text, reply_markup: params.reply_markup ? true : undefined,
      ...(params.disable_notification !== undefined ? {disable_notification: params.disable_notification} : {})});
    if (method === 'getFile') throw new Error('not in simulation');
    return {message_id: ++simId, chat: {id: params.chat_id}};
  }
  const t = token();
  if (!t) throw new Error('Telegram token not set');
  const started = Date.now();
  const data = await viaHttps(t, method, params, {timeoutMs, signal});
  const took = Date.now() - started;
  if (method !== 'getUpdates' && took > SLOW_MS) log(`${method} took ${took} ms`);
  if (!data.ok) throw Object.assign(new Error(`Telegram ${method}: ${data.description || data.status}`), {status: data.error_code || data.status, retryAfter: data.parameters?.retry_after});
  return data.result;
}

// JSON calls over node:https with the agent split above. Errors never carry the URL (and so never the token).
export function viaHttps(t, method, params, {timeoutMs, signal, request = https.request}) {
  const body = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, {once: true});
    let settled = false, written = false, req;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value); };
    const error = e => done(reject, Object.assign(cleanError(e), {bodyWritten: written || !!req?.writableFinished}));
    try {
      req = request({host: 'api.telegram.org', path: `/bot${t}/${method}`, method: 'POST', signal: ctl.signal,
        agent: agents[method === 'getUpdates' ? 'poll' : 'send'],
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('error', error);
        res.on('aborted', () => error(new Error('Response interrupted')));
        res.on('end', () => {
          let json;
          try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return error(new Error('Invalid Telegram response')); }
          if (!json || typeof json.ok !== 'boolean') return error(new Error('Invalid Telegram response'));
          done(resolve, {...json, status: res.statusCode});
        });
      });
      req.on('finish', () => { written = true; });
      req.on('error', error);
      req.on('close', () => { if (!settled) error(new Error('Telegram connection closed')); });
      req.end(body);
    } catch (e) { error(e); }
  });
}

export function cleanError(e) {
  const err = new Error(e?.name === 'AbortError' ? 'aborted' : String(e?.code || e?.message || 'request failed')
    .replace(/https?:\/\/\S+/g, '<url>').replace(/bot\d+:[\w-]+/g, 'bot<token>').slice(0, 300));
  err.code = e?.code || e?.name;
  return err;
}

// Stream the stored copy over a send socket. A lost response after finish is ambiguous, never retried.
export function multipart(t, method, fields, file, {timeoutMs, request = https.request} = {}) {
  const boundary = `mastan-${randomBytes(18).toString('hex')}`;
  const prefix = Buffer.from(Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="${method === 'sendPhoto' ? 'photo' : 'document'}"; filename="${file.name.replace(/["\\\r\n]/g, '_')}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    let settled = false, written = false, req;
    const ctl = new AbortController();
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const error = e => done(reject, Object.assign(cleanError(e), {bodyWritten: written || !!req?.writableFinished}));
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? 60_000 + Math.ceil(file.size / 1048576) * 5000);
    try {
      req = request({host: 'api.telegram.org', path: `/bot${t}/${method}`, method: 'POST', agent: agents.send, signal: ctl.signal,
        headers: {'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': prefix.length + file.size + suffix.length}}, res => {
        const parts = []; let bytes = 0;
        res.on('data', c => { bytes += c.length; if (bytes > 1024 * 1024) req.destroy(new Error('Response too large')); else parts.push(c); });
        res.on('error', error);
        res.on('aborted', () => error(new Error('Response interrupted')));
        res.on('end', () => {
          let data;
          try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return error(new Error('Invalid Telegram response')); }
          if (!data || typeof data.ok !== 'boolean') return error(new Error('Invalid Telegram response'));
          done(resolve, data);
        });
      });
      req.on('finish', () => { written = true; });
      req.on('error', error);
      req.on('close', () => { if (!settled) error(new Error('Telegram connection closed')); });
      const body = Readable.from((async function* () {
        yield prefix;
        yield* createReadStream(file.stored_path);
        yield suffix;
      })());
      pipeline(body, req).catch(error);
    } catch (e) { error(e); }
  });
}

export async function sendFile(chatId, file, {simulation = sim.getStore(), request} = {}) {
  const method = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mime) && file.size <= 10 * 1024 * 1024 ? 'sendPhoto' : 'sendDocument';
  if (simulation) {
    simulation.calls.push({method, filename: file.name, mime: file.mime, size: file.size, caption: file.caption});
    return {status: 'sent', receipt: ++simId};
  }
  if (!token()) return {status: 'failed', error: 'Telegram token not set'};
  const fields = {chat_id: chatId, ...(file.caption ? {caption: toHtml(file.caption), parse_mode: 'HTML'} : {})};
  try {
    let data = await multipart(token(), method, fields, file, {request});
    if (!data.ok && data.error_code === 400 && fields.parse_mode) {
      delete fields.parse_mode; fields.caption = file.caption;
      data = await multipart(token(), method, fields, file, {request});
    }
    if (!data.ok) return {status: 'failed', error: cleanError(new Error(data.description || `Telegram error ${data.error_code || 'unknown'}`)).message};
    if (data.result?.message_id == null) return {status: 'uncertain', error: 'Telegram returned no message id'};
    return {status: 'sent', receipt: data.result.message_id};
  } catch (e) { return {status: e.bodyWritten ? 'uncertain' : 'failed', error: cleanError(e).message}; }
}

// Very small markdown -> Telegram HTML (bold, italics, code, links). Falls back to plain text on error.
export function toHtml(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = String(md).split(/```(?:[\w-]*)\n?([\s\S]*?)```/g);
  return parts.map((part, i) => {
    if (i % 2) return `<pre>${esc(part.trimEnd())}</pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1<i>$2</i>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>');
  }).join('');
}

export function chunks(text, size = 3900) {
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

export async function sendText(chatId, text, extra = {}) {
  const sent = [];
  for (const part of chunks(text)) {
    try { sent.push(await call('sendMessage', {chat_id: chatId, text: toHtml(part), parse_mode: 'HTML', disable_web_page_preview: true, ...extra})); }
    catch (e) {
      if (e.status !== 400) { if (sent.length) e.bodyWritten = true; throw e; }
      try { sent.push(await call('sendMessage', {chat_id: chatId, text: part, disable_web_page_preview: true, ...extra})); }
      catch (plain) { if (sent.length) plain.bodyWritten = true; throw plain; }
    }
  }
  return sent;
}

export const sendToOwner = (text, extra) => sendText(config.ownerTelegramId, text, extra);

// One message per question, with Later / Skip buttons. A Telegram reply to the message answers it.
export async function sendQuestions(questions, {intro} = {}) {
  const db = openDb();
  if (intro) await sendToOwner(intro);
  const ids = [];
  for (const [i, q] of questions.entries()) {
    const days = Math.max(0, Math.round((Date.now() - Date.parse(q.asked_at || Date.now())) / 86400_000));
    const when = days === 0 ? 'asked today' : `waiting ${days} days`;
    const text = `${i + 1}. ${q.domain}, ${when}\n\n${q.text}\n\nReply to this message to answer.`;
    const [msg] = await sendText(config.ownerTelegramId, text, {reply_markup: {inline_keyboard: [[
      {text: 'Later', callback_data: 'q:later'}, {text: 'Skip', callback_data: 'q:skip'}]]}});
    db.prepare('INSERT OR REPLACE INTO tg_questions VALUES(?,?,?)').run(msg.message_id, q.id, Date.now());
    ids.push(msg.message_id);
  }
  return ids;
}
