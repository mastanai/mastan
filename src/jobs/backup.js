// backup (nightly, after consolidate): git bundle of the workspace (all refs) and a consistent copy of
// me.sqlite (VACUUM INTO) into /var/backups/mastan-me/. Keeps the newest 14 of each. Files 0600.
// Restore: git clone workspace-<stamp>.bundle workspace; cp me-<stamp>.sqlite /var/lib/mastan-me/me.sqlite
import {execFileSync} from 'node:child_process';
import {readdirSync, chmodSync, unlinkSync, existsSync, mkdirSync, renameSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {config} from '../config.js';

export const KEEP = 14;
export const backupDir = () => process.env.MASTAN_ME_BACKUP_DIR || '/var/backups/mastan-me';

export function stamp(d = new Date()) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

export function prune(dir, prefix, suffix, keep = KEEP) {
  const files = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith(suffix)).sort();
  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const f of drop) unlinkSync(join(dir, f));
  return drop.length;
}

export async function run({workspace = config.workspace, dbPath = config.dbPath, dir = backupDir(), now = new Date()} = {}) {
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true, mode: 0o700});
  const s = stamp(now);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const parts = [];
  let status = 'ok';

  // 1. Workspace bundle. Commit pending changes first so the bundle holds the current state.
  if (existsSync(join(workspace, '.git'))) {
    try {
      git('add', '-A');
      if (git('status', '--porcelain').trim()) git('-c', 'user.name=mastan-me', '-c', 'user.email=mastan-me@localhost', 'commit', '-q', '-m', `backup ${s}: pending changes`);
    } catch { /* nothing to commit or no identity; bundle what is there */ }
    let hasCommits = true;
    try { git('rev-parse', '--verify', 'HEAD'); } catch { hasCommits = false; }
    if (hasCommits) {
      const final = join(dir, `workspace-${s}.bundle`);
      const tmp = final + '.tmp';
      git('bundle', 'create', tmp, '--all');
      chmodSync(tmp, 0o600);
      git('bundle', 'verify', '-q', tmp);
      renameSync(tmp, final);
      parts.push(`bundle ${Math.round(statSync(final).size / 1024)} KB`);
    } else { parts.push('workspace has no commits yet, no bundle'); status = 'partial'; }
  } else { parts.push('workspace is not a git repo, no bundle'); status = 'partial'; }

  // 2. SQLite copy (consistent even while the service writes).
  if (existsSync(dbPath)) {
    const final = join(dir, `me-${s}.sqlite`);
    const tmp = join(dir, `.me-${s}.sqlite.tmp`);
    const db = new DatabaseSync(dbPath, {readOnly: false});
    try {
      db.exec('PRAGMA busy_timeout=10000');
      db.prepare('VACUUM INTO ?').run(tmp);
    } finally { db.close(); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, final);
    parts.push(`db ${Math.round(statSync(final).size / 1024)} KB`);
  } else { parts.push('no me.sqlite yet'); status = 'partial'; }

  const pruned = prune(dir, 'workspace-', '.bundle') + prune(dir, 'me-', '.sqlite');
  if (pruned) parts.push(`pruned ${pruned} old`);
  return {status, detail: `${parts.join(', ')} -> ${dir}`};
}
