// One SQLite file for auth, chat sessions, tasks, job runs and small key-values.
// Atlas content never lives here; it is markdown in the workspace git repo.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {config} from './config.js';

let db;
export function openDb(path = config.dbPath) {
  if (db) return db;
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
    -- web auth (same shape as the Topic Board so passkey rows copy across)
    CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS credentials(handle TEXT UNIQUE NOT NULL, id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, created INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'local');
    CREATE TABLE IF NOT EXISTS sessions(handle TEXT UNIQUE NOT NULL, hash TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL, expires INTEGER NOT NULL, csrf TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS challenges(hash TEXT PRIMARY KEY, kind TEXT NOT NULL,
      challenge TEXT NOT NULL, enrollment TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
    -- agent chat sessions: one Claude session per channel chat
    CREATE TABLE IF NOT EXISTS chats(channel TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT,
      model TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel, chat_id));
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, chat_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, summary TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS bg_tasks(id INTEGER PRIMARY KEY, user TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL,
      title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, finished INTEGER,
      result TEXT, error TEXT, session_id TEXT);
    CREATE INDEX IF NOT EXISTS bg_tasks_queue ON bg_tasks(status, user, id);
    CREATE TABLE IF NOT EXISTS bg_task_notes(task_id INTEGER PRIMARY KEY, note TEXT, simulated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS schedules(id INTEGER PRIMARY KEY, user TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT, brief TEXT, repeat TEXT, tz TEXT NOT NULL, next_run INTEGER,
      until TEXT, times INTEGER, runs INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', last_result TEXT, last_run INTEGER, simulated INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, next_run);
    CREATE TABLE IF NOT EXISTS schedule_runs(id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL, due INTEGER NOT NULL,
      state TEXT NOT NULL, task_id INTEGER, detail TEXT, created INTEGER NOT NULL, UNIQUE(schedule_id, due));
    CREATE TABLE IF NOT EXISTS schedule_notes(run_id INTEGER PRIMARY KEY, channel TEXT NOT NULL, chat_id TEXT NOT NULL, note TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, started INTEGER NOT NULL,
      finished INTEGER, status TEXT NOT NULL, detail TEXT);
    -- telegram message id -> question id, so a reply to a question message answers it
    CREATE TABLE IF NOT EXISTS tg_questions(message_id INTEGER PRIMARY KEY, question_id TEXT NOT NULL, sent INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, user TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, stored_path TEXT NOT NULL,
      caption TEXT, created INTEGER NOT NULL, status TEXT NOT NULL, receipt TEXT, error TEXT);
    -- web chat: threads per signed-in identity (owner, operator), each with its own agent session (chat_id who#thread);
    -- attachments live in the workspace inbox
    CREATE TABLE IF NOT EXISTS web_threads(id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, updated INTEGER NOT NULL, archived INTEGER);
    CREATE INDEX IF NOT EXISTS web_threads_who ON web_threads(who, archived, updated);
    CREATE TABLE IF NOT EXISTS web_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', files TEXT, status TEXT NOT NULL DEFAULT 'done', created INTEGER NOT NULL, finished INTEGER, thread INTEGER);
    CREATE INDEX IF NOT EXISTS web_messages_who ON web_messages(who, id);
    -- Owner's model choice for one chat (/model deepseek); no row = the main role. Survives /new.
    CREATE TABLE IF NOT EXISTS chat_models(channel TEXT NOT NULL, chat_id TEXT NOT NULL, model TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(channel, chat_id));`);
  // Databases from before threads: add the column, then index it. WebChat files the old rows into a General thread.
  if (!db.prepare('PRAGMA table_info(web_messages)').all().some(c => c.name === 'thread')) db.exec('ALTER TABLE web_messages ADD COLUMN thread INTEGER');
  if (!db.prepare('PRAGMA table_info(web_messages)').all().some(c => c.name === 'task')) db.exec('ALTER TABLE web_messages ADD COLUMN task INTEGER');
  if (!db.prepare('PRAGMA table_info(web_messages)').all().some(c => c.name === 'schedule')) db.exec('ALTER TABLE web_messages ADD COLUMN schedule INTEGER');
  if (!db.prepare('PRAGMA table_info(web_messages)').all().some(c => c.name === 'client_id')) db.exec('ALTER TABLE web_messages ADD COLUMN client_id TEXT; ALTER TABLE web_messages ADD COLUMN quote_id INTEGER');
  if (!db.prepare('PRAGMA table_info(web_threads)').all().some(c => c.name === 'pinned')) db.exec('ALTER TABLE web_threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; ALTER TABLE web_threads ADD COLUMN read_id INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(bg_tasks)').all().some(c => c.name === 'schedule_run')) db.exec('ALTER TABLE bg_tasks ADD COLUMN schedule_run INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bg_tasks_schedule_run ON bg_tasks(schedule_run) WHERE schedule_run IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS web_messages_thread ON web_messages(thread, id)');
  return db;
}

export function kvGet(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM kv WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function kvSet(key, value) {
  openDb().prepare('INSERT INTO kv VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated')
    .run(key, JSON.stringify(value), Date.now());
}

export function jobStart(job) {
  return Number(openDb().prepare("INSERT INTO job_runs(job,started,status) VALUES(?,?,'running')").run(job, Date.now()).lastInsertRowid);
}
export function jobEnd(id, status, detail = '') {
  openDb().prepare('UPDATE job_runs SET finished=?, status=?, detail=? WHERE id=?').run(Date.now(), status, String(detail).slice(0, 2000), id);
}
export function lastJobRuns() {
  return openDb().prepare(`SELECT job, max(started) AS started, status, finished, detail FROM job_runs GROUP BY job ORDER BY job`).all();
}
