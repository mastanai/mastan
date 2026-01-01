// The agent can request work; only a device assertion can authorize execution.
import {DatabaseSync} from 'node:sqlite';
import {appendFileSync, chmodSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, randomBytes} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {spawn} from 'node:child_process';
import net from 'node:net';

// Owner's passkeys belong to the parent domain (MASTAN_ME_RP_ID=mastan.ai); the page itself is served from me.example.com.
export const RP_ID = 'mastan.ai';
export const ORIGIN = 'https://me.example.com';
export const OUTPUT_LIMIT = 50 * 1024;
export const KEY = '/var/lib/mastan-ops/ssh/client_ed25519';
export const KNOWN_HOSTS = '/opt/mastan-fleet/known_hosts';
export const KEY_DIR = '/var/lib/mastan-ops/ssh';
// The only servers a no-tap window can ever open on. dev-01 holds the ops keys, so root there is root everywhere;
// prod-01 and client servers carry other people's data. A config file cannot widen this.
export const WINDOW_SERVERS = new Set(['mastan-server']);
export const WINDOW_MAX_MIN = 15;
// Auto-approve: one passkey assertion opens a lease; its token lives only in Owner's browser (HttpOnly cookie) and as a
// hash here, so neither the agent nor a forged web session can use it. dev-01 is out for the same reason as windows.
export const AUTO_EXCLUDED = new Set(['dev-01']);
export const LEASE_MS = 30 * 86400_000;
const LEASE = /^[A-Za-z0-9_-]{43}$/;
const leaseHash = value => createHash('sha256').update(value).digest('hex');
// Very destructive commands keep their card even with auto-approve on. This catches the model's plain mistakes.
// It is a text match, not a boundary: a determined script can hide from it.
export const DESTRUCTIVE = [
  ['filesystem wipe', /\b(?:mkfs(?:\.\w+)?|wipefs|blkdiscard|shred)\b/],
  ['raw disk write', /\bdd\b[^;|&\n]*\bof=\/dev\/|>\s*\/dev\/(?:sd|vd|nvme|md)/],
  ['volume removal', /\b(?:lvremove|vgremove|pvremove)\b|\bzpool\s+destroy\b/],
  ['find and delete from the top', /\bfind\s+\/(?:\s|\S{0,12}\s).*-delete\b/],
  ['dropped database or table', /\bdrop\s+(?:database|schema|table)\b|\btruncate\s+table\b|\bdropdb\b|\bflushall\b/i],
  ['server or volume deletion', /\bhcloud\b[^;|&\n]*\b(?:delete|rebuild)\b/],
  ['docker data removal', /\bdocker\s+(?:volume\s+(?:rm|prune)|system\s+prune)\b/],
];
function rmWipes(text) {
  return text.split(/[;&|\n()]+/).some(part => {
    const words = part.trim().split(/\s+/), at = words.findIndex(w => w === 'rm' || w.endsWith('/rm'));
    if (at < 0) return false;
    const args = words.slice(at + 1), targets = args.filter(a => !a.startsWith('-')).map(a => a.replace(/^["']|["']$/g, ''));
    if (targets.some(t => /\.(?:sqlite3?|db)$/.test(t))) return true;
    if (!args.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive')) return false;
    return targets.some(t => t.startsWith('$') || t.startsWith('/') && t.replace(/\/\*?$/, '').split('/').filter(Boolean).length <= (t.startsWith('/var/lib/') ? 3 : 2));
  });
}
export function destructive(command) {
  const decoded = [...command.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].map(m => Buffer.from(m[0], 'base64').toString('utf8'));
  for (const text of [command, ...decoded]) {
    if (rmWipes(text)) return 'recursive delete of a top-level or data folder';
    const hit = DESTRUCTIVE.find(([, pattern]) => pattern.test(text));
    if (hit) return hit[0];
  }
  return null;
}
export class Refused extends Error {}
const need = (yes, message) => { if (!yes) throw new Refused(message); };
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const ID = /^[a-f0-9]{32}$/;
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function redact(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]+|ghp_[\w]+|github_pat_[\w]+|\d{6,}:[\w-]{20,})/g, '[redacted]')
    .replace(/\b((?:token|password|secret|key)\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi, '$1[redacted]');
}

export function capOutput(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= OUTPUT_LIMIT) return text;
  const marker = '\n[... output capped ...]\n';
  const half = Math.floor((OUTPUT_LIMIT - Buffer.byteLength(marker) - 8) / 2);
  return bytes.subarray(0, half).toString('utf8') + marker + bytes.subarray(-half).toString('utf8');
}

class HeadTail {
  constructor() { this.head = Buffer.alloc(0); this.tail = Buffer.alloc(0); this.size = 0; this.half = Math.floor((OUTPUT_LIMIT - 40) / 2); }
  write(text) {
    const bytes = Buffer.from(text); this.size += bytes.length;
    if (this.head.length < this.half) this.head = Buffer.concat([this.head, bytes.subarray(0, this.half - this.head.length)]);
    this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.half);
  }
  value() {
    if (this.size <= this.half) return this.head.toString('utf8');
    if (this.size <= 2 * this.half) return Buffer.concat([this.head, this.tail.subarray(-(this.size - this.head.length))]).toString('utf8');
    return capOutput(this.head.toString('utf8') + '\n[... output capped ...]\n' + this.tail.toString('utf8'));
  }
}

// Redact complete lines before retaining a bounded head and tail. Very long
// lines retain bounded head/tail too, but are discarded if any secret is detected.
export class OutputCapture {
  constructor() {
    this.decoder = new StringDecoder('utf8'); this.line = ''; this.output = new HeadTail(); this.longCapture = null;
    this.privateKey = false; this.longLine = false; this.longSensitive = false; this.scan = '';
  }
  scanKeyState(text) {
    const markers = [...text.matchAll(/-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g)];
    if (markers.length) this.privateKey = markers.at(-1)[1] === 'BEGIN';
  }
  write(chunk) {
    const text = this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      if (this.longLine) {
        const scan = this.scan + part;
        this.longSensitive ||= redact(scan) !== scan;
        this.scanKeyState(scan);
        this.scan = scan.slice(-256);
        this.longCapture.write(part);
      } else {
        this.line += part;
        if (this.line.length > 128 * 1024) {
          this.longSensitive = this.privateKey || redact(this.line) !== this.line;
          this.scanKeyState(this.line);
          this.scan = this.line.slice(-256); this.longCapture = new HeadTail(); this.longCapture.write(this.line); this.line = ''; this.longLine = true;
        }
      }
      if (part.endsWith('\n')) {
        if (this.longLine) { this.keep(this.longSensitive ? '[oversized sensitive line redacted]\n' : this.longCapture.value()); this.longCapture = null; }
        else this.flushLine();
        this.longLine = false; this.longSensitive = false; this.scan = '';
      }
    }
  }
  keep(text) { this.output.write(text); }
  flushLine() {
    let rest = this.line, safe = ''; this.line = '';
    while (rest) {
      if (this.privateKey) {
        const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(rest);
        if (!end) break;
        this.privateKey = false; rest = rest.slice(end.index + end[0].length);
      } else {
        const begin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.exec(rest);
        if (!begin) { safe += rest; break; }
        safe += rest.slice(0, begin.index) + '[redacted private key]';
        rest = rest.slice(begin.index + begin[0].length); this.privateKey = true;
      }
    }
    this.keep(redact(safe));
  }
  finish() {
    this.line += this.decoder.end();
    if (this.longLine) this.keep(this.longSensitive ? '[oversized sensitive line redacted]' : this.longCapture.value());
    else this.flushLine();
    return this.output.value();
  }
}

export const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
export const STATUS_COMMAND = `hostname
uptime
free -m | head -n 2
df -h / | tail -n 1
systemctl --failed --no-legend --no-pager
systemctl list-units 'mastan*' --all --plain --no-legend --no-pager | awk '{print $1}' | while IFS= read -r unit; do
  systemctl show "$unit" -p Id -p ActiveState -p SubState -p ActiveEnterTimestamp -p ExecMainStartTimestamp --no-pager
done
for link in /opt/mastan/current /opt/mastan/releases/current; do
  if [ -L "$link" ]; then printf 'release: '; readlink -f "$link"; fi
done
if command -v openclaw >/dev/null 2>&1; then openclaw --version; fi
true`;

// Free reads: a fixed list, read-only, no shell from the caller, arguments validated here. Anything else takes a passkey.
// Commands that could print command lines or file contents are left out on purpose. A poisoned web page or log line
// that talks the agent into running these learns only what this list prints.
const UNIT = /^[A-Za-z0-9@._-]{1,80}$/;
const sinceArg = since => {
  need(typeof since === 'string' && /^\d{1,3}(m|h|d)$/.test(since), 'bad since');
  return `-${Number(since.slice(0, -1))} ${{m: 'min', h: 'hours', d: 'days'}[since.at(-1)]}`;
};
export const CHECKS = {
  disk: {about: 'disk use', command: () => 'df -h -x tmpfs -x devtmpfs -x overlay'},
  memory: {about: 'memory and swap', command: () => 'free -m'},
  load: {about: 'load and top processes, names only', command: () => 'uptime; ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu | head -n 15'},
  failed: {about: 'failed services', command: () => 'systemctl --failed --no-pager --plain'},
  services: {about: 'running services', command: () => 'systemctl list-units --type=service --state=running --no-pager --plain --no-legend'},
  timers: {about: 'timers and next run', command: () => 'systemctl list-timers --no-pager --plain'},
  unit: {about: 'state of one service, no log lines', args: ['unit'], command: ({unit}) => {
    need(typeof unit === 'string' && UNIT.test(unit), 'bad unit');
    return `systemctl status ${quote(unit)} --no-pager -n 0`;
  }},
  ports: {about: 'listening ports', command: () => 'ss -tlnp'},
  errors: {about: 'error-level journal lines', args: ['since'], command: ({since = '2h'}) => `journalctl -p err --since ${quote(sinceArg(since))} -n 100 --no-pager -o short-iso`},
  nginx: {about: 'nginx config test', command: () => 'nginx -t 2>&1'},
  certs: {about: 'certificate expiry dates', command: () => "for f in /etc/letsencrypt/live/*/cert.pem; do [ -e \"$f\" ] && { echo \"$f\"; openssl x509 -noout -enddate -in \"$f\"; }; done; true"},
  updates: {about: 'pending updates and reboot flag', command: () => 'apt list --upgradable 2>/dev/null | head -n 60; [ -e /var/run/reboot-required ] && echo reboot required; true'},
  versions: {about: 'system and runtime versions', command: () => 'uname -r; . /etc/os-release && echo "$PRETTY_NAME"; for c in node nginx openclaw; do command -v $c >/dev/null 2>&1 && { printf "%s: " $c; $c --version 2>&1 | head -n 1; }; done; true'},
  logins: {about: 'recent logins', command: () => 'last -n 10 -a'},
  firewall: {about: 'firewall state', command: () => 'ufw status verbose 2>&1'},
  http: {about: 'HTTP status of a local port', args: ['port', 'path'], command: ({port, path = '/'}) => {
    need(integer(port, 1, 65535), 'bad port');
    need(typeof path === 'string' && /^\/[A-Za-z0-9._~\/-]{0,120}$/.test(path), 'bad path');
    return `curl -sS -m 5 -o /dev/null -w '%{http_code}\\n' ${quote(`http://127.0.0.1:${port}${path}`)}`;
  }},
};
export function checkCommand(req) {
  const check = Object.hasOwn(CHECKS, req.name) ? CHECKS[req.name] : null;
  need(check, 'unknown check; run mastan-fleet checks');
  for (const key of ['unit', 'since', 'port', 'path']) need(req[key] === undefined || check.args?.includes(key), `${req.name} takes no ${key}`);
  return check.command(req);
}

export function logsCommand(req) {
  const {unit, since = '2h', lines = 200, grep} = req;
  need(typeof unit === 'string' && /^[A-Za-z0-9@._-]{1,80}$/.test(unit), 'bad unit');
  need(typeof since === 'string' && /^\d{1,3}(m|h|d)$/.test(since), 'bad since');
  need(integer(lines, 1, 1000), 'lines must be 1 to 1000');
  need(grep === undefined || (typeof grep === 'string' && /^[^\p{C}\p{Zl}\p{Zp}]{0,80}$/u.test(grep)), 'bad grep');
  const period = {m: 'min', h: 'hours', d: 'days'}[since.at(-1)];
  // journalctl uses a regular expression: escape metacharacters for a fixed string.
  const args = ['journalctl', '-u', quote(unit), '--since', quote(`-${Number(since.slice(0, -1))} ${period}`), '-n', String(lines), '--no-pager', '-o', 'short-iso'];
  if (grep !== undefined) args.push('--grep', quote(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return args.join(' ');
}

export function sshArgs(host, command, key = KEY) {
  return ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', `root@${host}`, '--', command];
}

export function executeSSH(host, command, {timeout_s = 120, signal, key, onCapture, spawnProcess = spawn} = {}) {
  return new Promise(resolve => {
    const capture = new OutputCapture();
    onCapture?.(capture);
    let settled = false, timedOut = false;
    const child = spawnProcess('/usr/bin/ssh', sshArgs(host, command, key), {stdio: ['ignore', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: '/var/lib/mastan-ops'}});
    const stop = () => { timedOut = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeout_s * 1000);
    signal?.addEventListener('abort', stop, {once: true});
    if (signal?.aborted) stop();
    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (timedOut) capture.write('\n[command timed out or cancelled]\n');
      resolve({exit_code: timedOut ? 124 : code ?? 255, output: capture.finish()});
    };
    child.stdout.on('data', c => capture.write(c));
    child.stderr.on('data', c => capture.write(c));
    child.on('error', () => { capture.write('[ssh unavailable]\n'); finish(255); });
    child.on('close', finish);
  });
}

const FIELDS = {
  servers: [], status: ['server'], logs: ['server', 'unit', 'since', 'lines', 'grep'],
  checks: [], check: ['server', 'name', 'unit', 'since', 'port', 'path'], live: ['id'],
  window: ['server', 'minutes', 'reason'], windows: [], close_window: ['server'],
  run: ['server', 'command', 'reason', 'timeout_s'], wait: ['id', 'timeout_s'], result: ['id'], requests: ['n'],
  cancel: ['id'], pending: [], challenge: ['id'], approve: ['id', 'assertion'], deny: ['id'],
  people: [],
  lease_challenge: [], lease_open: ['assertion', 'challenge'], lease_state: ['lease'], lease_set: ['on', 'lease'], lease_close: ['lease'],
  auto_run: ['id', 'lease'], auto_recent: [],
};

export class FleetGate {
  constructor({state = '/var/lib/mastan-fleet-gate', servers = () => JSON.parse(readFileSync('/opt/mastan-fleet/servers.json', 'utf8')).servers,
    passkeys = () => JSON.parse(readFileSync('/etc/mastan-fleet-gate/passkeys.json', 'utf8')),
    verify, executor = executeSSH, now = Date.now, log = () => console.error('[fleet] approval refused')} = {}) {
    mkdirSync(state, {recursive: true, mode: 0o700}); chmodSync(state, 0o700);
    this.peopleFile = join(state, 'people.json');
    this.db = new DatabaseSync(join(state, 'gate.sqlite'));
    chmodSync(join(state, 'gate.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, server TEXT NOT NULL, host TEXT NOT NULL,
        command TEXT NOT NULL, reason TEXT NOT NULL, timeout_s INTEGER NOT NULL, state TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, challenge TEXT, challenge_expires INTEGER,
        exit_code INTEGER, output TEXT, finished INTEGER);
      CREATE TABLE IF NOT EXISTS windows(server TEXT PRIMARY KEY, expires INTEGER NOT NULL, request_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(id TEXT PRIMARY KEY, counter INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(time TEXT, op TEXT, server TEXT, request_id TEXT, command TEXT, state TEXT, exit_code INTEGER);`);
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'kind')) this.db.exec("ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'command'");
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'auto')) this.db.exec('ALTER TABLE requests ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
    this.leaseChallenges = new Map();
    // A window never survives a gate restart.
    this.db.exec('DELETE FROM windows');
    this.running = new Map(); // request id -> OutputCapture of the command still running
    this.auditFile = join(state, 'audit.jsonl');
    this.servers = servers; this.passkeys = passkeys; this.verify = verify; this.executor = executor; this.now = now; this.log = log;
    this.jobs = new Set(); this.cache = null; this.refresh = null;
    const interrupted = this.db.prepare("SELECT * FROM requests WHERE state='approved'").all();
    this.db.prepare("UPDATE requests SET state='failed', challenge=NULL, challenge_expires=NULL, output='Gate restarted; execution outcome unknown. Not retried.', finished=? WHERE state='approved'").run(now());
    for (const row of interrupted) this.audit('recovery', {id: row.id}, this.get(row.id));
  }
  close() { this.db.close(); }
  expire() {
    this.db.prepare("UPDATE requests SET state='expired', challenge=NULL, challenge_expires=NULL, finished=? WHERE state='pending' AND expires<=?").run(this.now(), this.now());
  }
  get(id) {
    need(typeof id === 'string' && ID.test(id), 'bad request id');
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    need(row, 'unknown request'); return row;
  }
  public(row) {
    const {challenge, challenge_expires, host, ...out} = row;
    return {...out, status: row.state, approve_url: `${ORIGIN}/fleet#r${row.id}`, ...(row.state === 'pending' ? {hold: this.autoBlock(row)} : {})};
  }
  // Why a request needs a card even with auto-approve on, or null.
  autoBlock(row) {
    if (AUTO_EXCLUDED.has(row.server)) return 'gate host';
    if (row.kind !== 'command') return 'window';
    return destructive(row.command);
  }
  autoOn() { return this.db.prepare("SELECT value FROM settings WHERE key='auto'").get()?.value !== 'off'; }
  leaseValid(value) {
    if (typeof value !== 'string' || !LEASE.test(value)) return false;
    return !!this.db.prepare('SELECT 1 FROM leases WHERE hash=? AND expires>?').get(leaseHash(value), this.now());
  }
  autoState(lease) { return {on: this.autoOn(), lease: this.leaseValid(lease)}; }
  server(name) {
    need(typeof name === 'string' && NAME.test(name), 'bad server');
    const server = this.servers().find(s => s.name === name);
    need(server && typeof server.host === 'string' && /^[A-Za-z0-9:][A-Za-z0-9.:-]{0,252}$/.test(server.host), 'unknown server');
    return server;
  }
  // Each server may name its own key file in the ops key folder; older entries use the shared key.
  keyOf(server) {
    if (server.key === undefined) return KEY;
    need(typeof server.key === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(server.key), 'bad key name');
    return join(KEY_DIR, server.key);
  }
  windowOf(name) {
    const row = this.db.prepare('SELECT * FROM windows WHERE server=?').get(name);
    return row && row.expires > this.now() ? row : null;
  }
  openWindows() {
    this.db.prepare('DELETE FROM windows WHERE expires<=?').run(this.now());
    return this.db.prepare('SELECT server, expires FROM windows ORDER BY server').all();
  }
  audit(op, req, result) {
    const entry = {time: new Date(this.now()).toISOString(), op: Object.hasOwn(FIELDS, op) || ['execute', 'recovery'].includes(op) ? op : 'unknown',
      server: typeof req.server === 'string' && NAME.test(req.server) ? req.server : result?.server || null,
      request_id: typeof (req.id || result?.id) === 'string' && ID.test(req.id || result?.id) ? req.id || result.id : null,
      command: op === 'run' && typeof req.command === 'string' ? redact(req.command).slice(0, 4000)
        : op === 'check' && typeof req.name === 'string' ? [req.name, req.unit, req.since, req.port, req.path].filter(v => v !== undefined).join(' ').slice(0, 200)
        : op === 'logs' && typeof req.unit === 'string' ? `logs ${req.unit}`.slice(0, 200)
        : op === 'window' ? `window ${req.minutes ?? ''}`.trim() : null,
      state: result?.state || result?.status || (result?.ok === false ? 'refused' : 'ok'), exit_code: result?.exit_code ?? null};
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(...Object.values(entry));
    appendFileSync(this.auditFile, JSON.stringify(entry) + '\n', {mode: 0o600});
  }
  async handle(req) {
    let result;
    const op = req?.op;
    try {
      need(req && typeof req === 'object' && !Array.isArray(req) && Object.hasOwn(FIELDS, op), 'unknown operation');
      need(Object.keys(req).every(k => k === 'op' || FIELDS[op].includes(k)), 'unexpected argument');
      this.expire();
      result = {ok: true, ...await this.dispatch(req)};
    } catch (error) {
      if (op === 'approve') this.log();
      result = {ok: false, error: error instanceof Refused ? error.message : 'gate operation failed'};
    }
    if (!['pending', 'challenge', 'live', 'windows', 'checks', 'lease_challenge', 'lease_state', 'auto_recent'].includes(op) && !(op === 'approve' && result.ok)) this.audit(op, req || {}, result);
    return result;
  }
  async read(server, command, options = {}) {
    const result = await this.executor(server.host, command, {timeout_s: 15, key: this.keyOf(server), ...options});
    return {server: server.name, exit_code: result.exit_code, output: capOutput(redact(result.output)), state: result.exit_code === 0 ? 'done' : 'failed'};
  }
  async listServers() {
    if (this.cache && this.cache.expires > this.now()) return this.cache.value;
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const servers = this.servers();
      const rows = servers.map(s => ({name: s.name, client: s.client || '', reachable: false, health: 'Unreachable (15 s limit)'}));
      const abort = new AbortController();
      let index = 0, stopped = false, timer;
      const work = async () => {
        while (!stopped && index < servers.length) {
          const i = index++;
          try {
            const r = await this.read(this.server(servers[i].name), STATUS_COMMAND, {signal: abort.signal});
            if (!stopped) rows[i] = {...rows[i], reachable: r.exit_code === 0, health: r.output.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 300) || 'No status output'};
          } catch { if (!stopped) rows[i].health = 'Unreachable'; }
        }
      };
      await Promise.race([Promise.all(Array.from({length: Math.min(12, servers.length)}, work)), new Promise(resolve => { timer = setTimeout(resolve, 15_000); })]);
      stopped = true; clearTimeout(timer); abort.abort();
      const value = {servers: rows}; this.cache = {expires: this.now() + 60_000, value}; return value;
    })();
    try { return await this.refresh; } finally { this.refresh = null; }
  }
  async dispatch(req) {
    const {op} = req;
    if (op === 'servers') return this.listServers();
    if (op === 'people') return this.peopleList();
    if (op === 'lease_challenge') {
      const credentials = this.passkeys();
      need(credentials.length > 0, 'no trusted passkeys; Owner runs mastan-fleet-admin trust-passkeys');
      const challenge = randomBytes(32).toString('base64url');
      for (const [value, expires] of this.leaseChallenges) if (expires <= this.now()) this.leaseChallenges.delete(value);
      if (this.leaseChallenges.size >= 16) this.leaseChallenges.delete(this.leaseChallenges.keys().next().value);
      this.leaseChallenges.set(challenge, this.now() + 300_000);
      return {challenge, rpId: RP_ID, allowCredentials: credentials.map(c => ({id: c.id, type: 'public-key', transports: c.transports || []})), userVerification: 'required', timeout: 120_000};
    }
    if (op === 'lease_open') {
      need(typeof req.challenge === 'string' && this.leaseChallenges.get(req.challenge) > this.now(), 'challenge missing or expired');
      this.leaseChallenges.delete(req.challenge);
      const {credential, counter, checked} = await this.checkAssertion(req.assertion, req.challenge);
      const latest = this.db.prepare('SELECT counter FROM counters WHERE id=?').get(credential.id)?.counter ?? 0;
      need(latest === counter, 'counter changed; try again');
      this.db.prepare('INSERT INTO counters VALUES(?,?) ON CONFLICT(id) DO UPDATE SET counter=excluded.counter').run(credential.id, checked.authenticationInfo.newCounter);
      const lease = randomBytes(32).toString('base64url'), expires = this.now() + LEASE_MS;
      this.db.prepare('DELETE FROM leases WHERE expires<=?').run(this.now());
      this.db.prepare('INSERT INTO leases VALUES(?,?,?)').run(leaseHash(lease), expires, this.now());
      return {lease, expires};
    }
    if (op === 'lease_state') return this.autoState(req.lease);
    if (op === 'lease_set') {
      need(typeof req.on === 'boolean', 'bad on');
      // Anyone may turn it off. Only a lease holder turns it back on.
      need(!req.on || this.leaseValid(req.lease), 'passkey needed');
      this.db.prepare("INSERT INTO settings VALUES('auto',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(req.on ? 'on' : 'off');
      return this.autoState(req.lease);
    }
    if (op === 'lease_close') {
      if (typeof req.lease === 'string' && LEASE.test(req.lease)) this.db.prepare('DELETE FROM leases WHERE hash=?').run(leaseHash(req.lease));
      return {closed: true};
    }
    if (op === 'auto_recent') {
      const rows = this.db.prepare('SELECT * FROM requests WHERE auto=1 AND created>? ORDER BY created DESC, rowid DESC LIMIT 8').all(this.now() - 300_000);
      return {auto: rows.map(r => this.public(r))};
    }
    if (op === 'auto_run') {
      need(this.autoOn() && this.leaseValid(req.lease), 'passkey needed');
      const row = this.get(req.id);
      need(row.state === 'pending' && row.expires > this.now(), `request is ${row.state}`);
      const hold = this.autoBlock(row);
      need(!hold, `kept for approval: ${hold}`);
      need(this.server(row.server).host === row.host, 'server address changed; create a new request');
      if (!this.db.prepare("UPDATE requests SET state='approved',auto=1,challenge=NULL,challenge_expires=NULL WHERE id=? AND state='pending'").run(row.id).changes) throw new Refused('request changed');
      this.start(row);
      return this.public(this.get(row.id));
    }
    if (op === 'checks') return {checks: Object.entries(CHECKS).map(([name, c]) => ({name, about: c.about, args: c.args || []}))};
    if (op === 'windows') return {windows: this.openWindows()};
    if (op === 'check') return this.read(this.server(req.server), checkCommand(req));
    if (op === 'close_window') {
      const server = this.server(req.server);
      this.db.prepare('DELETE FROM windows WHERE server=?').run(server.name);
      return {server: server.name, state: 'closed'};
    }
    if (op === 'window') {
      const server = this.server(req.server);
      need(WINDOW_SERVERS.has(server.name), `no-tap windows are not allowed on ${server.name}`);
      const minutes = req.minutes ?? WINDOW_MAX_MIN;
      need(integer(minutes, 1, WINDOW_MAX_MIN), `minutes must be 1 to ${WINDOW_MAX_MIN}`);
      need(typeof req.reason === 'string' && /^[^\r\n\x00-\x1f\x7f]{1,200}$/.test(req.reason) && req.reason.trim(), 'reason must be one line, 1 to 200 characters');
      need(redact(req.reason) === req.reason, 'do not put secrets in commands or reasons');
      const id = randomBytes(16).toString('hex'), now = this.now();
      this.db.prepare(`INSERT INTO requests(id,server,host,command,reason,timeout_s,state,created,expires,kind) VALUES(?,?,?,?,?,?,'pending',?,?,'window')`)
        .run(id, server.name, server.host, `No-tap window: run commands as root on ${server.name} for ${minutes} minutes`, req.reason, minutes * 60, now, now + 30 * 60_000);
      return this.public(this.get(id));
    }
    if (op === 'status' || op === 'logs') return this.read(this.server(req.server), op === 'status' ? STATUS_COMMAND : logsCommand(req));
    if (op === 'run') {
      const server = this.server(req.server);
      need(typeof req.command === 'string' && req.command.trim() && req.command.length <= 4000 && !req.command.includes('\0'), 'command must be 1 to 4000 characters');
      need(typeof req.reason === 'string' && /^[^\r\n\x00-\x1f\x7f]{1,200}$/.test(req.reason) && req.reason.trim(), 'reason must be one line, 1 to 200 characters');
      need(redact(req.command) === req.command && redact(req.reason) === req.reason, 'do not put secrets in commands or reasons');
      const timeout = req.timeout_s ?? 120;
      need(integer(timeout, 1, 900), 'timeout_s must be 1 to 900');
      const id = randomBytes(16).toString('hex'), now = this.now();
      this.db.prepare(`INSERT INTO requests(id,server,host,command,reason,timeout_s,state,created,expires) VALUES(?,?,?,?,?,?,'pending',?,?)`)
        .run(id, server.name, server.host, req.command, req.reason, timeout, now, now + 30 * 60_000);
      // Inside an open window the command runs without a tap. It is still logged.
      if (this.windowOf(server.name)) {
        const row = this.get(id);
        this.db.prepare("UPDATE requests SET state='approved',challenge=NULL,challenge_expires=NULL WHERE id=?").run(id);
        this.start(row);
      }
      return this.public(this.get(id));
    }
    if (op === 'requests' || op === 'pending') {
      const n = req.n ?? 20;
      need(integer(n, 1, 100), 'n must be 1 to 100');
      const rows = op === 'pending' ? this.db.prepare("SELECT * FROM requests WHERE state='pending' ORDER BY created DESC, rowid DESC").all()
        : this.db.prepare('SELECT * FROM requests ORDER BY created DESC, rowid DESC LIMIT ?').all(n);
      return {[op]: rows.map(r => this.public(r))};
    }
    const row = this.get(req.id);
    if (op === 'result') return this.public(row);
    if (op === 'live') {
      const capture = this.running.get(row.id);
      return {...this.public(row), output: capture ? capOutput(capture.output.value()) : row.output};
    }
    if (op === 'wait') {
      const timeout = req.timeout_s ?? 300;
      need(integer(timeout, 1, 900), 'timeout_s must be 1 to 900');
      const deadline = Date.now() + timeout * 1000;
      while (true) {
        this.expire(); const current = this.get(req.id);
        if (!['pending', 'approved'].includes(current.state) || Date.now() >= deadline) return this.public(current);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    need(row.state === 'pending', `request is ${row.state}`);
    if (op === 'cancel' || op === 'deny') {
      this.db.prepare('UPDATE requests SET state=?,challenge=NULL,challenge_expires=NULL,finished=? WHERE id=? AND state=\'pending\'')
        .run(op === 'cancel' ? 'cancelled' : 'denied', this.now(), row.id);
      return this.public(this.get(row.id));
    }
    if (op === 'challenge') {
      const challenge = randomBytes(32).toString('base64url');
      const credentials = this.passkeys();
      need(credentials.length > 0, 'no trusted passkeys; Owner runs mastan-fleet-admin trust-passkeys');
      this.db.prepare('UPDATE requests SET challenge=?,challenge_expires=? WHERE id=?').run(challenge, Math.min(row.expires, this.now() + 120_000), row.id);
      return {challenge, rpId: RP_ID, allowCredentials: credentials.map(c => ({id: c.id, type: 'public-key', transports: c.transports || []})), userVerification: 'required', timeout: 120_000};
    }
    if (op === 'approve') {
      need(row.challenge && row.challenge_expires > this.now(), 'challenge missing or expired');
      const {credential, counter, checked} = await this.checkAssertion(req.assertion, row.challenge);
      const server = this.server(row.server);
      need(server.host === row.host, 'server address changed; create a new request');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const latest = this.get(row.id);
        const latestCounter = this.db.prepare('SELECT counter FROM counters WHERE id=?').get(credential.id)?.counter ?? 0;
        need(latest.state === 'pending' && latest.expires > this.now() && latest.challenge === row.challenge && latest.challenge_expires > this.now() && latestCounter === counter, 'request or counter changed; try again');
        this.db.prepare('INSERT INTO counters VALUES(?,?) ON CONFLICT(id) DO UPDATE SET counter=excluded.counter').run(credential.id, checked.authenticationInfo.newCounter);
        this.db.prepare("UPDATE requests SET state='approved',challenge=NULL,challenge_expires=NULL WHERE id=?").run(row.id);
        // Persist approval metadata before the executor can start. A failed audit
        // rolls back the claim and counter, so it cannot cause an unlogged run.
        this.audit('approve', req, this.public(this.get(row.id)));
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      if (row.kind === 'window') {
        const expires = this.now() + row.timeout_s * 1000;
        this.db.prepare('INSERT INTO windows VALUES(?,?,?) ON CONFLICT(server) DO UPDATE SET expires=excluded.expires, request_id=excluded.request_id').run(row.server, expires, row.id);
        this.db.prepare("UPDATE requests SET state='done',exit_code=0,output=?,finished=? WHERE id=?").run(`Open until ${new Date(expires).toISOString()}`, this.now(), row.id);
        this.audit('window', {server: row.server, id: row.id, minutes: Math.round(row.timeout_s / 60)}, this.get(row.id));
        return this.public(this.get(row.id));
      }
      this.start(row);
      return this.public(this.get(row.id));
    }
    throw new Refused('unknown operation');
  }
  async checkAssertion(assertion, expectedChallenge) {
    const credential = this.passkeys().find(c => c.id === assertion?.id);
    need(credential, 'unknown credential');
    const counter = this.db.prepare('SELECT counter FROM counters WHERE id=?').get(credential.id)?.counter ?? 0;
    let checked;
    try {
      checked = await this.verify({response: assertion, expectedChallenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        requireUserVerification: true, credential: {id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.public_key_b64, 'base64')),
          counter, transports: credential.transports || []}});
    } catch { throw new Refused('passkey verification failed'); }
    need(checked?.verified, 'passkey verification failed');
    return {credential, counter, checked};
  }
  // The people list sits in gate state. Owner 5 Nov: being signed in is enough, so the web service asks with no assertion.
  // The socket cannot tell the web service from the agent (same Unix user), so every read is in the audit.
  peopleList() {
    try { return {people: JSON.parse(readFileSync(this.peopleFile, 'utf8'))}; }
    catch { throw new Refused('the people list has not reached this server yet'); }
  }
  start(row) {
    const job = this.runApproved(row).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }
  async runApproved(row) {
    let result;
    try {
      const key = this.keyOf(this.server(row.server));
      result = await this.executor(row.host, row.command, {timeout_s: row.timeout_s, key, onCapture: capture => this.running.set(row.id, capture)});
    } catch { result = {exit_code: 255, output: 'Execution failed; not retried.'}; }
    this.running.delete(row.id);
    const state = result.exit_code === 0 ? 'done' : 'failed';
    this.db.prepare('UPDATE requests SET state=?,exit_code=?,output=?,finished=? WHERE id=? AND state=\'approved\'')
      .run(state, result.exit_code, capOutput(redact(result.output)), this.now(), row.id);
    this.cache = null;
    this.audit('execute', {id: row.id}, this.get(row.id));
  }
}

// One bounded JSON line per connection, exactly one JSON line back.
export function createGateServer(gate) {
  return net.createServer(socket => {
    let data = Buffer.alloc(0), started = false;
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      if (started) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > 64 * 1024) { socket.end('{"ok":false,"error":"request too large"}\n'); started = true; return; }
      const newline = data.indexOf(10); if (newline < 0) return;
      started = true;
      let req;
      try { req = JSON.parse(data.subarray(0, newline).toString('utf8')); } catch { socket.end('{"ok":false,"error":"invalid JSON"}\n'); return; }
      socket.setTimeout(920_000, () => socket.destroy());
      try { socket.end(JSON.stringify(await gate.handle(req)) + '\n'); }
      catch { socket.end('{"ok":false,"error":"gate operation failed"}\n'); }
    });
  });
}

async function main() {
  process.umask(0o077);
  const {verifyAuthenticationResponse} = await import('/opt/mastan-me/node_modules/@simplewebauthn/server/esm/index.js');
  const gate = new FleetGate({verify: verifyAuthenticationResponse});
  const server = createGateServer(gate);
  if (process.env.LISTEN_PID === String(process.pid) && process.env.LISTEN_FDS === '1') server.listen({fd: 3});
  else server.listen('/run/mastan-fleet.sock', () => chmodSync('/run/mastan-fleet.sock', 0o660));
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => server.close(async () => { await Promise.allSettled(gate.jobs); gate.close(); }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('[fleet] startup failed'); process.exitCode = 1; });
