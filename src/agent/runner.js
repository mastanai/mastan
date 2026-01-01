// Main agent turns: one Claude session per channel chat, resumed with --resume, cwd = workspace
// (so CLAUDE.md, skills, memory and the atlas are in scope). /new starts a fresh session.
import {writeFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {config, loadModels, modelLabel, deepseekSettings} from '../config.js';
import {openDb} from '../db.js';
import {atlas} from '../atlas/store.js';
import {runRole, warmRole, dropSession, shutdownSessions, residentCount} from '../providers/index.js';
import {smartsheetOn} from '../providers/common.js';
import {deepseekDirs} from '../providers/deepseek.js';
import {sim} from '../channels/telegram-api.js';
import {tasksOn, TASK_NOTE, pendingTaskNotes, clearTaskNotes} from './tasks.js';
import {schedulesOn, SCHEDULE_NOTE, pendingScheduleNotes, clearScheduleNotes} from './schedules.js';
import {toolLine} from '../channels/tool-line.js';

const FILE_NOTE = 'Files you make for Owner: use mastan-me-send <path> --caption "<one line>". Say sent only after it prints sent; uncertain means it may have arrived, do not resend; failed means say why. Never give a server path to get a file.';
const CHANNEL_NOTES = {
  telegram: `You are talking to Owner on Telegram (his phone). Keep replies short: a few lines, plain text, simple markdown at most (bold, code). No tables, no headers, no em dashes. ${FILE_NOTE} Each message from Owner starts with the Riyadh weekday and time in brackets; that is metadata from the harness, never repeat it.`,
  whatsapp: `You are talking to Owner on WhatsApp (his phone). Keep replies short: a few lines, plain text. WhatsApp marks only: *bold*, _italic_, \`\`\`code\`\`\`. No tables, no headers, no em dashes. Attachments arrive as [Attached: <path>] lines; open them before answering about them. ${FILE_NOTE} Background tasks, schedules and reminders are not available on WhatsApp yet: do the work in this reply, or tell Owner to ask on Telegram or the web chat. Each message from Owner starts with the Riyadh weekday and time in brackets; that is metadata from the harness, never repeat it.`,
  web: `You are talking to Owner in the web chat of his harness (phone or Mac). Keep replies short. Simple markdown is rendered: bold, inline code, code blocks, lists, links. No tables, no headers, no em dashes. Attachments arrive as [Attached: <path>] lines; open them before answering about them. ${FILE_NOTE} Each message starts with the Riyadh weekday and time in brackets; that is metadata from the harness, never repeat it.`,
};
const chatContext = (channel, chatId, deepseek = false) => ({user: channel === 'web' ? String(chatId).split('#')[0] : 'owner', channel, chatId: String(chatId),
  simulation: sim.getStore(), ...(deepseek ? {deepseek: true} : {})});
const deepseekNote = (label, noImages) => `You are running on ${label} through the DeepSeek API, not on Claude. Work-project access is not available here: no Smartsheet, and the Work project folders are hidden. If Owner asks for Work or Smartsheet data, tell him to switch with /model claude. Background tasks, schedules and reminders are off in this chat: do the work in this reply, or tell Owner to switch with /model claude.${noImages ? ' You cannot see images: if Owner sends one, say so and suggest /model flash.' : ''}`;

// Riyadh weekday and time, prefixed to every message: the model knows the time without a system prompt that changes every turn.
const stamp = () => `[${new Intl.DateTimeFormat('en-GB', {timeZone: config.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date()).replace(',', '')} Riyadh]`;

export class Agent {
  constructor() {
    this.db = openDb();
    this.running = new Map(); // key -> {controller, started, request, lastTool, status, replyTail}
  }

  key(channel, chatId) { return `${channel}:${chatId}`; }
  busy(channel, chatId) { return this.running.has(this.key(channel, chatId)); }
  busyCount() { return this.running.size; }

  newSession(channel, chatId) {
    dropSession(this.key(channel, chatId));
    this.db.prepare('DELETE FROM chats WHERE channel=? AND chat_id=?').run(channel, String(chatId));
  }

  shutdown() { shutdownSessions(); }
  residents() { return residentCount(); }

  // The model for one chat: Owner's /model choice for it, else the main role. deepseek: true runs it on DeepSeek
  // (sandboxed, no Work tools, no tasks or schedules).
  pickOf(channel, chatId) {
    const models = loadModels(), main = models.roles.main;
    const row = this.db.prepare('SELECT model FROM chat_models WHERE channel=? AND chat_id=?').get(channel, String(chatId));
    const provider = row && ['claude-cli', 'deepseek-cli'].find(p => (models.choices[p] || []).includes(row.model));
    if (!provider) return {provider: main.provider, model: main.model, effort: main.effort, label: modelLabel(main.model, models), isDefault: true, deepseek: false};
    const deepseek = provider === 'deepseek-cli';
    return {provider, model: row.model, effort: deepseek ? deepseekSettings().effort : main.effort, label: modelLabel(row.model, models), isDefault: false, deepseek};
  }

  // Sets this chat's model (null = back to the main role) and starts a new session: session ids never cross models.
  setPick(channel, chatId, model) {
    if (this.busy(channel, chatId)) throw Object.assign(new Error('Stop the running turn first (/stop).'), {code: 'BUSY'});
    const models = loadModels();
    if (model && !['claude-cli', 'deepseek-cli'].some(p => (models.choices[p] || []).includes(model))) throw Object.assign(new Error(`Unknown model ${model}.`), {code: 'BAD_MODEL'});
    this.newSession(channel, chatId);
    if (model) this.db.prepare(`INSERT INTO chat_models(channel,chat_id,model,updated) VALUES(?,?,?,?)
      ON CONFLICT(channel,chat_id) DO UPDATE SET model=excluded.model, updated=excluded.updated`).run(channel, String(chatId), model, Date.now());
    else this.db.prepare('DELETE FROM chat_models WHERE channel=? AND chat_id=?').run(channel, String(chatId));
    return this.pickOf(channel, chatId);
  }

  // What a chat's main-agent process runs with: system file, MCP kind, chat context, and the pick unless default.
  runSpec(channel, chatId, pick) {
    return {systemFile: this.systemFile(channel, pick), mcp: pick.deepseek ? 'main-noorg' : 'main', chat: chatContext(channel, chatId, pick.deepseek),
      ...(pick.isDefault ? {} : {pick: {provider: pick.provider, model: pick.model, effort: pick.effort}})};
  }

  // Boots the resident Claude process for a chat before Owner writes, so the first turn after a restart or an
  // idle period costs model time only. No-op while one is alive. Nothing is sent to the model.
  warm(channel, chatId) {
    const key = this.key(channel, chatId);
    if (this.running.has(key)) return false;
    const pick = this.pickOf(channel, chatId);
    const row = this.db.prepare('SELECT * FROM chats WHERE channel=? AND chat_id=?').get(channel, String(chatId));
    const resume = row?.session_id && row.model === pick.model ? row.session_id : null;
    let warmed;
    try { ({warmed} = warmRole('main', {sessionKey: key, cwd: config.workspace, resume, ...this.runSpec(channel, chatId, pick)})); }
    catch (e) { console.log(`[agent] no resident booted for ${key}: ${e.code || 'error'}`); return false; }
    if (warmed) console.log(`[agent] resident booted ahead for ${key}`);
    return warmed;
  }

  stop(channel, chatId) {
    const r = this.running.get(this.key(channel, chatId));
    if (!r) return false;
    r.controller.abort();
    return true;
  }

  systemFile(channel, pick = null) {
    const soulPath = join(config.workspace, 'SOUL.md');
    const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : 'You are Owner\'s personal harness.';
    if (pick?.deepseek) {
      // Written where the DeepSeek sandbox can read it (the normal run dir is hidden there).
      const dir = deepseekDirs().run;
      mkdirSync(dir, {recursive: true, mode: 0o700});
      const file = join(dir, `system-${channel}-${pick.model}.md`);
      const noImages = (deepseekSettings().no_images || []).includes(pick.model);
      const body = `${soul.trim()}\n\n## Channel\n\n${CHANNEL_NOTES[channel] || ''}\n\n## Model\n\n${deepseekNote(pick.label, noImages)}\n\nWorkspace: ${config.workspace}.\n`;
      if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeFileSync(file, body);
      return file;
    }
    const dir = join(config.dataDir, 'run');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const file = join(dir, `system-${channel}.md`);
    const smartsheet = smartsheetOn()
      ? 'Smartsheet: connected through the mcp__smartsheet__* tools as API user api-user@example.com. Read skills/smartsheet before the first sheet question in a session.'
      : 'Smartsheet: not connected on this server (no token loaded). If Owner asks for sheet data, say so.';
    const body = `${soul.trim()}\n\n## Channel\n\n${CHANNEL_NOTES[channel] || ''}${tasksOn() && channel !== 'whatsapp' ? ` ${TASK_NOTE}` : ''}${schedulesOn() && channel !== 'whatsapp' ? ` ${SCHEDULE_NOTE}` : ''}\n\nWorkspace: ${config.workspace}.\n${smartsheet}\n`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeFileSync(file, body);
    return file;
  }

  // Runs one turn. onDelta(textSoFar) streams text; onTool(name) reports tool use.
  async turn({channel, chatId, text, onDelta = () => {}, onTool = () => {}}) {
    const key = this.key(channel, chatId);
    if (this.running.has(key)) throw Object.assign(new Error('Busy'), {code: 'BUSY'});
    const controller = new AbortController();
    const state = {controller, started: Date.now(), request: text.slice(0, 600), lastTool: null, status: null, replyTail: ''};
    this.running.set(key, state);
    const pick = this.pickOf(channel, chatId);
    const row = this.db.prepare('SELECT * FROM chats WHERE channel=? AND chat_id=?').get(channel, String(chatId));
    const resume = row?.session_id && row.model === pick.model ? row.session_id : null;
    const task = this.db.prepare("INSERT INTO tasks(channel,chat_id,kind,status,started) VALUES(?,?,'turn','running',?)").run(channel, String(chatId), Date.now()).lastInsertRowid;
    // Task and schedule results can carry Work data: a DeepSeek turn leaves them pending for the next Claude turn.
    const notes = pick.deepseek ? [] : pendingTaskNotes(this.db, channel, chatId);
    const scheduleNotes = pick.deepseek ? [] : pendingScheduleNotes(this.db, channel, chatId);
    const opts = {task: `turn:${channel}`, prompt: [...notes.map(n => n.note), ...scheduleNotes.map(n => n.note), `${stamp()} ${text}`].join('\n'), sessionKey: key, cwd: config.workspace, stream: true,
      ...this.runSpec(channel, chatId, pick), signal: controller.signal, timeoutMs: 60 * 60_000,
      onEvent: ev => {
        if (ev.kind === 'delta') { state.replyTail = ev.text.slice(-300); onDelta(ev.text); }
        else if (ev.kind === 'tool') { state.lastTool = ev.name; state.status = toolLine(ev.name, ev.input); onTool(ev.name, ev.input); }
      }};
    try {
      let result;
      try { result = await runRole('main', {...opts, resume}); }
      catch (e) {
        // A lost or expired session: start fresh once instead of failing the message.
        if (!resume || e.code === 'ABORTED' || !/session|conversation|resume/i.test(e.message)) throw e;
        result = await runRole('main', {...opts, resume: null});
      }
      const now = Date.now();
      clearTaskNotes(this.db, notes);
      clearScheduleNotes(this.db, scheduleNotes);
      this.db.prepare(`INSERT INTO chats(channel,chat_id,session_id,model,created,updated,turns) VALUES(?,?,?,?,?,?,1)
        ON CONFLICT(channel,chat_id) DO UPDATE SET session_id=excluded.session_id, model=excluded.model, updated=excluded.updated, turns=turns+1`)
        .run(channel, String(chatId), result.sessionId, result.model, now, now);
      this.db.prepare("UPDATE tasks SET status='done', finished=? WHERE id=?").run(now, task);
      try {
        const a = atlas();
        a.logChat(channel, text, result.text);
        a.renderAtlasMd();
        a.commit(`chat turn (${channel})`);
      } catch {}
      return {...result, label: pick.label, isDefault: pick.isDefault};
    } catch (e) {
      this.db.prepare('UPDATE tasks SET status=?, finished=?, error=? WHERE id=?').run(e.code === 'ABORTED' ? 'stopped' : 'failed', Date.now(), String(e.message).slice(0, 300), task);
      throw e;
    } finally {
      this.running.delete(key);
    }
  }

  runningInfo(channel, chatId) { return this.running.get(this.key(channel, chatId)) || null; }
}
