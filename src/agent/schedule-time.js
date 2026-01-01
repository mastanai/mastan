// Calendar slots use the row's zone. Intervals are elapsed time; no host timezone is involved.
import {config} from '../config.js';

const MINUTE = 60_000, DAY = 86400_000;
const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = n => String(n).padStart(2, '0');
const formatters = new Map();
const utc = p => Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0);

export function localParts(ms, tz = config.tz) {
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat('en-GB', {timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}));
  return Object.fromEntries(formatters.get(tz).formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
export const localDate = (ms, tz) => { const p = localParts(ms, tz); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
export const localTime = (ms, tz) => { const p = localParts(ms, tz); return `${pad(p.hour)}:${pad(p.minute)}`; };
export const localStamp = (ms, tz = config.tz) => `${localDate(ms, tz)} ${localTime(ms, tz)} ${tz === 'Asia/Riyadh' ? 'Riyadh' : tz}`;

function dateParts(value) {
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || Number(m[1]) < 1000) throw new Error('Use a valid date: YYYY-MM-DD.');
  const p = {year: Number(m[1]), month: Number(m[2]), day: Number(m[3])};
  const d = new Date(utc(p));
  if (d.getUTCFullYear() !== p.year || d.getUTCMonth() + 1 !== p.month || d.getUTCDate() !== p.day) throw new Error('Use a valid date: YYYY-MM-DD.');
  return p;
}
function clock(value) {
  const m = typeof value === 'string' && value.match(/^(\d{2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Use a valid time: HH:MM.');
  return {hour: Number(m[1]), minute: Number(m[2])};
}
function shifted(p, n) {
  const d = new Date(utc({...p, hour: 0, minute: 0, second: 0}) + n * DAY);
  return {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()};
}

// A repeated hour uses its first occurrence. A missing hour moves forward by the DST gap.
export function wallToUtc(p, tz = config.tz) {
  const target = utc(p), offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = target + hours * 3600_000;
    offsets.add(utc(localParts(sample, tz)) - sample);
  }
  const candidates = [...offsets].map(offset => target - offset);
  const exact = candidates.filter(ms => utc(localParts(ms, tz)) === target).sort((a, b) => a - b);
  if (exact.length) return exact[0];
  return candidates.filter(ms => utc(localParts(ms, tz)) > target)
    .sort((a, b) => utc(localParts(a, tz)) - utc(localParts(b, tz)))[0];
}

export function duration(value) {
  const m = typeof value === 'string' && value.match(/^([1-9]\d*)(m|h|d)$/);
  const ms = m && Number(m[1]) * {m: MINUTE, h: 60 * MINUTE, d: DAY}[m[2]];
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('Use a positive interval such as 90m, 2h or 1d.');
  return ms;
}

export function parseRepeat(value, kind) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Invalid repeat.');
  let m;
  if ((m = value.match(/^every (\S+)$/))) {
    const ms = duration(m[1]), floor = (kind === 'check' ? 30 : 15) * MINUTE;
    if (ms < floor) throw new Error(`${kind === 'check' ? 'Check' : 'Reminder'} repeats must be at least ${floor / MINUTE} minutes apart.`);
    return {type: 'every', ms};
  }
  if ((m = value.match(/^daily (\S+)$/))) return {type: 'days', days: [0, 1, 2, 3, 4, 5, 6], ...clock(m[1])};
  if ((m = value.match(/^days ([a-z,-]+) (\S+)$/))) {
    const chosen = new Set();
    for (const part of m[1].split(',')) {
      const range = part.split('-');
      if (range.length > 2 || range.some(d => !days.includes(d))) throw new Error('Use weekday names sun,mon,tue,wed,thu,fri,sat or ranges such as sun-thu.');
      const start = days.indexOf(range[0]), end = days.indexOf(range.at(-1));
      for (let n = start; ; n = (n + 1) % 7) { chosen.add(n); if (n === end) break; }
    }
    return {type: 'days', days: [...chosen], ...clock(m[2])};
  }
  if ((m = value.match(/^monthly ([1-9]|[12]\d|3[01]) (\S+)$/))) return {type: 'monthly', day: Number(m[1]), ...clock(m[2])};
  throw new Error('Repeat: every <N>m|<N>h|<N>d, daily HH:MM, days sun-thu HH:MM or monthly <day> HH:MM.');
}

export function nextSlot(repeat, after, tz = config.tz, anchor = after) {
  if (!repeat) return null;
  if (repeat.type === 'every') {
    const ms = anchor + Math.max(1, Math.floor((after - anchor) / repeat.ms) + 1) * repeat.ms;
    if (!Number.isFinite(new Date(ms).getTime())) throw new Error('The interval is too large.');
    return ms;
  }
  const local = localParts(after, tz);
  if (repeat.type === 'days') {
    for (let n = 0; n <= 7; n++) {
      const p = shifted(local, n);
      if (!repeat.days.includes(new Date(utc(p)).getUTCDay())) continue;
      const ms = wallToUtc({...p, hour: repeat.hour, minute: repeat.minute}, tz);
      if (ms > after) return ms;
    }
  } else {
    for (let n = 0; n < 3; n++) {
      const month = new Date(Date.UTC(local.year, local.month - 1 + n, 1));
      const year = month.getUTCFullYear(), m = month.getUTCMonth() + 1;
      const day = Math.min(repeat.day, new Date(Date.UTC(year, m, 0)).getUTCDate());
      const ms = wallToUtc({year, month: m, day, hour: repeat.hour, minute: repeat.minute}, tz);
      if (ms > after) return ms;
    }
  }
  throw new Error('No next calendar slot.');
}

export const withinEnd = (ms, until, tz) => ms != null && (!until || localDate(ms, tz) <= until);
export function timing(input, now, tz = config.tz) {
  localParts(now, tz);
  if (input.at !== undefined && input.in !== undefined) throw new Error('Use either --at or --in.');
  const repeat = parseRepeat(input.repeat, input.kind);
  let next;
  if (input.in !== undefined) next = now + duration(input.in);
  else if (input.at === 'now') {
    if (input.kind !== 'check') throw new Error('--at now is only for checks.');
    next = now;
  } else if (input.at !== undefined) {
    if (typeof input.at !== 'string') throw new Error('Use --at "YYYY-MM-DD HH:MM" or --at "HH:MM".');
    const full = input.at.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    if (full) next = wallToUtc({...dateParts(full[1]), ...clock(full[2])}, tz);
    else {
      const c = clock(input.at), p = localParts(now, tz);
      next = wallToUtc({...p, ...c, second: 0}, tz);
      if (next <= now) next = wallToUtc({...shifted(p, 1), ...c}, tz);
    }
    if (next <= now) throw new Error('The first firing must be in the future.');
  } else if (repeat) next = nextSlot(repeat, now, tz);
  else throw new Error('Give --at, --in or --repeat.');
  if (!Number.isFinite(new Date(next).getTime())) throw new Error('The time is too far away.');
  if (repeat && nextSlot(repeat, next, tz, next) - next < (input.kind === 'check' ? 30 : 15) * MINUTE) throw new Error('The first firing is too close to the next repeat slot. Choose a later repeat slot or first firing.');
  if (input.until !== undefined) dateParts(input.until);
  if (input.times !== undefined && (!Number.isSafeInteger(input.times) || input.times < 1)) throw new Error('--times must be a positive whole number.');
  if (!withinEnd(next, input.until, tz)) throw new Error('The first firing is after --until.');
  return next;
}

export function dayBounds(now, tz) {
  const p = localParts(now, tz);
  return [wallToUtc({...p, hour: 0, minute: 0, second: 0}, tz), wallToUtc(shifted(p, 1), tz)];
}
export function inQuietHours(now, tz, quiet = {from: '23:00', to: '07:00'}) {
  try { clock(quiet.from); clock(quiet.to); } catch { quiet = {from: '23:00', to: '07:00'}; }
  const time = localTime(now, tz);
  return quiet.from > quiet.to ? time >= quiet.from || time < quiet.to : time >= quiet.from && time < quiet.to;
}
