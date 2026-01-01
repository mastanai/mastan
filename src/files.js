// Outbound files are immutable copies with a receipt, owned by the chat's user.
import {constants} from 'node:fs';
import {open, realpath, mkdir, chmod, unlink} from 'node:fs/promises';
import {resolve, join, sep, basename, extname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {today} from './config.js';
import {sendFile} from './channels/telegram-api.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.zip': 'application/zip', '.rtf': 'application/rtf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};
// Only raster formats get an inline preview. SVG and other active content stay downloads.
export const inlineImage = mime => Object.values(MIME).includes(mime) && mime.startsWith('image/');
export function safeName(name) {
  const chars = Array.from(String(name).toWellFormed().replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '')).slice(0, 120);
  // Leave room for the artifact id within the filesystem's filename byte limit.
  while (Buffer.byteLength(chars.join('')) > 200) chars.pop();
  return chars.join('') || 'file';
}
const within = (root, path) => path === root || path.startsWith(root + sep);
const denied = () => new Error('File path is not allowed.');

export async function openSource(path, config, chat) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw denied();
  const source = resolve(config.workspace, path);
  let real;
  try { real = await realpath(source); } catch { throw new Error('File is not available.'); }
  const roots = await Promise.all([config.workspace, tmpdir()].map(p => realpath(p).catch(() => resolve(p))));
  const users = resolve(config.dataDir, 'users'), canonicalUsers = await realpath(users).catch(() => users);
  const user = ['owner', 'operator'].includes(chat?.user) ? chat.user : null;
  for (const root of [users, canonicalUsers]) {
    if ([source, real].some(f => within(root, f) && !(user && within(join(root, user), f)))) throw denied();
  }
  if (user) roots.push(join(canonicalUsers, user));
  const blocked = [join(config.dataDir, 'run'), join(config.dataDir, 'whatsapp'), config.agentHome, '/etc', '/run/credentials', config.credentialsDir].filter(Boolean);
  for (const p of blocked) {
    const root = resolve(p), canonical = await realpath(root).catch(() => root);
    if ([source, real].some(f => within(root, f) || within(canonical, f))) throw denied();
  }
  if ([source, real].some(p => p.split(sep).includes('.git')) || !roots.some(r => within(r, real))) throw denied();
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('Only regular files can be sent.');
    if (st.size < 1 || st.size > MAX_FILE_BYTES) throw new Error('Files must be 1 byte to 50 MB.');
    return {handle, real};
  } catch (e) { await handle.close(); throw e; }
}

export async function storeArtifact(config, db, chat, input) {
  const {handle, real} = await openSource(input.path, config, chat);
  const id = randomUUID(), name = safeName(input.name || basename(real));
  const dir = join(config.dataDir, 'users', chat.user, 'files', 'out', today());
  const stored = join(dir, `${id}-${name}`);
  let target;
  try {
    await mkdir(dir, {recursive: true, mode: 0o700});
    target = await open(stored, 'wx', 0o640);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({transform(chunk, encoding, cb) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return cb(new Error('Files must be 1 byte to 50 MB.'));
      hash.update(chunk); cb(null, chunk);
    }});
    await pipeline(handle.createReadStream(), meter, target.createWriteStream());
    if (!size) throw new Error('Files must be 1 byte to 50 MB.');
    await chmod(stored, 0o640);
    const artifact = {id, user: chat.user, channel: chat.channel, chat_id: String(chat.chatId), name,
      mime: MIME[extname(real).toLowerCase()] || 'application/octet-stream', size, sha256: hash.digest('hex'),
      stored_path: stored, caption: input.caption || '', created: Date.now()};
    db.prepare(`INSERT INTO artifacts(id,user,channel,chat_id,name,mime,size,sha256,stored_path,caption,created,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(...Object.values(artifact));
    return artifact;
  } catch (e) { if (target) await unlink(stored).catch(() => {}); throw e; }
  finally { await handle.close(); await target?.close(); }
}

export function createFileSender({config, db, chat, whatsapp}, {telegramSend = sendFile} = {}) {
  return async (context, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path', 'caption', 'name'].includes(k))
      || typeof input.path !== 'string' || input.caption !== undefined && (typeof input.caption !== 'string' || input.caption.length > 1024)
      || input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) return {status: 'failed', error: 'Expected path, optional caption (up to 1024 characters), and name.'};
    let a;
    try { a = await storeArtifact(config, db, context, input); }
    catch (e) { return {status: 'failed', error: ['File path is not allowed.', 'File is not available.', 'Only regular files can be sent.', 'Files must be 1 byte to 50 MB.'].includes(e.message) ? e.message : 'Could not store file.'}; }
    let out;
    try {
      if (context.channel === 'telegram') out = await telegramSend(context.chatId, a, {simulation: context.simulation});
      else if (context.channel === 'whatsapp') out = whatsapp ? await whatsapp.sendArtifact(context.chatId, a) : {status: 'failed', error: 'WhatsApp is not running.'};
      else out = {status: 'sent', receipt: chat.attachArtifact(context.user, context.chatId, a, {task: context.taskId})};
    } catch { out = {status: 'failed', error: 'Could not deliver file.'}; }
    db.prepare('UPDATE artifacts SET status=?, receipt=?, error=? WHERE id=?').run(out.status, out.receipt == null ? null : String(out.receipt), out.error || null, a.id);
    return {status: out.status, artifact: a.id, ...(out.receipt == null ? {} : {receipt: out.receipt}), ...(out.error ? {error: out.error} : {}), name: a.name, size: a.size};
  };
}
