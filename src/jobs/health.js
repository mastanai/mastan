// health (every 5 minutes, as root via mastan-me-health.service): check http://127.0.0.1:3100/healthz.
// Restarts mastan-me.service (and nothing else) when Telegram polling is stale (last_poll_age_s > 300)
// or /healthz failed twice in a row. At most one restart per 10 minutes. The run is recorded in
// job_runs as user mastan (so root never creates files in the data dir).
import {readFileSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {config} from '../config.js';

export const UNIT = 'mastan-me.service';
export const STALE_POLL_S = 300;
export const RESTART_GAP_MS = 10 * 60_000;

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
export const statePath = () => process.env.MASTAN_ME_HEALTH_STATE
  || (isRoot() ? '/run/mastan-me-health/state.json' : join(config.dataDir, 'jobs', 'health-state.json'));

function readState(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {fails: 0, last_restart: 0}; } }
function writeState(p, s) {
  mkdirSync(dirname(p), {recursive: true, mode: 0o700});
  writeFileSync(p + '.tmp', JSON.stringify(s), {mode: 0o600});
  renameSync(p + '.tmp', p);
}

export async function fetchHealth(port = config.port, timeoutMs = 5000) {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {signal: AbortSignal.timeout(timeoutMs)});
  if (res.status !== 200) throw new Error(`healthz HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error('healthz not ok');
  return j;
}

export function restartUnit() {
  execFileSync('systemctl', ['restart', UNIT], {stdio: 'ignore', timeout: 60_000});
}

// Pure decision + state update; restart and fetch are injected for tests.
export async function check({fetch: get = fetchHealth, restart = restartUnit, state: sp = statePath(), now = Date.now(), dry = process.env.MASTAN_ME_HEALTH_DRY === '1'} = {}) {
  const st = readState(sp);
  let reason = null, info = '';
  try {
    const h = await get();
    st.fails = 0;
    const age = h.telegram?.last_poll_age_s;
    info = `ok, uptime ${h.uptime_s}s, telegram poll age ${typeof age === 'number' ? age + 's' : 'n/a'}`;
    if (typeof age === 'number' && age > STALE_POLL_S) reason = `telegram poll stale (${age}s)`;
  } catch (e) {
    st.fails = (st.fails || 0) + 1;
    info = `healthz failed (${st.fails} in a row): ${String(e.message || e).slice(0, 80)}`;
    if (st.fails >= 2) reason = 'healthz failed twice';
  }
  let status = 'ok', detail = info;
  if (reason) {
    if (now - (st.last_restart || 0) < RESTART_GAP_MS) {
      status = 'partial'; detail = `${info}; ${reason}, restart held (last restart under 10 min ago)`;
    } else if (dry) {
      status = 'partial'; detail = `${info}; ${reason}, would restart ${UNIT} (dry run)`;
    } else {
      try { restart(); st.last_restart = now; st.fails = 0; status = 'partial'; detail = `${info}; ${reason}, restarted ${UNIT}`; }
      catch (e) { status = 'error'; detail = `${info}; ${reason}, restart failed: ${String(e.message || e).slice(0, 80)}`; }
    }
  } else if (st.fails === 1) status = 'partial';
  writeState(sp, st);
  return {status, detail, restarted: /restarted/.test(detail)};
}

// Record the run as mastan. As root this goes through setpriv into run.js --record.
export async function recordRun(status, detail) {
  if (!isRoot()) { const {record} = await import('./run.js'); return record('health', status, detail); }
  const node = process.execPath;
  const runJs = join(dirname(fileURLToPath(import.meta.url)), 'run.js');
  try {
    execFileSync('setpriv', ['--reuid=mastan', '--regid=mastan', '--init-groups', '--reset-env',
      'env', 'HOME=/var/lib/mastan/home', 'TZ=Asia/Riyadh', `MASTAN_ME_DATA=${config.dataDir}`,
      node, runJs, '--record', 'health', status, detail], {stdio: 'ignore', timeout: 20_000});
  } catch { /* recording is best effort; the journal has the line */ }
}

export async function main({force = false} = {}) {
  const out = await check();
  console.log(`[job health] ${out.status}: ${out.detail}`);
  // Quiet when healthy: from the timer, record runs that were not plain ok plus one ok run an hour.
  // By hand (or --force), always record.
  const byHand = force || !process.env.INVOCATION_ID;
  if (byHand || out.status !== 'ok' || new Date().getUTCMinutes() < 5) await recordRun(out.status, out.detail);
  if (out.status === 'error') process.exitCode = 1;
  return out;
}
