import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {parseFeed} from './people.js';

export function fetchCanary(config, exec = execFile) {
  const args = ['-F', 'none', '-i', config.clientsCanaryKeyFile || '/etc/mastan-me/clients-canary-key',
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + (config.clientsCanaryKnownHosts || '/etc/mastan-me/clients-canary-known-hosts'),
    '-o', 'GlobalKnownHostsFile=/dev/null', 'root@' + (config.clientsCanaryHost || '203.0.113.10'), 'clients-export'];
  return new Promise((resolve, reject) => exec('/usr/bin/ssh', args,
    {shell: false, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}},
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

const clock = at => new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(at));
const errorClass = error => Number.isInteger(error?.code) ? error.code
  : error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError'
    : error instanceof RangeError ? 'RangeError' : 'Error';

export function createCanary(config, {canaryFetch = fetchCanary, now = Date.now} = {}) {
  let last, recent, inflight, fetchedAt, lastAttempt = -Infinity, failed = false, missing = false;
  const unavailable = () => ({...parseFeed(null, now()), warning: null});
  const cached = () => last ? {...parseFeed(last, now()),
    warning: failed ? 'Canary unavailable, showing data from ' + clock(last.generated_at) : null} : null;
  const read = async refresh => {
    if (inflight) return inflight;
    if (!missing && last && now() - fetchedAt < 60_000 && (!refresh || now() - lastAttempt < 10_000)) return cached();
    if (now() - lastAttempt < 10_000 && recent) return missing ? recent : cached() || recent;
    lastAttempt = now();
    inflight = (async () => {
      try {
        try { await access(config.clientsCanaryKeyFile || '/etc/mastan-me/clients-canary-key', constants.R_OK); }
        catch (error) {
          if (error.code === 'ENOENT') { missing = true; recent = unavailable(); return recent; }
          throw error;
        }
        missing = false;
        const result = parseFeed(await canaryFetch(config), now());
        if (result.state === 'unavailable') throw new SyntaxError();
        last = {version: 1, ...result}; fetchedAt = now(); failed = false;
        recent = cached();
        return recent;
      } catch (error) {
        // Exception messages, stdout and stderr may contain private data.
        console.error(`[clients] canary ${errorClass(error)}`);
        failed = true; recent = cached() || unavailable();
        return recent;
      } finally { inflight = null; }
    })();
    return inflight;
  };
  // Saves can use any last good data immediately, even while a refresh is running.
  read.cached = cached;
  return read;
}
