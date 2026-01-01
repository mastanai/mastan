// Workspace commands for mastan-me-admin:
//   init-workspace     create the workspace git repo if missing, copy the template (never over Owner's edits),
//                      merge .gitignore lines, link .claude/skills -> ../skills, commit as mastan-me
//   skills-inventory   rebuild SKILLS.md from skills/*/SKILL.md and skills/.collected.json
//   atlas-commit "msg" rebuild atlas/ATLAS.md and commit the workspace (used by the atlas skill)
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, symlinkSync, readlinkSync, renameSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import YAML from 'yaml';
import {config, CODE_DIR} from '../config.js';

const TEMPLATE = join(CODE_DIR, 'workspace-template');
const MANIFEST = '.template-manifest.json';
const sha = buf => createHash('sha256').update(buf).digest('hex');
const AUTHOR = ['-c', 'user.name=mastan-me', '-c', 'user.email=mastan-me@localhost'];

function git(ws, ...args) {
  return execFileSync('git', ['-C', ws, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(relative(base, p));
  }
  return out;
}

function commitAll(ws, message) {
  git(ws, 'add', '-A');
  if (!git(ws, 'status', '--porcelain').trim()) return false;
  git(ws, ...AUTHOR, 'commit', '-q', '-m', message);
  return true;
}

// Template files: copy when missing; update when the workspace copy is still the one we wrote
// (hash in the manifest); otherwise keep it (Owner or the agent edited it).
export function initWorkspace({ws = config.workspace, template = TEMPLATE} = {}) {
  const report = {created_repo: false, copied: [], updated: [], kept: [], gitignore_added: 0, link: '', committed: false};
  mkdirSync(ws, {recursive: true, mode: 0o700});
  if (!existsSync(join(ws, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'main', ws], {stdio: 'ignore'});
    report.created_repo = true;
  }
  const manifestPath = join(ws, MANIFEST);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const rel of walk(template)) {
    if (rel === 'gitignore') continue;
    const src = readFileSync(join(template, rel));
    const dst = join(ws, rel);
    const want = sha(src);
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), {recursive: true});
      writeFileSync(dst, src);
      manifest[rel] = want; report.copied.push(rel);
      continue;
    }
    const have = sha(readFileSync(dst));
    if (have === want) { manifest[rel] = want; continue; }
    if (manifest[rel] && manifest[rel] === have) {
      writeFileSync(dst, src); manifest[rel] = want; report.updated.push(rel);
    } else report.kept.push(rel);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // .gitignore: keep every existing line, add the template's missing ones.
  const giPath = join(ws, '.gitignore');
  const current = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const have = new Set(current.split('\n').map(l => l.trim()));
  const add = readFileSync(join(template, 'gitignore'), 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !have.has(l.trim()));
  if (add.length) {
    writeFileSync(giPath, current + (current && !current.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
    report.gitignore_added = add.length;
  }
  // Untrack files that are now ignored (board cache, run log), keep them on disk.
  for (const f of ['board/snapshot.json', 'board/sync-state.json', 'jobs/runs.log']) {
    try { git(ws, 'rm', '-q', '--cached', '--ignore-unmatch', f); } catch {}
  }

  for (const d of ['skills', 'memory', 'board', 'jobs', 'tasks', 'atlas']) mkdirSync(join(ws, d), {recursive: true});
  mkdirSync(join(ws, '.claude'), {recursive: true});
  const link = join(ws, '.claude', 'skills');
  let st = null;
  try { st = lstatSync(link); } catch {}
  if (!st) { symlinkSync('../skills', link); report.link = 'created .claude/skills -> ../skills'; }
  else if (st.isSymbolicLink()) report.link = `kept .claude/skills -> ${readlinkSync(link)}`;
  else report.link = '.claude/skills is a real folder; left as is (move its skills into skills/ and replace it with a link)';

  if (!existsSync(join(ws, 'SKILLS.md'))) skillsInventory({ws});
  report.committed = commitAll(ws, report.created_repo ? 'init workspace' : 'init-workspace: template update');
  return report;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try { return YAML.parse(m[1]) || {}; } catch { return {}; }
}

const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const oneLine = s => { const t = cell(s).replace(/\s*[—–]\s*/g, ', '); return t.length > 150 ? t.slice(0, 147).replace(/\s+\S*$/, '') + '...' : t; };

// SKILLS.md: one row per skill folder. Metadata (source, server, notes) comes from
// skills/.collected.json (written by bin/collect-skills); harness skills come from the template.
export function skillsInventory({ws = config.workspace, agentHome = config.agentHome} = {}) {
  const dir = join(ws, 'skills');
  mkdirSync(dir, {recursive: true});
  const meta = existsSync(join(dir, '.collected.json')) ? JSON.parse(readFileSync(join(dir, '.collected.json'), 'utf8')) : {skills: {}, excluded: []};
  const harness = existsSync(join(TEMPLATE, 'skills')) ? readdirSync(join(TEMPLATE, 'skills')) : [];
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name, 'SKILL.md');
    if (!existsSync(p)) continue;
    const fm = frontmatter(readFileSync(p, 'utf8'));
    const m = meta.skills?.[name] || {};
    const isHarness = harness.includes(name);
    rows.push({name, source: isHarness ? 'harness (Mastan Me)' : m.source || 'added on the server',
      what: oneLine(m.what || fm.description || ''), server: isHarness ? 'yes' : m.server || 'unknown', notes: m.notes || ''});
  }
  // Skills the Claude CLI already gets from claude.ai for user mastan (not copied into the workspace).
  let synced = [];
  try {
    const base = join(agentHome, '.claude', 'skills', 'synced');
    for (const bucket of readdirSync(base)) {
      const mf = join(base, bucket, 'manifest.json');
      if (existsSync(mf)) synced = JSON.parse(readFileSync(mf, 'utf8')).skills?.map(s => s.name) || synced;
    }
  } catch {}
  const lines = [
    '# Skills', '',
    `Generated by \`mastan-me-admin skills-inventory\` on ${new Date().toISOString().slice(0, 16)}Z. ${rows.length} skills in \`skills/\` (linked as \`.claude/skills\`).`,
    'Server: yes = works here; needs Mac = needs one of Owner\'s Macs (tell him, give him the steps); needs a login = an account or token is missing here.', '',
    '| Skill | Source | What it does | Server | Notes |', '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.name} | ${cell(r.source)} | ${r.what} | ${cell(r.server)} | ${cell(r.notes)} |`), '',
  ];
  if (synced.length) {
    lines.push('## Also available: claude.ai skills synced by the Claude CLI', '',
      `Loaded from \`~/.claude/skills/synced\` of user mastan, not copied here: ${synced.sort().join(', ')}.`,
      'Desktop-only ones (computer-use, chrome-browser, built-in-browser) do not work on this server.', '');
  }
  if (meta.excluded?.length) {
    lines.push('## Not collected', '', ...meta.excluded.map(e => `- ${e.name} (${cell(e.source)}): ${cell(e.reason)}`), '');
  }
  if (meta.collected_at) lines.push(`Last collection: ${meta.collected_at} by bin/collect-skills.`, '');
  const text = lines.join('\n');
  writeFileSync(join(ws, 'SKILLS.md.tmp'), text);
  renameSync(join(ws, 'SKILLS.md.tmp'), join(ws, 'SKILLS.md'));
  return {skills: rows.length, synced: synced.length, excluded: meta.excluded?.length || 0};
}

export const commands = {
  'init-workspace': {help: 'create or update the workspace repo from workspace-template (keeps edited files)', async run() {
    const r = initWorkspace();
    console.log(`Workspace ${config.workspace}${r.created_repo ? ' (new repo)' : ''}`);
    console.log(`copied ${r.copied.length}, updated ${r.updated.length}, kept edited ${r.kept.length}${r.kept.length ? ': ' + r.kept.join(', ') : ''}`);
    console.log(`.gitignore lines added: ${r.gitignore_added}. ${r.link}. ${r.committed ? 'Committed.' : 'Nothing to commit.'}`);
  }},
  'skills-inventory': {help: 'rebuild SKILLS.md in the workspace and commit', async run() {
    const r = skillsInventory();
    const committed = commitAll(config.workspace, `skills inventory: ${r.skills} skills`);
    console.log(`SKILLS.md: ${r.skills} skills, ${r.synced} claude.ai synced, ${r.excluded} not collected. ${committed ? 'Committed.' : 'No change.'}`);
  }},
  'atlas-commit': {help: 'atlas-commit "<message>" : rebuild atlas/ATLAS.md and commit the workspace', async run([message]) {
    const {atlas} = await import('../atlas/store.js');
    const a = atlas();
    a.renderAtlasMd();
    const done = a.commit(message || 'atlas: update');
    console.log(done ? 'ATLAS.md rebuilt and committed.' : 'ATLAS.md rebuilt, nothing to commit.');
  }},
};
