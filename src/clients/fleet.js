import {readFile} from 'node:fs/promises';
import {riyadhDay, addDays} from './stripe.js';

const STALE = 48 * 3600;
const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
const count = n => Number.isFinite(n) && n >= 0;

export async function readFleet(file, now) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    // Fleet timestamps are Unix seconds; client payment periods are milliseconds.
    if (!Number.isFinite(data.generated_at) || data.generated_at <= 0 || data.generated_at > now / 1000 + 300 ||
      !Array.isArray(data.servers) || !Array.isArray(data.usage) ||
      data.servers.some(s => !s || typeof s.name !== 'string' || !s.name || typeof s.kind !== 'string' ||
        s.client != null && typeof s.client !== 'string') ||
      new Set(data.servers.map(s => s.name)).size !== data.servers.length ||
      data.usage.some(r => !r || typeof r.server !== 'string' || !validDay(r.day) || !count(r.input) || !count(r.output) ||
        r.cost != null && !count(r.cost))) throw new Error('FleetShape');
    return {state: now / 1000 - data.generated_at > STALE ? 'stale' : 'ready',
      servers: data.servers.map(s => ({name: s.name, kind: s.kind, client: s.client || '',
        connected: s.connected === true, last_ok: s.last_ok,
        monthly_eur: count(s.monthly_eur) ? s.monthly_eur : null})),
      usage: data.usage.map(r => ({server: r.server, day: r.day, input: r.input, output: r.output, cost: r.cost ?? null}))};
  } catch { return {state: 'unavailable', servers: [], usage: []}; }
}

export function serverCosts(person, fleet, now) {
  const server = fleet.servers.find(s => s.name === person.server);
  const cost = {period: null, all_time: null, last_30: null, source: 'Server ' + person.server,
    monthly_eur: server?.monthly_eur ?? null, reason: null};
  if (fleet.state !== 'ready') return {...cost, reason: 'Fleet data is old'};
  if (!server?.connected || !Number.isFinite(server.last_ok) || server.last_ok <= 0 ||
    server.last_ok > now / 1000 + 300 || now / 1000 - server.last_ok > STALE) return {...cost, reason: 'Server not reporting'};
  const period = Boolean(person.period_start && person.period_end), today = riyadhDay(now);
  // The last 30 Riyadh days include today, matching the Fleet page.
  const start = period ? riyadhDay(person.period_start) : addDays(today, -29);
  const end = period ? riyadhDay(person.period_end) : addDays(today, 1);
  const rows = fleet.usage.filter(r => r.server === person.server && r.day >= start && r.day < end);
  if (rows.some(r => r.input + r.output > 0 && !r.cost)) return {...cost, reason: 'Unpriced model'};
  cost[period ? 'period' : 'last_30'] = rows.reduce((sum, r) => sum + (r.cost || 0), 0);
  return cost;
}
