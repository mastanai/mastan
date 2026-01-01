// Owner notices through canary Mastan: one SSH command to a forced command that queues the notice
// in canary's public_contact_notices, which its service sends to the owner on WhatsApp.
// The text is written to stdin only. Errors carry a code, never text, stdout or stderr content.
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {config as defaultConfig} from '../config.js';

const failure = code => Object.assign(new Error('Owner notice failed: ' + code), {code});

export function sshArgs(config) {
  return ['-F', 'none', '-i', config.ownerNoticeKey || '/etc/mastan-me/owner-notice-key',
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + (config.ownerNoticeKnownHosts || '/etc/mastan-me/clients-canary-known-hosts'),
    '-o', 'GlobalKnownHostsFile=/dev/null', '-T', 'root@' + (config.ownerNoticeHost || '203.0.113.10'), 'owner-notice'];
}

export async function sendOwnerNotice({id, text, fallback}, {config = defaultConfig, spawnFn = spawn, timeout = 15_000} = {}) {
  try { await access(config.ownerNoticeKey || '/etc/mastan-me/owner-notice-key', constants.R_OK); }
  catch { throw failure('NO_KEY'); }
  const input = JSON.stringify({id, text, fallback});
  return new Promise((resolve, reject) => {
    let child, done = false, stdout = '', stderr = '';
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child?.kill('SIGKILL'); finish(failure('TIMEOUT')); }, timeout);
    try { child = spawnFn('/usr/bin/ssh', sshArgs(config), {shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin'}}); }
    catch { finish(failure('SPAWN')); return; }
    child.on('error', () => finish(failure('SPAWN')));
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 64); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 64); });
    child.stdin.on('error', () => {}); // A refused connection closes stdin early; the exit code reports it.
    child.on('close', status => {
      if (status === 0) return finish(null, /^(ok|duplicate)$/.test(stdout.trim()) ? stdout.trim() : 'ok');
      // The forced command answers with one lowercase word; anything else (SSH errors) is reported by exit code only.
      const reason = /^[a-z]{1,12}$/.test(stderr.trim()) ? stderr.trim().toUpperCase() : 'EXIT_' + (Number.isInteger(status) ? status : 'SIGNAL');
      finish(failure(reason));
    });
    child.stdin.end(input);
  });
}
