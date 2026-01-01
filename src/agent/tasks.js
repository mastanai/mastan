// One-shot background work, with a per-user queue and durable completion notes for the next chat turn.
import {EventEmitter} from 'node:events';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {config} from '../config.js';
import {openDb} from '../db.js';
import {runRole} from '../providers/index.js';
import {sim, sendText} from '../channels/telegram-api.js';
import {CHECK_SYSTEM} from './schedules.js';

export const tasksOn = () => process.env.MASTAN_ME_TASKS !== 'off';
export const TASK_NOTE = 'Any request whose result is a file (deck, document, spreadsheet, PDF, image, chart), including a new version or variant, always goes to mastan-me-task start, whatever its expected length. Other work over about 30 seconds (research across pages, multi-step browser work, coding) too. Read skills/background-tasks/SKILL.md first; give the task a complete brief with every fact and file path because it cannot see this chat. Tell Owner what is running and that he can keep talking. Answers, explanations and short lookups stay here; never start two tasks for the same request.';
const TASK_SYSTEM = 'You are working on a task for Owner in the background. Nobody sees your intermediate text. Complete the brief using the workspace and main MCP tools. Use mastan-me-send for files, and say sent only after its sent receipt; never resend an uncertain delivery. End with a final reply of at most 8 lines that says what you did and what Owner should look at. Do not start another background task; mastan-me-task start is unavailable here.';
const riyadhTime = ms => new Intl.DateTimeFormat('en-GB', {timeZone: config.tz, dateStyle: 'short', timeStyle: 'short', hour12: false}).format(new Date(ms)) + ' Riyadh';
const failureReason = e => e?.code === 'TIMEOUT' ? 'Timed out after 60 minutes.' : 'The background task could not finish. Try again.';
const validId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;

export function pendingTaskNotes(db, channel, chatId) {
  return db.prepare(`SELECT n.task_id, n.note FROM bg_task_notes n JOIN bg_tasks t ON t.id=n.task_id
    WHERE t.channel=? AND t.chat_id=? AND n.note IS NOT NULL ORDER BY t.id`).all(channel, String(chatId));
}
export function clearTaskNotes(db, notes) {
  const clear = db.prepare('DELETE FROM bg_task_notes WHERE task_id=?');
  for (const n of notes) clear.run(n.task_id);
}

export class BackgroundTasks extends EventEmitter {
  constructor({db = openDb(), run = runRole} = {}) {
    super();
    this.db = db;
    this.run = run;
    this.running = new Map();
    this.contexts = new Map();
    this.web = null;
    this.closing = false;
  }

  owned(chat, id) {
    if (!validId(id)) return null;
    return this.db.prepare('SELECT * FROM bg_tasks WHERE id=? AND user=? AND channel=? AND chat_id=?')
      .get(Number(id), chat.user, chat.channel, String(chat.chatId));
  }

  list(chat) {
    return this.db.prepare(`SELECT id,title,status,created,started,finished FROM bg_tasks
      WHERE user=? AND channel=? AND chat_id=? ORDER BY id DESC`).all(chat.user, chat.channel, String(chat.chatId))
      .map(t => ({...t, minutes: Math.floor(((t.finished || Date.now()) - (t.started || t.created)) / 60_000)}));
  }

  listText(chat) {
    const rows = this.list(chat);
    return rows.length ? rows.map(t => `${t.id}. ${t.title}: ${t.status}, ${t.minutes} min`).join('\n') : 'No background tasks in this chat.';
  }

  async request(chat, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {status: 'failed', error: 'Bad task request.'};
    const keys = {start: ['action', 'title', 'brief', 'retry'], list: ['action'], stop: ['action', 'id']}[input.action];
    if (!keys || Object.keys(input).some(k => !keys.includes(k))) return {status: 'failed', error: 'Bad task request.'};
    if (input.action === 'list') return {status: 'ok', tasks: this.list(chat)};
    if (input.action === 'stop') return this.stop(chat, input.id);
    return this.start(chat, input);
  }

  start(chat, {title, brief, retry} = {}, {scheduleRun = null} = {}) {
    if (!tasksOn()) return {status: 'unavailable', error: 'Background tasks are disabled.'};
    if (chat.channel === 'whatsapp') return {status: 'unavailable', error: 'Background tasks are not on WhatsApp yet. Owner can start them on Telegram or the web chat.'};
    if (chat.kind === 'task') return {status: 'unavailable', error: 'A background task cannot start another task.'};
    if (this.closing) return {status: 'unavailable', error: 'The service is stopping.'};
    if (retry !== undefined) {
      const old = this.owned(chat, retry);
      if (!old) return {status: 'failed', error: 'Task not found.'};
      if (title !== undefined || brief !== undefined || ['queued', 'running'].includes(old.status)) return {status: 'failed', error: 'Retry needs a finished task and no new brief.'};
      ({title, brief} = old);
    }
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\r\n]/.test(title)
      || typeof brief !== 'string' || !brief.trim() || brief.length > 20_000) return {status: 'failed', error: 'Give a short title (up to 120 characters) and a brief (up to 20,000 characters).'};
    let id;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      id = Number(this.db.prepare(`INSERT INTO bg_tasks(user,channel,chat_id,title,brief,status,created,schedule_run)
        VALUES(?,?,?,?,?,'queued',?,?)`).run(chat.user, chat.channel, String(chat.chatId), title.trim(), brief, Date.now(), scheduleRun).lastInsertRowid);
      this.db.prepare('INSERT INTO bg_task_notes(task_id,simulated) VALUES(?,?)').run(id, chat.simulation ? 1 : 0);
      if (scheduleRun) this.db.prepare('UPDATE schedule_runs SET task_id=? WHERE id=?').run(id, scheduleRun);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.contexts.set(id, {...chat});
    this.changed(id);
    this.pump();
    return {status: this.owned(chat, id).status, id};
  }

  context(row) {
    if (!this.contexts.has(row.id)) {
      const simulated = this.db.prepare('SELECT simulated FROM bg_task_notes WHERE task_id=?').get(row.id)?.simulated;
      this.contexts.set(row.id, {user: row.user, channel: row.channel, chatId: row.chat_id, simulation: simulated ? {calls: []} : undefined});
    }
    return this.contexts.get(row.id);
  }

  changed(id) { this.emit('change', this.db.prepare('SELECT * FROM bg_tasks WHERE id=?').get(id)); }

  pump() {
    if (this.closing) return;
    for (const row of this.db.prepare("SELECT * FROM bg_tasks WHERE status='queued' ORDER BY id").all()) {
      if ([...this.running.values()].filter(r => r.user === row.user).length >= 2) continue;
      const controller = new AbortController();
      const state = {controller, user: row.user};
      this.running.set(row.id, state);
      this.db.prepare("UPDATE bg_tasks SET status='running', started=? WHERE id=?").run(Date.now(), row.id);
      this.changed(row.id);
      state.promise = this.execute(row, controller).finally(() => {
        this.running.delete(row.id);
        this.contexts.delete(row.id);
        this.pump();
      });
    }
  }

  systemFile(scheduled = false) {
    const dir = join(config.dataDir, 'run');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const soulPath = join(config.workspace, 'SOUL.md');
    const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : "You are Owner's personal harness.";
    const file = join(dir, scheduled ? 'system-scheduled-check.md' : 'system-background-task.md');
    const body = `${soul.trim()}\n\n## Background task\n\n${TASK_SYSTEM}${scheduled ? `\n\n${CHECK_SYSTEM}` : ''}\n\nWorkspace: ${config.workspace}.\n`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeFileSync(file, body, {mode: 0o600});
    return file;
  }

  async execute(row, controller) {
    let status = 'done', result = '', error = null, sessionId = null;
    try {
      const out = await this.run('main', {task: `background:${row.id}`, prompt: row.schedule_run ? this.schedules.checkPrompt(row.schedule_run, row.brief) : row.brief, cwd: config.workspace,
        systemFile: this.systemFile(Boolean(row.schedule_run)), mcp: 'main', chat: {...this.context(row), kind: 'task', taskId: row.id},
        stream: true, timeoutMs: (row.schedule_run ? 15 : 60) * 60_000, signal: controller.signal,
        onEvent: ev => { if (ev.kind === 'init') this.db.prepare('UPDATE bg_tasks SET session_id=? WHERE id=?').run(ev.sessionId, row.id); }});
      result = String(out.text || 'Task complete.').split('\n').slice(0, 8).join('\n');
      sessionId = out.sessionId || null;
    } catch (e) {
      status = 'failed'; error = row.schedule_run && e?.code === 'TIMEOUT' ? 'Timed out after 15 minutes.' : failureReason(e);
    }
    if (this.closing) return;
    if (controller.signal.aborted) { status = 'stopped'; result = ''; error = null; }
    await this.finish(row.id, status, result, error, sessionId);
  }

  async finish(id, status, result = '', error = null, sessionId = null, interrupted = false) {
    const now = Date.now();
    let row;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE bg_tasks SET status=?,finished=?,result=?,error=?,session_id=COALESCE(?,session_id) WHERE id=?')
        .run(status, now, result, error, sessionId, id);
      row = this.db.prepare('SELECT * FROM bg_tasks WHERE id=?').get(id);
      if (!row.schedule_run) {
        const note = `[Background task ${id} "${row.title}" ${status} at ${riyadhTime(now)}: ${(result || error || 'Stopped.').slice(0, 1200)}]`;
        this.db.prepare('UPDATE bg_task_notes SET note=? WHERE task_id=?').run(note, id);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.changed(id);
    if (row.schedule_run) {
      const simulation = this.context(row).simulation;
      if (simulation) this.schedules.stores.set(row.schedule_run, simulation);
      await this.schedules.finishTask(row.schedule_run, status, result, error);
      return;
    }
    const text = interrupted ? `Interrupted by a restart: ${row.title}. Say "retry ${id}" to run it again.`
      : status === 'done' ? `Done: ${row.title}\n${result}` : status === 'failed' ? `Failed: ${row.title}\n${error}` : `Stopped: ${row.title}`;
    try {
      if (row.channel === 'telegram') await sim.run(this.context(row).simulation, () => sendText(row.chat_id, text));
      else this.web.postTask(row, text);
    } catch { console.log('[tasks] result delivery failed'); }
  }

  async stop(chat, id) {
    const row = this.owned(chat, id);
    if (!row) return {status: 'failed', error: 'Task not found.'};
    if (!['queued', 'running'].includes(row.status)) return {status: 'failed', error: 'Task has already finished.'};
    if (this.running.has(row.id)) this.running.get(row.id).controller.abort();
    else {
      await this.finish(row.id, 'stopped');
      this.contexts.delete(row.id);
      this.pump();
    }
    return {status: 'stopped', id: row.id};
  }

  busySimulation(store) { return [...this.contexts.values()].some(c => c.simulation === store); }

  async recover() {
    for (const row of this.db.prepare("SELECT * FROM bg_tasks WHERE status IN ('running','queued') ORDER BY id").all()) {
      await this.finish(row.id, 'failed', '', 'service restarted', null, true);
      this.contexts.delete(row.id);
    }
  }

  shutdown() {
    this.closing = true;
    for (const state of this.running.values()) state.controller.abort();
  }
}
