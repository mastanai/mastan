// mastan-me-job <name> [--force]: run one job and record it in job_runs (src/db.js).
// Jobs: morning-set, consolidate, board-sync, backup, health, request-prs, nightly (= consolidate then backup).
// Each job module exports run(opts) -> {status: 'ok'|'partial'|'skipped', detail}. Errors -> status 'error'.
// Logs say what happened, never atlas content or secrets.
import {openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../config.js';

export const JOBS = ['morning-set', 'consolidate', 'board-sync', 'backup', 'health', 'request-prs'];
const here = dirname(fileURLToPath(import.meta.url));

const log = (job, msg) => console.log(`[job ${job}] ${msg}`);

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// One run per job at a time. A stale lock (dead pid) is taken over.
export function lock(dir, name) {
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const p = join(dir, `${name}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(p, 'wx', 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd);
      return () => { try { unlinkSync(p); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(p, 'utf8').trim());
      if (pid && alive(pid)) return null;
      try { unlinkSync(p); } catch {}
    }
  }
  return null;
}

// Record a run as the current user (mastan). Root callers (health) go through recordAsMastan.
export async function record(name, status, detail) {
  const {jobStart, jobEnd} = await import('../db.js');
  const id = jobStart(name);
  jobEnd(id, status, detail);
  appendRunLog(name, status, detail);
}

function appendRunLog(name, status, detail) {
  try {
    const p = join(config.workspace, 'jobs', 'runs.log');
    mkdirSync(dirname(p), {recursive: true});
    appendFileSync(p, `${new Date().toISOString()} ${name} ${status} ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}\n`, {mode: 0o600});
  } catch {}
}

export async function runJob(name, {force = false} = {}) {
  if (!JOBS.includes(name)) throw new Error(`Unknown job ${name}. Jobs: ${[...JOBS, 'nightly'].join(', ')}`);
  const mod = await import(join(here, `${name}.js`));
  if (name === 'health') return mod.main({force}); // runs as root, records through setpriv
  const unlock = lock(join(config.dataDir, 'jobs'), name);
  if (!unlock) { log(name, 'already running, skipped'); return {status: 'skipped', detail: 'already running'}; }
  const {jobStart, jobEnd} = await import('../db.js');
  const id = jobStart(name);
  const started = Date.now();
  let out;
  try {
    out = await mod.run({force, log: m => log(name, m)});
  } catch (e) {
    out = {status: 'error', detail: String(e.message || e).slice(0, 500)};
  } finally {
    unlock();
  }
  out.detail = `${out.detail || ''} (${Math.round((Date.now() - started) / 1000)} s)`.trim();
  jobEnd(id, out.status, out.detail);
  appendRunLog(name, out.status, out.detail);
  log(name, `${out.status}: ${out.detail}`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  // Internal: health (root) records its run as mastan through this entry point.
  if (args[0] === '--record') { await record(args[1], args[2], args.slice(3).join(' ')); return; }
  const force = args.includes('--force');
  const name = args.find(a => !a.startsWith('--'));
  if (!name) { console.log(`Usage: mastan-me-job <${[...JOBS, 'nightly'].join('|')}> [--force]`); process.exitCode = 2; return; }
  const names = name === 'nightly' ? ['consolidate', 'backup'] : [name];
  let failed = false;
  for (const n of names) {
    const out = await runJob(n, {force});
    if (out.status === 'error') failed = true;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(`[job] ${String(e.message || e).slice(0, 300)}`); process.exitCode = 1; });
}
