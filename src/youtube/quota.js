// Daily unit ledger for this tool. The API key is shared with the website content loop (10,000 units a day
// in total), so this tool keeps to its own cap and leaves the rest alone. The ledger is a small JSON file
// keyed by the Asia/Riyadh date, written atomically; a lock file keeps two runs from losing an update.
import {readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {YouTubeError} from './errors.js';

export const DAILY_CAP = 2000;
export const TZ = 'Asia/Riyadh';
export const SEARCH_COST = 100;
const KEEP_DAYS = 14;
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 3000;

export function riyadhDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}

export function stateDir(env = process.env) {
  return env.MASTAN_ME_STATE_DIR || join(env.MASTAN_ME_DATA || '/var/lib/mastan-me', 'state');
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class QuotaLedger {
  constructor({dir = stateDir(), cap = DAILY_CAP, now = () => new Date()} = {}) {
    this.dir = dir;
    this.cap = cap;
    this.now = now;
    this.file = join(dir, 'youtube-quota.json');
    this.lock = join(dir, 'youtube-quota.lock');
  }

  #read() {
    let text;
    try { text = readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw this.#broken('cannot read');
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
      return data;
    } catch { throw this.#broken('is not valid JSON'); }
  }

  #broken(why) {
    return new YouTubeError('quota_cap', `The daily budget file ${this.file} ${why}, so no YouTube calls are made. Tell Owner (fix or delete the file).`);
  }

  // {day, used, cap, remaining}; read only, never creates anything.
  usage() {
    const day = riyadhDay(this.now());
    const used = Number(this.#read()[day]?.units) || 0;
    return {day, used, cap: this.cap, remaining: Math.max(0, this.cap - used)};
  }

  // Reserve units before the request goes out. Throws quota_cap when the next call would pass the cap.
  reserve(units) {
    const release = this.#acquire();
    try {
      const day = riyadhDay(this.now());
      const data = this.#read();
      const entry = data[day] || {units: 0, requests: 0};
      const used = Number(entry.units) || 0;
      if (used + units > this.cap) {
        throw new YouTubeError('quota_cap', `Daily YouTube budget for this tool is used: ${used} of ${this.cap} units today, this call needs ${units}. It resets at midnight Riyadh time. Ask Owner before going past it.`);
      }
      data[day] = {units: used + units, requests: (Number(entry.requests) || 0) + 1, updated: new Date(this.now()).toISOString()};
      for (const k of Object.keys(data).sort().slice(0, -KEEP_DAYS)) delete data[k];
      this.#write(data);
      return {day, used: used + units, cap: this.cap};
    } finally { release(); }
  }

  #write(data) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
      renameSync(tmp, this.file);
    } catch {
      try { unlinkSync(tmp); } catch {}
      throw new YouTubeError('quota_cap', `Cannot write the daily budget file ${this.file}, so no YouTube calls are made. Tell Owner.`);
    }
  }

  #acquire() {
    try { mkdirSync(this.dir, {recursive: true, mode: 0o700}); } catch {
      throw new YouTubeError('quota_cap', `Cannot create ${this.dir} for the daily budget file, so no YouTube calls are made. Tell Owner.`);
    }
    const started = Date.now();
    for (;;) {
      try {
        closeSync(openSync(this.lock, 'wx', 0o600));
        return () => { try { unlinkSync(this.lock); } catch {} };
      } catch (e) {
        if (e.code !== 'EEXIST') throw new YouTubeError('quota_cap', 'Cannot lock the daily budget file, so no YouTube calls are made. Tell Owner.');
        let age = 0;
        try { age = Date.now() - statSync(this.lock).mtimeMs; } catch {}
        if (age > LOCK_STALE_MS || Date.now() - started > LOCK_WAIT_MS) { try { unlinkSync(this.lock); } catch {} continue; }
        sleep(25);
      }
    }
  }
}
