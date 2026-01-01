import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {createSecureContext} from 'node:tls';

export const ACCOUNT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
export function loadAccounts(config) {
  const file = join(config.dataDir, 'config', 'mail-accounts.json');
  const defaults = join(config.codeDir, 'config', 'mail-accounts.json');
  let rows;
  try { rows = JSON.parse(readFileSync(existsSync(file) ? file : defaults, 'utf8')); }
  catch { console.warn('[mailbox] config unreadable'); return []; }
  if (!Array.isArray(rows)) return [];
  const ids = new Set();
  return rows.filter(a => {
    const valid = a && typeof a.id === 'string' && ACCOUNT_ID.test(a.id) && a.id !== 'all' && !ids.has(a.id) && typeof a.label === 'string' && typeof a.host === 'string' && !/[\s\x00-\x1f]/.test(a.host) && typeof a.alerts === 'boolean' && (a.hidden === undefined || typeof a.hidden === 'boolean') &&
      [a.imapPort, a.smtpPort].every(p => Number.isInteger(p) && p > 0 && p < 65536) &&
      [a.certFile, a.keyFile].every(p => typeof p === 'string' && p.startsWith('/')) &&
      Array.isArray(a.addresses) && a.addresses.length && a.addresses.every(x => x && typeof x.address === 'string' && typeof (x.name || '') === 'string' && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(x.address) && !/[\r\n]/.test(x.name || ''));
    if (valid) ids.add(a.id);
    else console.warn('[mailbox] invalid account config');
    return valid && !a.hidden;
  });
}
export function credentials(account) {
  // A damaged or mismatched PEM must read as "not connected", never as a throw inside a socket library.
  try { const tls = {cert: readFileSync(account.certFile), key: readFileSync(account.keyFile)}; createSecureContext(tls); return tls; }
  catch { return null; }
}
