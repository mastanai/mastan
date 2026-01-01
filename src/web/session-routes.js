// The my.example.com chat client talks to these routes. They sit on the same WebChat threads, so Telegram-style tasks,
// schedules and files keep working; a "session" here is a thread. Message ids stay the database ids.
import {createReadStream, statSync, rmSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {LIMITS, SERVED_TYPES} from '../channels/web-chat.js';
import {MIME} from '../files.js';
import {NAV, OWNER_ONLY} from './pages.js';

const ID = /^\d{1,9}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAME = /^[\w-][\w.-]{0,200}$/;
const AUDIO = {'.webm': 'audio/webm', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'};
export const SESSION_ROUTE = /^\/api\/(bootstrap|events|sessions|uploads|mail)(\/|$)/;

const preview = text => String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const uploadId = rel => Buffer.from(rel).toString('base64url');
function relOf(id, bad) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,400}$/.test(id)) throw bad(400, 'Bad file.');
  const rel = Buffer.from(id, 'base64url').toString('utf8'), [date, name, extra] = rel.split('/');
  if (!date || !name || extra !== undefined || !DATE.test(date) || !NAME.test(name) || name.includes('..') || !name.startsWith('web-')) throw bad(404, 'Not found.');
  return {rel, name};
}
const mimeOf = name => {
  const ext = extname(name).toLowerCase();
  return SERVED_TYPES[ext] || AUDIO[ext] || MIME[ext] || 'application/octet-stream';
};
const originalName = name => name.replace(/^web-\d{6}-\d+-(operator-)?/, '');
const clientFile = f => f.artifact ? {artifact: f.artifact, name: f.name, mime: f.mime, size: f.size} : {...f, id: f.rel ? uploadId(f.rel) : undefined, rel: undefined};

export function clientMessage(m) {
  return {id: m.id, sessionId: String(m.thread), clientId: m.clientId || undefined, quoteId: m.quoteId || undefined,
    role: m.role === 'system' ? 'assistant' : m.role, text: m.text, status: m.status, created: Date.parse(m.created), files: (m.files || []).map(clientFile),
    ...(m.task || m.schedule ? {notification: true} : {})};
}

export function createSessionRoutes(ctx, {readJson, onlyKeys, fail, json, leaseOf}) {
  const bad = (status, message) => Object.assign(fail(status, message), {expose: true});
  const whoOf = session => (session.operator ? 'operator' : 'owner');
  const threadId = id => { if (!ID.test(id)) throw fail(404); return Number(id); };

  function view(chat, who, t) {
    const db = chat.db;
    const last = db.prepare("SELECT id,text,created FROM web_messages WHERE thread=? ORDER BY id DESC LIMIT 1").get(t.id);
    const unread = db.prepare("SELECT count(*) AS n, min(id) AS first FROM web_messages WHERE thread=? AND id>? AND role='assistant' AND status!='running'").get(t.id, t.read_id || 0);
    return {id: String(t.id), title: t.title, pinned: !!t.pinned, created: t.created, updated: t.updated,
      last: preview(last?.text), lastAt: last?.created || null, lastId: last?.id || 0, empty: !last,
      unread: unread.n, firstUnread: unread.first, running: chat.busy(t.id), queued: (chat.queue.get(t.id) || []).length, tasks: chat.taskList(who, t.id)};
  }
  function list(chat, who, q = '') {
    const rows = chat.db.prepare('SELECT * FROM web_threads WHERE who=? AND archived IS NULL ORDER BY pinned DESC, updated DESC, id DESC').all(who);
    q = q.slice(0, 200).toLowerCase();
    if (!q) return rows.map(t => view(chat, who, t));
    return rows.flatMap(t => {
      if (t.title.toLowerCase().includes(q)) return [view(chat, who, t)];
      const hit = chat.db.prepare('SELECT text FROM web_messages WHERE thread=? AND instr(lower(text),?)>0 ORDER BY id DESC LIMIT 1').get(t.id, q);
      if (!hit) return [];
      const text = preview(hit.text.slice(Math.max(0, hit.text.toLowerCase().indexOf(q) - 44)));
      return [{...view(chat, who, t), matchSnippet: text}];
    });
  }
  function history(chat, who, id, before) {
    const out = chat.history(who, {thread: id, before});
    const t = chat.threadRow(who, id);
    const messages = out.messages.map(clientMessage);
    const live = out.live && messages.find(m => m.id === out.live.id);
    if (live) live.text = out.live.text;
    return {messages, more: out.more, session: view(chat, who, t)};
  }

  // Replaying is not needed: on every (re)connect the client reloads the list and the open session.
  let lastEvent = 0;
  const nextEvent = () => (lastEvent = Math.max(lastEvent + 1, Date.now() * 1000));
  function events(req, res, chat, who) {
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive'});
    const write = (type, data) => { if (!res.destroyed) res.write(`id: ${nextEvent()}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    const session = thread => { try { write('session', view(chat, who, chat.threadRow(who, thread))); } catch {} };
    const message = id => { try { const m = clientMessage(chat.row(id)); const live = chat.live.get(m && Number(m.sessionId)); if (live?.id === id) m.text = live.text; write('message', m); } catch {} };
    res.write('retry: 2000\n\n');
    const onEvent = ev => {
      if (ev.who !== who) return;
      const sessionId = String(ev.thread);
      if (ev.type === 'user') { write('message', clientMessage(ev.message)); session(ev.thread); }
      else if (ev.type === 'start') { message(ev.id); session(ev.thread); }
      else if (ev.type === 'delta') write('delta', {sessionId, id: ev.id, text: ev.text});
      else if (ev.type === 'tool') { write('status', {sessionId, text: ev.status || ''}); if (ev.text) write('delta', {sessionId, id: ev.id, text: ev.text}); }
      else if (ev.type === 'done') { message(ev.id); session(ev.thread); }
      else if (ev.type === 'artifact' || ev.type === 'task' || ev.type === 'schedule') { write('message', clientMessage(ev.message)); session(ev.thread); }
      else if (ev.type === 'thread' || ev.type === 'tasks') {
        const row = chat.db.prepare('SELECT archived FROM web_threads WHERE id=?').get(ev.thread);
        if (row?.archived) write('session-deleted', {id: sessionId}); else session(ev.thread);
      } else if (ev.type === 'removed') write('message', {id: ev.id, sessionId, status: 'silent', created: 0, role: 'assistant', text: ''});
    };
    chat.on('event', onEvent);
    const beat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 20_000);
    req.on('close', () => { clearInterval(beat); chat.off('event', onEvent); });
  }

  async function upload(req, res, chat, who, session) {
    const sessionId = new URL(req.url, 'http://x').searchParams.get('session');
    chat.threadRow(who, threadId(sessionId || ''));
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
    let name = ''; try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMITS.fileBytes) throw bad(413, `A file is too big (${Math.round(LIMITS.fileBytes / 1048576)} MB at most).`);
      chunks.push(chunk);
    }
    if (!size) throw bad(400, 'Empty file.');
    const [saved] = chat.saveFiles(who, [{name: name.slice(0, LIMITS.nameChars), type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream', data: Buffer.concat(chunks)}]);
    return json(res, 200, {id: uploadId(saved.rel), name: saved.name, size: saved.size, mime: saved.mime});
  }
  function serveUpload(req, res, id) {
    const {rel, name} = relOf(id, bad);
    const root = resolve(ctx.config.workspace, 'inbox'), path = resolve(root, rel);
    if (!path.startsWith(root + '/')) throw fail(404);
    let st; try { st = statSync(path); } catch { throw fail(404); }
    if (!st.isFile()) throw fail(404);
    const type = mimeOf(name), inline = !!SERVED_TYPES[extname(name).toLowerCase()] || type.startsWith('audio/');
    res.writeHead(200, {'Content-Type': inline ? type : 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${originalName(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"`});
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  }
  function resolveFiles(files, who) {
    if (files === undefined) return [];
    if (!Array.isArray(files) || files.length > LIMITS.files) throw bad(400, `At most ${LIMITS.files} files per message.`);
    const root = resolve(ctx.config.workspace, 'inbox');
    return files.map(f => {
      if (!f || typeof f !== 'object') throw bad(400, 'Bad file.');
      const {rel, name} = relOf(f.id, bad), path = resolve(root, rel);
      let st; try { st = statSync(path); } catch { throw bad(400, 'That file is gone. Attach it again.'); }
      return {path, rel, name: originalName(name), mime: mimeOf(name), size: st.size};
    });
  }

  return async function sessionApi(req, res, path, session) {
    const chat = ctx.chat;
    if (!chat) throw bad(503, 'Chat is not running.');
    const who = whoOf(session), method = req.method === 'HEAD' ? 'GET' : req.method;
    const query = new URL(req.url, 'http://x').searchParams;
    if (path === '/api/bootstrap' && method === 'GET') {
      return json(res, 200, {authenticated: true, accountKey: who, operator: !!session.operator, sessions: list(chat, who), cursor: 0,
        brand: {name: 'Mastan Me'}, workspace: false, trial: [],
        nav: NAV.filter(([href]) => href !== '/chat' && !(session.operator && OWNER_ONLY.has(href))),
        limits: {image: LIMITS.fileBytes, voice: LIMITS.fileBytes, file: LIMITS.fileBytes, dailyBytes: 2 ** 31}});
    }
    if (path === '/api/events' && method === 'GET') return events(req, res, chat, who);
    if (path === '/api/uploads' && method === 'POST') return await upload(req, res, chat, who, session);
    const up = /^\/api\/uploads\/([A-Za-z0-9_-]{8,400})$/.exec(path);
    if (up && method === 'GET') return serveUpload(req, res, up[1]);
    if (up && method === 'DELETE') {
      const {rel} = relOf(up[1], bad), root = resolve(ctx.config.workspace, 'inbox'), file = resolve(root, rel);
      if (file.startsWith(root + '/')) rmSync(file, {force: true});
      return json(res, 200, {ok: true});
    }
    const mail = /^\/api\/mail\/([a-f0-9]{24})\/open$/.exec(path);
    if (mail && method === 'POST') {
      // Owner's mail: never for a test login.
      if (session.operator || !ctx.mailAlerts) throw fail(404);
      onlyKeys(await readJson(req), []);
      return json(res, 200, view(chat, who, await ctx.mailAlerts.open(chat, who, mail[1])));
    }
    if (path === '/api/sessions' && method === 'GET') return json(res, 200, list(chat, who, query.get('q') || ''));
    if (path === '/api/sessions' && method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['title']);
      if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 280)) throw bad(400, 'Bad title.');
      const empty = !input.title && chat.db.prepare("SELECT * FROM web_threads t WHERE who=? AND archived IS NULL AND title='New session' AND NOT EXISTS (SELECT 1 FROM web_messages WHERE thread=t.id) ORDER BY created DESC LIMIT 1").get(who);
      return json(res, 200, view(chat, who, empty || chat.createThread(who, input.title || 'New session')));
    }
    const m = /^\/api\/sessions\/([^/]+)(?:\/(messages|stop|undo|retry))?$/.exec(path);
    const mm = /^\/api\/sessions\/([^/]+)\/messages\/(\d{1,12})$/.exec(path);
    if (mm && method === 'DELETE') {
      chat.deleteMessage(who, threadId(mm[1]), Number(mm[2]));
      return json(res, 200, {ok: true});
    }
    if (!m) throw fail(404);
    const id = threadId(m[1]), action = m[2];
    if (action === 'undo' && method === 'POST') { onlyKeys(await readJson(req), []); return json(res, 200, view(chat, who, chat.archiveThread(who, id, false))); }
    const t = chat.threadRow(who, id);
    if (t.archived) throw fail(404);
    if (!action && method === 'PATCH') {
      const input = await readJson(req); onlyKeys(input, ['title', 'pinned', 'read']);
      if (input.title !== undefined) chat.renameThread(who, id, input.title);
      if (input.pinned !== undefined) {
        if (typeof input.pinned !== 'boolean') throw bad(400, 'Bad pinned.');
        chat.db.prepare('UPDATE web_threads SET pinned=? WHERE id=?').run(Number(input.pinned), id);
      }
      if (input.read !== undefined) {
        if (!Number.isSafeInteger(input.read) || input.read < 0) throw bad(400, 'Bad read.');
        chat.db.prepare('UPDATE web_threads SET read_id=MAX(read_id,?) WHERE id=?').run(input.read, id);
      }
      return json(res, 200, view(chat, who, chat.threadRow(who, id)));
    }
    if (!action && method === 'DELETE') { chat.stop(who, id); chat.archiveThread(who, id, true); return json(res, 200, {ok: true}); }
    if (action === 'messages' && method === 'GET') {
      const before = query.get('before');
      return json(res, 200, history(chat, who, id, before && /^\d+$/.test(before) ? Number(before) : null));
    }
    if (action === 'messages' && method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['text', 'clientId', 'files', 'quoteId']);
      const text = typeof input.text === 'string' ? input.text.replace(/\r\n/g, '\n').trim() : '';
      if (text.length > LIMITS.textChars) throw bad(400, `The message is too long (${LIMITS.textChars} characters at most).`);
      const saved = resolveFiles(input.files, who);
      if (!text && !saved.length) throw bad(400, 'Write something or attach a file.');
      const clientId = typeof input.clientId === 'string' && /^[\w-]{8,64}$/.test(input.clientId) ? input.clientId : null;
      const quoteId = Number.isSafeInteger(input.quoteId) ? input.quoteId : null;
      // The lease travels only with a message from Owner's own browser; it is what lets this turn auto-approve.
      const out = await chat.send(who, {thread: id, text, saved, clientId, quoteId, lease: session.operator ? null : leaseOf(req)});
      return json(res, 200, clientMessage(chat.row(out.id)));
    }
    if (action === 'stop' && method === 'POST') { onlyKeys(await readJson(req), []); return json(res, 200, {stopped: chat.stop(who, id)}); }
    if (action === 'retry' && method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['id']);
      chat.retry(who, id, input.id, session.operator ? null : leaseOf(req));
      return json(res, 200, {ok: true});
    }
    throw fail(405);
  };
}
