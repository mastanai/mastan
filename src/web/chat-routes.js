// /api/chat/*: the web chat behind a session. index.js has already checked the session and, for POST,
// the CSRF token. Threads: /api/chat/threads (list, create), /api/chat/threads/<id>/rename|archive|unarchive.
// history, send, stop and new take a thread id (query ?thread= or body {thread}); without one they use the
// thread used last. Bodies are JSON with base64 files (screenshots from the clipboard or the picker);
// /api/chat/stream is server-sent events for every thread of the identity (events carry `thread`);
// /api/chat/file/<date>/<name> serves an attachment back (images and PDFs only, from the workspace inbox).
import {createReadStream, statSync, constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {resolve, extname} from 'node:path';
import {LIMITS, TITLE_MAX, SERVED_TYPES} from '../channels/web-chat.js';
import {safeName, inlineImage} from '../files.js';

const MAX_BODY = Math.ceil(LIMITS.totalBytes * 1.4) + 64 * 1024; // base64 plus the text
const HEARTBEAT_MS = 20_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[\w-][\w.-]{0,200}$/;
const ROUTES = /^\/api\/chat\/(history|stream|send|stop|new|threads)$/;
const THREAD_ROUTE = /^\/api\/chat\/threads\/(\d{1,9})\/(rename|archive|unarchive)$/;

export function createChatRoutes(ctx, {readJson, onlyKeys, fail, json}) {
  const bad = (status, message) => Object.assign(fail(status, message), {expose: true});
  const whoOf = session => (session.operator ? 'operator' : 'owner');
  const threadOf = value => {
    if (value === undefined || value === null || value === '') return null;
    if (!/^\d{1,9}$/.test(String(value))) throw bad(400, 'Bad thread.');
    return Number(value);
  };

  function parseFiles(input) {
    const list = input.files === undefined ? [] : input.files;
    if (!Array.isArray(list)) throw bad(400, 'files must be a list.');
    if (list.length > LIMITS.files) throw bad(400, `At most ${LIMITS.files} files per message.`);
    let total = 0;
    return list.map(f => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad(400, 'Bad file.');
      onlyKeys(f, ['name', 'type', 'data']);
      if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(f.data)) throw bad(400, 'Bad file data.');
      const data = Buffer.from(f.data, 'base64');
      if (!data.length) throw bad(400, 'Empty file.');
      if (data.length > LIMITS.fileBytes) throw bad(413, `A file is too big (${Math.round(LIMITS.fileBytes / 1048576)} MB at most).`);
      total += data.length;
      if (total > LIMITS.totalBytes) throw bad(413, 'The files are too big together.');
      const type = typeof f.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type.toLowerCase() : 'application/octet-stream';
      const name = typeof f.name === 'string' ? f.name.slice(0, LIMITS.nameChars) : '';
      return {name, type, data};
    });
  }

  function stream(req, res, who, chat) {
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive'});
    const write = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    res.write('retry: 2000\n\n');
    write('hello', {who, lives: chat.lives(who), now: new Date().toISOString(), tasks: chat.taskLists(who)});
    const onEvent = ev => { if (ev.who === who) write(ev.type, ev); };
    chat.on('event', onEvent);
    const beat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, HEARTBEAT_MS);
    req.on('close', () => { clearInterval(beat); chat.off('event', onEvent); });
  }

  function serveFile(req, res, rel) {
    const [date, name, extra] = rel.split('/');
    if (!date || !name || extra !== undefined || !DATE_RE.test(date) || !NAME_RE.test(name) || name.includes('..')) throw fail(404);
    const type = SERVED_TYPES[extname(name).toLowerCase()];
    if (!type) throw fail(404);
    const root = resolve(ctx.config.workspace, 'inbox');
    const path = resolve(root, date, name);
    if (!path.startsWith(root + '/')) throw fail(404);
    let st;
    try { st = statSync(path); } catch { throw fail(404); }
    if (!st.isFile()) throw fail(404);
    res.writeHead(200, {'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline'});
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  }

  const threadOut = row => ({thread: {id: row.id, title: row.title, archived: row.archived ? new Date(row.archived).toISOString() : null}});

  async function serveArtifact(req, res, id, who, inline) {
    const a = ctx.db.prepare('SELECT * FROM artifacts WHERE id=? AND user=?').get(id, who);
    if (!a || inline && !inlineImage(a.mime)) throw fail(404);
    let file, st;
    try {
      file = await open(a.stored_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      st = await file.stat();
      if (!st.isFile() || st.size !== a.size) throw new Error('Missing file');
    } catch { await file?.close(); throw fail(404); }
    try {
      const name = safeName(a.name);
      const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(200, {'Content-Type': a.mime, 'Content-Length': st.size, 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encoded}`});
      if (req.method === 'HEAD') return res.end();
      await pipeline(file.createReadStream(), res);
    } finally { await file.close(); }
  }

  return async function chatApi(req, res, path, session) {
    const chat = ctx.chat;
    if (!chat) throw bad(503, 'Chat is not running.');
    const who = whoOf(session);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const query = new URL(req.url, 'http://x').searchParams;
    if (path.startsWith('/api/chat/out/') && method === 'GET') return serveArtifact(req, res, path.slice('/api/chat/out/'.length), who, query.get('inline') === '1');
    if (path === '/api/chat/history' && method === 'GET') {
      const before = Number(query.get('before')) || null;
      return json(res, 200, {who, operator: !!session.operator, ...chat.history(who, {thread: threadOf(query.get('thread')), before})});
    }
    if (path === '/api/chat/stream' && method === 'GET') return stream(req, res, who, chat);
    if (path.startsWith('/api/chat/file/') && method === 'GET') return serveFile(req, res, path.slice('/api/chat/file/'.length));
    if (path === '/api/chat/threads' && method === 'GET') return json(res, 200, chat.threads(who));
    if (path === '/api/chat/threads' && method === 'POST') {
      const input = await readJson(req);
      onlyKeys(input, ['title']);
      if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > TITLE_MAX * 4)) throw bad(400, 'Bad title.');
      return json(res, 200, threadOut(chat.createThread(who, input.title || '')));
    }
    const tm = path.match(THREAD_ROUTE);
    if (tm && method === 'POST') {
      const id = Number(tm[1]);
      const input = await readJson(req);
      if (tm[2] === 'rename') {
        onlyKeys(input, ['title']);
        if (typeof input.title !== 'string' || input.title.length > TITLE_MAX * 4) throw bad(400, 'Bad title.');
        return json(res, 200, threadOut(chat.renameThread(who, id, input.title)));
      }
      onlyKeys(input, []);
      return json(res, 200, threadOut(chat.archiveThread(who, id, tm[2] === 'archive')));
    }
    if (path === '/api/chat/send' && method === 'POST') {
      const input = await readJson(req, MAX_BODY);
      onlyKeys(input, ['text', 'files', 'thread']);
      const text = typeof input.text === 'string' ? input.text.replace(/\r\n/g, '\n').trim() : '';
      if (text.length > LIMITS.textChars) throw bad(400, `The message is too long (${LIMITS.textChars} characters at most).`);
      const files = parseFiles(input);
      if (!text && !files.length) throw bad(400, 'Write something or attach a file.');
      return json(res, 200, await chat.send(who, {thread: threadOf(input.thread), text, files}));
    }
    if (path === '/api/chat/stop' && method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['thread', 'task']);
      if (input.task !== undefined) {
        if (!Number.isSafeInteger(input.task) || input.task < 1) throw bad(400, 'Bad task.');
        const t = chat.resolveThread(who, threadOf(input.thread));
        const out = await ctx.tasks?.stop(chat.taskContext(who, t.id), input.task);
        return json(res, 200, {stopped: out?.status === 'stopped', ...(out?.error ? {error: out.error} : {})});
      }
      return json(res, 200, {stopped: chat.stop(who, threadOf(input.thread))});
    }
    if (path === '/api/chat/new' && method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['thread']);
      return json(res, 200, chat.newSession(who, threadOf(input.thread)));
    }
    if (ROUTES.test(path) || THREAD_ROUTE.test(path) || path.startsWith('/api/chat/file/') || path.startsWith('/api/chat/out/')) throw fail(405);
    throw fail(404);
  };
}
