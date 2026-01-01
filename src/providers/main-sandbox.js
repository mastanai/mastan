// Prompt injection limit: a fetched page or a log line can talk the agent into running a command, and its tools run as
// the service user. So the main agent runs inside bubblewrap with its own pid namespace (no /proc/<service>/environ)
// and without the service's own secrets. It keeps what its tools need: its Claude login and MCP file, the coder's
// login, the gate sockets (they hold no keys) and the YouTube key file.
import {existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {config} from '../config.js';

export function mainHidden() {
  const d = config.dataDir;
  return ['/etc/mastan-me/env', '/etc/mastan-me/deepseek-key', '/etc/mastan-me/smartsheet-token',
    '/etc/mastan-me/mail', '/etc/mastan-me/owner-notice-key', '/run/credentials', '/run/secrets',
    join(d, 'whatsapp'), join(d, 'deepseek'), join(d, 'logs')];
}

export function mainLaunch(args, env) {
  const plain = {cmd: config.claudeBin, args, env};
  if (process.env.MASTAN_ME_MAIN_SANDBOX === 'off') return plain;
  if (!existsSync(config.bwrapBin)) {
    console.warn('[sandbox] bwrap missing: main agent runs without its sandbox');
    return plain;
  }
  const out = ['--dev-bind', '/', '/', '--unshare-pid', '--unshare-ipc', '--proc', '/proc', '--die-with-parent'];
  for (const p of mainHidden()) {
    let st; try { st = statSync(p); } catch { continue; }
    out.push(...(st.isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
  }
  return {cmd: config.bwrapBin, args: [...out, '--', config.claudeBin, ...args], env};
}
