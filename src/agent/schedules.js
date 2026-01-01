// Durable claims precede delivery. A lost response is uncertain and is never sent again.
import {config} from '../config.js';
import {openDb} from '../db.js';
import {sim, sendText} from '../channels/telegram-api.js';
import {timing, parseRepeat, nextSlot, withinEnd, localStamp, localTime, localDate, dayBounds, inQuietHours} from './schedule-time.js';

export const schedulesOn = () => process.env.MASTAN_ME_SCHEDULES !== 'off';
export const SCHEDULE_NOTE = 'Reminders and recurring checks go through mastan-me-schedule; read skills/schedules/SKILL.md first. Confirm the exact local time back to Owner.';
export const CHECK_SYSTEM = 'This is a scheduled check. Compare with the previous result. If nothing changed that Owner would want to hear about, reply with exactly NO_CHANGE on the first line and a one-line summary on the second. Otherwise reply with what changed first. If the source could not be read (sign-in, error, page changed, access refused), say so plainly on the first line. The harness posts your final result; do not send a separate status or result message. Do not start tasks or schedules.';
const validId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;
const failed = error => ({status: 'failed', error});
const detailOf = row => { try { return JSON.parse(row.detail) || {}; } catch { return {}; } };
const riyadh = ms => localStamp(ms, 'Asia/Riyadh');

export function pendingScheduleNotes(db, channel, chatId) {
  return db.prepare(`SELECT n.run_id,n.note FROM schedule_notes n JOIN schedule_runs r ON r.id=n.run_id
    WHERE n.channel=? AND n.chat_id=? ORDER BY json_extract(r.detail,'$.note_order'),n.run_id`).all(channel, String(chatId));
}
export function clearScheduleNotes(db, notes) {
  for (const n of notes) db.prepare('DELETE FROM schedule_notes WHERE run_id=?').run(n.run_id);
}

export class Schedules {
  constructor({db = openDb(), tasks, web = null, send = sendText, now = Date.now} = {}) {
    this.db = db;
    this.tasks = tasks;
    this.web = web;
    this.send = send;
    this.now = now;
    this.stores = new Map();
    this.delivering = new Set();
    this.ticking = null;
    this.closing = false;
    if (tasks) tasks.schedules = this;
  }

  owned(chat, id) {
    if (!validId(id)) return null;
    return this.db.prepare("SELECT * FROM schedules WHERE id=? AND user=? AND channel=? AND chat_id=? AND status!='deleted'")
      .get(Number(id), chat.user, chat.channel, String(chat.chatId));
  }
  list(chat) {
    return this.db.prepare(`SELECT id,kind,title,status,next_run,repeat,tz FROM schedules
      WHERE user=? AND channel=? AND chat_id=? AND status!='deleted' ORDER BY id`)
      .all(chat.user, chat.channel, String(chat.chatId)).map(r => ({...r, next_run_local: r.next_run == null ? null : localStamp(r.next_run, r.tz)}));
  }
  listText(chat) {
    const rows = this.list(chat).filter(r => ['active', 'paused'].includes(r.status));
    return rows.length ? rows.map(r => `${r.id}. ${r.kind}: ${r.title} (${r.status}), ${r.next_run_local || 'no next run'}, ${r.repeat || 'one-off'}`).join('\n') : 'No active or paused schedules in this chat.';
  }
  capacity(user, kind) {
    const rows = this.db.prepare("SELECT kind,count(*) AS n FROM schedules WHERE user=? AND status='active' GROUP BY kind").all(user);
    if (rows.reduce((n, r) => n + r.n, 0) >= 50) return 'You already have 50 active schedules. Pause or delete one first.';
    if (kind === 'check' && (rows.find(r => r.kind === 'check')?.n || 0) >= 10) return 'You already have 10 active checks. Pause or delete one first.';
    return null;
  }

  async request(chat, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return failed('Bad schedule request.');
    const actions = {add: ['action', 'kind', 'title', 'text', 'brief', 'at', 'in', 'repeat', 'until', 'times', 'tz'],
      list: ['action'], pause: ['action', 'id'], resume: ['action', 'id'], delete: ['action', 'id'], run: ['action', 'id']};
    const keys = Object.hasOwn(actions, input.action) ? actions[input.action] : null;
    if (!keys || Object.keys(input).some(k => !keys.includes(k))) return failed('Bad schedule request.');
    if (chat.kind === 'task' && input.action !== 'list') return {status: 'unavailable', error: 'A background task can only list schedules.'};
    if (input.action === 'list') return {status: 'ok', schedules: this.list(chat)};
    if (['add', 'run', 'resume'].includes(input.action) && chat.channel === 'whatsapp') return {status: 'unavailable', error: 'Schedules are not on WhatsApp yet. Owner can set them on Telegram or the web chat.'};
    if (['add', 'run', 'resume'].includes(input.action) && (!schedulesOn() || this.closing)) return {status: 'unavailable', error: 'Schedules are disabled or the service is stopping.'};
    if (input.action === 'add') return this.add(chat, input);
    const row = this.owned(chat, input.id);
    if (!row) return failed('Schedule not found.');
    if (input.action === 'run') {
      const run = this.claim(row.id, true);
      if (run) await this.deliver(run.id);
      return {status: 'ok', id: row.id};
    }
    if (input.action === 'resume') {
      if (row.status === 'active') return {status: 'ok', id: row.id, next_run_local: localStamp(row.next_run, row.tz)};
      const cap = this.capacity(chat.user, row.kind);
      if (cap) return failed(cap);
      if (row.times && row.runs >= row.times) return failed('This schedule has reached --times. Add a new schedule.');
      const now = this.now(), repeat = parseRepeat(row.repeat, row.kind);
      const next = row.next_run > now ? row.next_run : repeat ? nextSlot(repeat, now, row.tz, row.next_run ?? now) : now;
      if (!withinEnd(next, row.until, row.tz)) return failed('This schedule has reached --until. Add a new schedule.');
      this.db.prepare("UPDATE schedules SET status='active',next_run=?,fails=0 WHERE id=?").run(next, row.id);
      return {status: 'ok', id: row.id, next_run_local: localStamp(next, row.tz)};
    }
    this.db.prepare('UPDATE schedules SET status=? WHERE id=?').run(input.action === 'pause' ? 'paused' : 'deleted', row.id);
    return {status: 'ok', id: row.id};
  }

  add(chat, input) {
    if (!['reminder', 'check'].includes(input.kind)) return failed('Choose --remind or --check.');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || /[\r\n]/.test(input.title)) return failed('Give a title up to 120 characters with no newlines.');
    if (input.kind === 'reminder' && (input.brief !== undefined || input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 2000))) return failed('Reminder text accepts up to 2,000 characters, without a check brief.');
    if (input.kind === 'check' && (input.text !== undefined || typeof input.brief !== 'string' || !input.brief.trim() || input.brief.length > 20_000)) return failed('Give a check brief up to 20,000 characters, without reminder text.');
    const now = this.now(), tz = input.tz ?? config.tz;
    let next;
    try { next = timing(input, now, tz); } catch (e) { return failed(e instanceof RangeError ? 'Use a valid IANA time zone.' : e.message); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cap = this.capacity(chat.user, input.kind);
      if (cap) { this.db.exec('ROLLBACK'); return failed(cap); }
      const id = Number(this.db.prepare(`INSERT INTO schedules(user,channel,chat_id,kind,title,text,brief,repeat,tz,next_run,until,times,simulated,created)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(chat.user, chat.channel, String(chat.chatId), input.kind, input.title.trim(), input.text ?? null,
        input.brief ?? null, input.repeat ?? null, tz, next, input.until ?? null, input.times ?? null, chat.simulation ? 1 : 0, now).lastInsertRowid);
      this.db.exec('COMMIT');
      return {status: 'ok', id, next_run_local: localStamp(next, tz)};
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  claim(id, force = false) {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
      if (!row || row.status === 'deleted' || !force && (row.status !== 'active' || row.next_run == null || row.next_run > now)) { this.db.exec('COMMIT'); return null; }
      const due = force ? now : row.next_run;
      const inserted = this.db.prepare("INSERT OR IGNORE INTO schedule_runs(schedule_id,due,state,created) VALUES(?,?,'claimed',?)").run(id, due, now);
      if (!inserted.changes) { this.db.exec('COMMIT'); return null; }
      const repeat = parseRepeat(row.repeat, row.kind);
      const next = repeat ? force && row.next_run > now ? row.next_run : nextSlot(repeat, now, row.tz, row.next_run ?? due) : null;
      const ended = !withinEnd(next, row.until, row.tz) || row.times && row.runs + 1 >= row.times;
      const status = ended ? 'done' : row.status;
      this.db.prepare('UPDATE schedules SET next_run=?,runs=runs+1,status=? WHERE id=?').run(ended ? null : next, status, id);
      this.db.exec('COMMIT');
      return this.runRow(Number(inserted.lastInsertRowid));
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  runRow(id) { return this.db.prepare('SELECT * FROM schedule_runs WHERE id=?').get(id); }
  schedule(id) { return this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id); }
  setRun(id, state, detail) {
    this.db.prepare('UPDATE schedule_runs SET state=?,detail=COALESCE(?,detail) WHERE id=?').run(state, detail === undefined ? null : JSON.stringify(detail), id);
    console.log(`[schedules] run ${id} ${state}`);
  }
  store(run, row) {
    if (!row.simulated) return undefined;
    if (!this.stores.has(run.id)) this.stores.set(run.id, {calls: detailOf(run).calls || []});
    return this.stores.get(run.id);
  }
  capture(run, row, detail = detailOf(run)) {
    const store = this.store(run, row);
    return store ? {...detail, calls: store.calls} : detail;
  }
  note(run, row, result) {
    const now = this.now();
    const text = row.kind === 'reminder' ? `[Reminder ${row.id} "${row.title}" sent at ${riyadh(now)}]`
      : `[Check ${row.id} "${row.title}" at ${riyadh(now)}: ${result.slice(0, 600)}]`;
    const last = this.db.prepare(`SELECT max(json_extract(r.detail,'$.note_order')) AS n FROM schedule_notes n JOIN schedule_runs r ON r.id=n.run_id
      WHERE n.channel=? AND n.chat_id=?`).get(row.channel, row.chat_id).n || 0;
    const detail = {...detailOf(this.runRow(run.id)), note_order: Math.max(now, last + 1)};
    this.db.prepare('UPDATE schedule_runs SET detail=? WHERE id=?').run(JSON.stringify(detail), run.id);
    this.db.prepare('INSERT OR REPLACE INTO schedule_notes VALUES(?,?,?,?)').run(run.id, row.channel, row.chat_id, text);
    this.db.prepare(`DELETE FROM schedule_notes WHERE channel=? AND chat_id=? AND run_id NOT IN
      (SELECT n.run_id FROM schedule_notes n JOIN schedule_runs r ON r.id=n.run_id WHERE n.channel=? AND n.chat_id=?
        ORDER BY json_extract(r.detail,'$.note_order') DESC,n.run_id DESC LIMIT 5)`)
      .run(row.channel, row.chat_id, row.channel, row.chat_id);
  }

  post(run, row, text, quiet = false) {
    const store = this.store(run, row);
    if (row.simulated) {
      // Fake providers also stay behind this boundary, even if they do not implement sim.
      store.calls.push({method: row.channel === 'telegram' ? 'sendMessage' : 'postSchedule', text,
        ...(quiet ? {disable_notification: true} : {})});
      console.log(`[schedules] simulated delivery ${run.id}`);
    } else if (row.channel === 'telegram') return sim.run(undefined, () => this.send(row.chat_id, text, {disable_notification: quiet}));
    else return this.web.postSchedule(row, text);
  }

  async deliver(id) {
    if (this.closing || !schedulesOn() || this.delivering.has(id)) return;
    const run = this.runRow(id);
    if (!run || !['claimed', 'failed'].includes(run.state)) return;
    const row = this.schedule(run.schedule_id);
    if (row.kind === 'check') return this.deliverCheck(run, row);
    this.delivering.add(id);
    try {
      const detail = detailOf(run), attempts = (detail.attempts || 0) + 1;
      const late = this.now() - run.due > 10 * 60_000 ? ` (late, was due ${localTime(run.due, row.tz)})` : '';
      const text = `Reminder: ${row.title}${late}${row.text ? `\n${row.text}` : ''}`;
      this.setRun(id, 'sending', {...detail, attempts, retry_at: null});
      let transaction = false, delivered = false;
      try {
        // A web post and its receipt commit together. Telegram commits the receipt after its response.
        if (row.channel === 'web' && !row.simulated) { this.db.exec('BEGIN IMMEDIATE'); transaction = true; }
        if (row.channel === 'web') this.post(run, row, text);
        else await this.post(run, row, text);
        delivered = true;
        if (!transaction) { this.db.exec('BEGIN IMMEDIATE'); transaction = true; }
        this.setRun(id, 'sent', this.capture(run, row, {attempts}));
        this.db.prepare('UPDATE schedules SET last_run=? WHERE id=?').run(this.now(), row.id);
        this.note(run, row);
        this.db.exec('COMMIT'); transaction = false;
      } catch (e) {
        if (transaction) this.db.exec('ROLLBACK');
        const state = e.bodyWritten || delivered ? 'uncertain' : 'failed';
        this.setRun(id, state, this.capture(run, row, {attempts, ...(state === 'failed' && attempts < 3 ? {retry_at: this.now() + 60_000} : {})}));
      }
    } finally { this.delivering.delete(id); this.stores.delete(id); }
  }

  quiet(row) {
    let value;
    try { value = JSON.parse(this.db.prepare('SELECT value FROM kv WHERE key=?').get(`quiet:${row.user}`)?.value || 'null'); } catch {}
    return inQuietHours(this.now(), row.tz, value || undefined);
  }
  async deliverCheck(run, row) {
    if (run.task_id) return;
    const overlap = this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN bg_tasks t ON t.id=r.task_id
      WHERE r.schedule_id=? AND t.status IN ('queued','running') LIMIT 1`).get(row.id);
    if (overlap) { this.setRun(run.id, 'skipped', {reason: 'overlap'}); return; }
    const now = this.now(), [from, to] = dayBounds(now, row.tz);
    const count = this.db.prepare(`SELECT count(*) AS n FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id
      WHERE s.user=? AND s.kind='check' AND r.created>=? AND r.created<? AND r.task_id IS NOT NULL`).get(row.user, from, to).n;
    if (count >= 48) {
      this.setRun(run.id, 'skipped', {reason: 'daily limit'});
      const key = `schedule-limit:${row.user}:${localDate(now, row.tz)}`;
      const first = this.db.prepare('INSERT OR IGNORE INTO kv VALUES(?,?,?)').run(key, 'true', now).changes;
      if (first) {
        try { await this.post(run, row, 'Daily limit reached: 48 check runs. Later checks today will be skipped.', this.quiet(row)); }
        catch { console.log(`[schedules] notice ${run.id} failed`); }
        this.setRun(run.id, 'skipped', this.capture(run, row, {reason: 'daily limit'}));
        this.stores.delete(run.id);
      }
      return;
    }
    const chat = {user: row.user, channel: row.channel, chatId: row.chat_id, simulation: this.store(run, row)};
    const out = this.tasks?.start(chat, {title: row.title, brief: row.brief}, {scheduleRun: run.id});
    if (!out || !['queued', 'running'].includes(out.status)) await this.finishTask(run.id, 'failed', '', 'Background tasks unavailable.');
  }

  checkPrompt(id, brief) {
    const row = this.schedule(this.runRow(id).schedule_id);
    const previous = row.last_result == null ? 'none, this is the first run' : row.last_result.slice(0, 1200);
    return `${brief}\n\nPrevious result (${riyadh(row.last_run ?? this.now())}): ${previous}`;
  }

  async finishTask(id, status, result = '', error = null) {
    const run = this.runRow(id);
    if (!run || run.state !== 'claimed') return;
    const row = this.schedule(run.schedule_id), now = this.now();
    if (status !== 'done') {
      this.db.exec('BEGIN IMMEDIATE');
      let pause;
      try {
        this.setRun(id, 'failed', this.capture(run, row, {reason: error === 'Timed out after 15 minutes.' ? 'timeout' : 'task failed'}));
        pause = row.fails === 2 && row.status !== 'deleted';
        this.db.prepare('UPDATE schedules SET fails=fails+1,status=CASE WHEN ? THEN ? ELSE status END WHERE id=?').run(pause ? 1 : 0, 'paused', row.id);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      if (pause) {
        const reason = error === 'Timed out after 15 minutes.' ? 'timed out' : error === 'service restarted' ? 'service restarted' : 'could not finish';
        try { await this.post(run, row, `Paused check ${row.id} "${row.title}" after 3 failed runs: ${reason}. Say "resume ${row.id}" to start it again.`, this.quiet(row)); }
        catch { console.log(`[schedules] pause notice ${id} failed`); }
        this.setRun(id, 'failed', this.capture(run, row, {reason}));
      }
    } else {
      const lines = result.split(/\r?\n/), quiet = lines[0] === 'NO_CHANGE';
      const summary = quiet ? lines[1] || '' : lines.slice(0, 8).join('\n');
      this.db.prepare('UPDATE schedules SET fails=0,last_result=?,last_run=? WHERE id=?').run(summary, now, row.id);
      if (quiet) this.setRun(id, 'quiet', this.capture(run, row));
      else {
        this.setRun(id, 'sending');
        let transaction = false, delivered = false;
        try {
          if (row.channel === 'web' && !row.simulated) { this.db.exec('BEGIN IMMEDIATE'); transaction = true; }
          const text = `Check: ${row.title}\n${summary}`;
          if (row.channel === 'web') this.post(run, row, text, this.quiet(row));
          else await this.post(run, row, text, this.quiet(row));
          delivered = true;
          if (!transaction) { this.db.exec('BEGIN IMMEDIATE'); transaction = true; }
          this.setRun(id, 'posted', this.capture(run, row));
          this.note(run, row, summary);
          this.db.exec('COMMIT'); transaction = false;
        } catch (e) {
          if (transaction) this.db.exec('ROLLBACK');
          this.setRun(id, e.bodyWritten || delivered ? 'uncertain' : 'failed', this.capture(run, row, {reason: 'post failed'}));
        }
      }
    }
    this.stores.delete(id);
  }

  tick() {
    if (!schedulesOn() || this.closing) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.doTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async doTick() {
    for (const row of this.db.prepare("SELECT id FROM schedules WHERE status='active' AND next_run<=? ORDER BY next_run,id").all(this.now())) {
      if (this.closing || !schedulesOn()) return;
      this.claim(row.id);
    }
    for (const run of this.db.prepare("SELECT * FROM schedule_runs WHERE state IN ('claimed','failed') ORDER BY id").all()) {
      const detail = detailOf(run);
      if (run.state === 'claimed' && !run.task_id || run.state === 'failed' && detail.retry_at != null && detail.retry_at <= this.now()) await this.deliver(run.id);
    }
  }
  async recover() {
    for (const run of this.db.prepare("SELECT id FROM schedule_runs WHERE state='sending'").all()) this.setRun(run.id, 'uncertain');
    for (const run of this.db.prepare(`SELECT r.id,t.status,t.result,t.error FROM schedule_runs r JOIN bg_tasks t ON t.id=r.task_id
      WHERE r.state='claimed' AND t.status NOT IN ('queued','running') ORDER BY r.id`).all()) await this.finishTask(run.id, run.status, run.result || '', run.error);
    if (schedulesOn()) await this.tick();
  }
  async start() {
    if (this.timer || this.closing) return;
    if (schedulesOn()) this.timer = setInterval(() => { this.tick().catch(() => console.log('[schedules] tick failed')); }, 15_000).unref();
    await this.recover();
  }
  shutdown() { this.closing = true; clearInterval(this.timer); }

  adminList(id) {
    return id === undefined ? this.db.prepare('SELECT id,user,channel,chat_id,kind,title,status,next_run,repeat,tz FROM schedules ORDER BY id').all()
      : this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY id').all(id).map(r => ({...r, detail: this.schedule(r.schedule_id).simulated ? detailOf(r) : null}));
  }
  fire(id) {
    if (!schedulesOn() || this.closing) return {status: 'unavailable', error: 'Schedules are disabled or the service is stopping.'};
    if (!validId(id)) return failed('Schedule not found.');
    const changed = this.db.prepare("UPDATE schedules SET next_run=? WHERE id=? AND status!='deleted'").run(this.now(), Number(id)).changes;
    return changed ? {status: 'ok', id: Number(id)} : failed('Schedule not found.');
  }
}
