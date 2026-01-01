// Codex CLI provider (coder role). Uses the server's existing Codex ChatGPT login (CODEX_HOME of user mastan).
import {spawn} from 'node:child_process';
import {readFileSync, createWriteStream, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {config} from '../config.js';
import {childEnv, killTree} from './common.js';

export async function run({model, effort, prompt, cwd, timeoutMs = 30 * 60_000, signal, logFile, sandbox = 'workspace-write'}) {
  mkdirSync(cwd, {recursive: true});
  const log = logFile || join(cwd, 'codex.log');
  // The last-message file sits next to a log kept outside cwd (project clones), else in cwd as before.
  const last = logFile && !logFile.startsWith(cwd + '/') ? logFile.replace(/\.log$/, '') + '.last.txt' : join(cwd, '.codex-last-message.txt');
  const args = ['exec', '-m', model, '-s', sandbox, '--skip-git-repo-check', '-C', cwd, '-o', last];
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push('-');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const out = createWriteStream(log, {flags: 'a', mode: 0o600});
    const child = spawn(config.codexBin, args, {cwd, env: childEnv({CODEX_HOME: config.codexHome, PATH: `${join(dirname(config.codexBin), '..', 'codex-path')}:${childEnv().PATH}`}), stdio: ['pipe', 'pipe', 'pipe'], detached: true});
    child.stdout.pipe(out, {end: false});
    child.stderr.pipe(out, {end: false});
    const timer = setTimeout(() => killTree(child), timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, {once: true});
    child.on('error', e => { clearTimeout(timer); out.end(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer); out.end();
      signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - started;
      let text = '';
      try { text = readFileSync(last, 'utf8'); } catch {}
      if (code !== 0) return reject(Object.assign(new Error(`codex exited ${code}; see ${log}`), {exitCode: code, durationMs, log}));
      resolve({text, durationMs, exitCode: code, log});
    });
    child.stdin.end(prompt);
  });
}
