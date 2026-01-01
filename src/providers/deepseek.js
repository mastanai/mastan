// DeepSeek behind the Claude Code CLI. DeepSeek's API speaks the Anthropic Messages format, so a DeepSeek chat runs
// the same `claude` binary with ANTHROPIC_BASE_URL pointed at DeepSeek and the DeepSeek key as its token (tested
// 3 Nov: tools, WebSearch and WebFetch work; Claude Code's own cost figure is wrong for these models).
// Whatever a DeepSeek process reads can reach DeepSeek's servers, so it runs inside bubblewrap with its own pid
// namespace and these hidden: Owner's Claude and Codex logins, service secrets and sockets, the harness database,
// run files and logs, Claude's browser profiles, and the Work folders in config/deepseek.json. It never gets
// Smartsheet (mcp kind 'main-noorg'). Its sessions live in <data>/deepseek/claude, never in ~/.claude.
import {mkdirSync, readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {config, deepseekSettings} from '../config.js';

export function deepseekDirs() {
  const home = join(config.dataDir, 'deepseek');
  return {home, claude: join(home, 'claude'), run: join(home, 'run')};
}

export function deepseekKey() {
  try { return readFileSync(config.deepseekKeyFile, 'utf8').trim(); } catch { return ''; }
}

// The model name Claude Code gets: with [1m] it plans for DeepSeek's 1M context instead of 200k.
export const deepseekModelArg = (model, s = deepseekSettings()) => s.context_1m ? `${model}[1m]` : model;

export function hiddenPaths() {
  const h = config.agentHome, d = config.dataDir;
  let users = [];
  try { users = readdirSync(join(d, 'users')); } catch {}
  return [
    join(h, '.claude'), join(h, '.claude.json'), join(h, '.codex'), join(h, '.config'),
    '/etc/mastan-me', '/run/credentials', '/run/mastan-gh.sock', '/run/mastan-fleet.sock', '/run/mastan-deploy.sock',
    '/run/mastan-google', '/run/mastan-content',
    join(d, 'run'), join(d, 'whatsapp'), join(d, 'config'), join(d, 'git'), join(d, 'seed'), join(d, 'state'), join(d, 'logs'),
    join(d, 'me.sqlite'), join(d, 'me.sqlite-wal'), join(d, 'me.sqlite-shm'),
    ...users.map(u => join(d, 'users', u, 'browser')),
    ...(deepseekSettings().hide_workspace || []).map(p => join(config.workspace, p)),
  ];
}

// Command, arguments and environment for one DeepSeek claude process. Throws NO_KEY or NO_SANDBOX before anything
// starts; there is never a fallback to Claude.
export function deepseekLaunch(model, claudeArgs, env) {
  const key = deepseekKey();
  if (!key) throw Object.assign(new Error('DeepSeek is not set up yet: the API key is not stored on the server.'), {code: 'NO_KEY'});
  const s = deepseekSettings();
  const dirs = deepseekDirs();
  for (const p of Object.values(dirs)) mkdirSync(p, {recursive: true, mode: 0o700});
  const name = deepseekModelArg(model, s);
  const fullEnv = {...env,
    CLAUDE_CONFIG_DIR: dirs.claude,
    ANTHROPIC_BASE_URL: s.base_url,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: name, ANTHROPIC_DEFAULT_OPUS_MODEL: name, ANTHROPIC_DEFAULT_SONNET_MODEL: name,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: s.subagent_model, CLAUDE_CODE_SUBAGENT_MODEL: s.subagent_model,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.auto_compact_window),
    API_TIMEOUT_MS: String(s.api_timeout_ms),
    // Off on purpose. On Linux the scrub needs Claude Code's own command sandbox (bwrap on PATH plus socat, not
    // installed) and it also forces bypassPermissions back to default: every Bash call failed on dev-01 (3 Nov).
    // So the DeepSeek key is visible to the commands the DeepSeek agent runs; the outer sandbox still hides the rest.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
  };
  if (process.env.MASTAN_ME_DEEPSEEK_SANDBOX === 'off') {
    console.warn('[deepseek] sandbox off (MASTAN_ME_DEEPSEEK_SANDBOX=off): local tests only');
    return {cmd: config.claudeBin, args: claudeArgs, env: fullEnv};
  }
  if (!existsSync(config.bwrapBin)) throw Object.assign(new Error('DeepSeek is off: the sandbox is missing on the server.'), {code: 'NO_SANDBOX'});
  const args = ['--dev-bind', '/', '/', '--unshare-pid', '--unshare-ipc', '--proc', '/proc', '--die-with-parent'];
  for (const p of hiddenPaths()) {
    let st; try { st = statSync(p); } catch { continue; }
    args.push(...(st.isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
  }
  return {cmd: config.bwrapBin, args: [...args, '--', config.claudeBin, ...claudeArgs], env: fullEnv};
}

// API failures as one plain line. The CLI's raw text is dropped when a cause is recognised.
export function deepseekError(e) {
  if (['ABORTED', 'TIMEOUT', 'NO_KEY', 'NO_SANDBOX', 'BUSY'].includes(e?.code)) return e;
  const m = String(e?.message || '');
  const why = /\b402\b|insufficient balance/i.test(m) ? 'The DeepSeek balance is empty.'
    : /\b401\b|invalid api key|authentication/i.test(m) ? 'DeepSeek rejected the API key.'
    : /\b429\b|rate limit/i.test(m) ? 'DeepSeek is rate limiting. Wait a minute.'
    : /\b5\d\d\b|overloaded/i.test(m) ? 'DeepSeek is down or overloaded.'
    : /image/i.test(m) && /\b400\b|not support|invalid/i.test(m) ? 'This DeepSeek model cannot read images. /model flash can.'
    : null;
  if (why) { e.message = why; e.code = e.code || 'DEEPSEEK'; }
  return e;
}
