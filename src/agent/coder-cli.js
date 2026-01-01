// mastan-me-coder <dir> <prompt-file>: run the coder role and report the diff. Two modes, by path:
//   tasks/<date>-<slug>/   task folder: its own small git repo, committed before and after the run.
//   projects/<name>/       project clone (bin/sync-project): must sit on a me/<slug> branch; the coder edits the working
//                          tree and nothing is committed or pushed; the agent reviews, tests, commits and pushes.
import {readFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join, basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {config} from '../config.js';
import {runRole} from '../providers/index.js';

const [dirArg, promptFile] = process.argv.slice(2);
if (!dirArg || !promptFile) { console.error('Usage: mastan-me-coder <tasks/<dir>|projects/<name>> <prompt-file>'); process.exit(2); }
const dir = resolve(config.workspace, dirArg);
if (!dir.startsWith(config.workspace + '/')) { console.error('The task dir must be inside the workspace.'); process.exit(2); }
const project = dir.startsWith(join(config.workspace, 'projects') + '/');
if (project && !existsSync(join(dir, '.git'))) { console.error(`${dirArg} is not a project clone (no .git). Owner mirrors projects with bin/sync-project.`); process.exit(2); }
mkdirSync(dir, {recursive: true});
const git = (...args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const g = ['-c', 'user.name=mastan-me', '-c', 'user.email=mastan-me@localhost'];
let branch = '';
if (project) {
  try { branch = git('symbolic-ref', '--short', 'HEAD').trim(); } catch {}
  if (!/^me\//.test(branch)) { console.error(`Project clones take coder runs on a me/<slug> branch only (now: ${branch || 'detached'}). Run: git checkout -b me/<slug> origin/main`); process.exit(2); }
} else {
  if (!existsSync(join(dir, '.git'))) git('init', '-q');
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), 'codex.log\n.codex-last-message.txt\n');
  git('add', '-A');
  try { git(...g, 'commit', '-q', '--allow-empty', '-m', 'before coder run'); } catch {}
}
const base = git('rev-parse', 'HEAD').trim();
// Project runs log outside the clone, so nothing of the harness shows up in the repo's working tree.
let logFile = join(dir, 'codex.log');
if (project) {
  const logDir = join(config.workspace, 'tasks', 'coder-logs');
  mkdirSync(logDir, {recursive: true});
  logFile = join(logDir, `${basename(dir)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);
}
const common = 'Do not use the network unless the task says so. Never print secrets. Use the installed tools only. End with a short summary of what you changed and how you tested it.';
const rules = project
  ? `\n\nRules: this is a git clone on branch ${branch}. Work only inside the current directory. Do not commit, switch branches, fetch or push; leave your changes in the working tree. ${common}`
  : `\n\nRules: work only inside the current directory. ${common}`;
const prompt = readFileSync(resolve(promptFile), 'utf8') + rules;
try {
  const r = await runRole('coder', {task: 'coder', prompt, cwd: dir, logFile});
  let log = '';
  try { log = readFileSync(logFile, 'utf8'); } catch {}
  if (/bwrap: (setting up uid map|loopback)/.test(log)) {
    console.log('Coder unavailable: the Codex sandbox (bubblewrap) cannot run on this host, so the coder cannot run commands or write files.\n' +
      'Do the task yourself (main agent) and tell Owner in one line (see MORNING.md).\nLog: ' + logFile);
    process.exit(3);
  }
  let stat, diff, tail = '';
  if (project) {
    const untracked = git('ls-files', '--others', '--exclude-standard').trim();
    stat = git('diff', '--stat', base) + (untracked ? `\nNew files:\n${untracked}\n` : '');
    diff = git('diff', base) + untracked.split('\n').filter(Boolean).map(f => {
      try { return `\n--- new file: ${f}\n${readFileSync(join(dir, f), 'utf8').slice(0, 20000)}`; } catch { return `\n--- new file: ${f} (binary or unreadable)`; }
    }).join('');
    tail = `\n\nNothing is committed. Review, run the tests, then commit on ${branch} and push it: git push origin ${branch}`;
  } else {
    git('add', '-A');
    stat = git('diff', '--cached', '--stat', base);
    diff = git('diff', '--cached', base);
    try { git(...g, 'commit', '-q', '-m', 'coder run'); } catch {}
  }
  console.log(`## Coder (${r.model}, ${Math.round(r.durationMs / 1000)} s)\n\n${r.text.trim()}\n\n## Diff stat\n\n${stat.trim() || '(no changes)'}\n\n## Diff\n\n${diff.length > 60000 ? diff.slice(0, 60000) + '\n... (truncated)' : diff}${tail}\n\nLog: ${logFile}`);
} catch (e) {
  console.log(`Coder failed: ${e.message}\nLog: ${logFile}`);
  process.exit(1);
}
