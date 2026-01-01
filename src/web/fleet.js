// The web service is an untrusted relay. The gate alone verifies approvals.
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {fleetAutoOf} from './fleet-auto.js';

export function fleetCall(request, {socketPath = '/run/mastan-fleet.sock', timeout = 20_000, connect = net.createConnection} = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = Buffer.alloc(0), finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('Gate timeout'), {code: 'ETIMEDOUT'})));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 16 * 1024 * 1024) return finish(new Error('Gate response too large'));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try { finish(null, JSON.parse(data.subarray(0, newline).toString('utf8'))); }
      catch { finish(new Error('Invalid gate response')); }
    });
    socket.on('end', () => { if (!finished) finish(new Error('Gate closed without response')); });
  });
}

export const LEASE_COOKIE = '__Host-mm_fleet_lease';
export const LEASE_MAX_AGE = 30 * 86400;

export function createFleetRoutes(ctx, {readJson, onlyKeys, fail, json, leaseOf, setLease}, {transport = fleetCall} = {}) {
  const auto = fleetAutoOf(ctx, {transport});
  const call = async request => {
    let result;
    try { result = await transport(request, {socketPath: ctx.fleetSocket || '/run/mastan-fleet.sock'}); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return {installed: false, error: 'The fleet gate is not installed.'};
      throw fail(503);
    }
    if (!result.ok) { const error = fail(400, result.error || 'Fleet request refused.'); error.expose = true; throw error; }
    return result;
  };
  return async (req, res, path, session) => {
    if (!session || session.operator) throw fail(404);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (path === '/api/fleet' && method === 'GET') {
      const [servers, pending, recent] = await Promise.all([call({op: 'servers'}), call({op: 'pending'}), call({op: 'requests', n: 20})]);
      const missing = [servers, pending, recent].find(r => r.installed === false);
      return json(res, 200, missing || {installed: true, servers: servers.servers, pending: pending.pending, requests: recent.requests});
    }
    if (path === '/api/fleet/pending' && method === 'GET') {
      const lease = leaseOf(req);
      const [pending, windows, recent, state] = await Promise.all([call({op: 'pending'}), call({op: 'windows'}), call({op: 'auto_recent'}), call({op: 'lease_state', ...(lease ? {lease} : {})})]);
      const missing = [pending, windows, recent, state].find(r => r.installed === false);
      return json(res, 200, missing || {installed: true, pending: pending.pending, windows: windows.windows, auto: recent.auto, autoState: {on: state.on, lease: state.lease}, now: Date.now()});
    }
    const live = /^\/api\/fleet\/live\/([a-f0-9]{32})$/.exec(path);
    if (live && method === 'GET') return json(res, 200, await call({op: 'live', id: live[1]}));
    const closing = /^\/api\/fleet\/windows\/([A-Za-z0-9._-]{1,80})\/close$/.exec(path);
    if (closing && req.method === 'POST') { onlyKeys(await readJson(req), []); return json(res, 200, await call({op: 'close_window', server: closing[1]})); }
    // Auto-approve: the switch, and the one passkey that turns it on in a browser with no lease yet.
    if (path === '/api/fleet/auto' && req.method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['on']);
      const lease = leaseOf(req);
      return json(res, 200, await call({op: 'lease_set', on: input.on, ...(lease ? {lease} : {})}));
    }
    if (path === '/api/fleet/auto/challenge' && method === 'GET') return json(res, 200, await call({op: 'lease_challenge'}));
    if (path === '/api/fleet/auto/open' && req.method === 'POST') {
      const input = await readJson(req); onlyKeys(input, ['assertion', 'challenge']);
      const out = await call({op: 'lease_open', assertion: input.assertion, challenge: input.challenge});
      if (out.installed === false) throw fail(503);
      setLease(res, out.lease);
      const state = await call({op: 'lease_set', on: true, lease: out.lease});
      return json(res, 200, {on: state.on, lease: state.lease});
    }
    if (path === '/api/fleet/usage' && method === 'GET') {
      // Counts-only file written hourly by the fleet-usage collector.
      try { return json(res, 200, JSON.parse(await readFile(ctx.fleetUsageFile || '/var/www/fleet-usage/data.json', 'utf8'))); }
      catch { return json(res, 200, {available: false}); }
    }
    // People: an owner session is enough. Operators and anyone not signed in stop at the check above.
    if (path === '/api/fleet/people' && req.method === 'POST') {
      onlyKeys(await readJson(req), []);
      const result = await call({op: 'people'});
      return json(res, result.installed === false ? 503 : 200, result);
    }
    const match = /^\/api\/fleet\/(challenge|approve|deny)\/([a-f0-9]{32})$/.exec(path);
    if (!match) throw fail(404);
    const [, op, id] = match;
    if (req.method !== (op === 'challenge' ? 'GET' : 'POST')) throw fail(405);
    let assertion;
    if (op === 'approve') assertion = await readJson(req);
    if (op === 'deny') onlyKeys(await readJson(req), []);
    const result = await call({op, id, ...(op === 'approve' ? {assertion} : {})});
    if (op === 'approve' && result.ok) void auto.afterApprove(id, leaseOf(req));
    return json(res, result.installed === false ? 503 : 200, result);
  };
}
