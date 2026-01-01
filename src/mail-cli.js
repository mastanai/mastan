// mastan-me-mail: the sender list for email alerts. Changes apply from the next check, within 5 minutes.
import {addressOf, loadRules, saveMine} from './jobs/mail-alerts.js';

const [cmd, value] = process.argv.slice(2);
const usage = 'Usage: mastan-me-mail list | add <domain> | remove <domain> | mute <address>';
const clean = v => String(v || '').trim().toLowerCase();
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
function fail(text) { console.error(text); process.exit(1); }
if (cmd === 'list' && !value) {
  const r = loadRules();
  console.log(`Alert on: ${r.senders.join(', ')}\nNever alert: ${r.mute.join(', ')}`);
} else if (cmd === 'add' && DOMAIN.test(clean(value))) {
  saveMine(e => { e.senders = [...new Set([...(e.senders || []), clean(value)])]; e.removed = (e.removed || []).filter(s => s !== clean(value)); });
  console.log(`Added ${clean(value)}. Mail from it alerts from the next check.`);
} else if (cmd === 'remove' && DOMAIN.test(clean(value))) {
  saveMine(e => { e.senders = (e.senders || []).filter(s => s !== clean(value)); e.removed = [...new Set([...(e.removed || []), clean(value)])]; });
  console.log(`Removed ${clean(value)}.`);
} else if (cmd === 'mute' && addressOf(clean(value))) {
  saveMine(e => { e.mute = [...new Set([...(e.mute || []), addressOf(clean(value))])]; });
  console.log(`Muted ${addressOf(clean(value))}.`);
} else fail(usage);
