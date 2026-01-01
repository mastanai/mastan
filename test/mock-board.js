// Small mock of the Topic Board API (/board/api/*) for tests. Same auth and CSRF rules as the
// real server: Bearer writer token, writes need Origin https://mastan.ai and X-Board-Token: board,
// optimistic lock by item version (409 on mismatch). Fixture data is invented.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';

export const TOKEN = 'T'.repeat(43);

export function fixture() {
  return {
    schema: 1, updated_at: '2026-10-20T10:00:00+03:00', updated_by: 'claude', diary: [],
    items: [
      {id: 't001', title: 'Plant the lemon tree', area: 'Personal', lane: 'open', needs_you: true, note: '', next: 'Buy soil', updated: '2026-10-19', priority: 'high'},
      {id: 't002', title: 'Fixture work item', area: 'Work', lane: 'open', needs_you: false, note: 'hidden', next: '', updated: '2026-10-18'},
      {id: 't003', title: 'Write test notes', area: 'Mastan', lane: 'in_progress', needs_you: false, note: 'n', next: '', updated: '2026-10-17'},
      {id: 't004', title: 'Old interest', area: 'Website', lane: 'interest', needs_you: false, note: '', next: '', updated: '2026-10-01'},
    ],
  };
}

export function startMockBoard({data = fixture()} = {}) {
  const history = data.items.map((it, n) => ({ts: `2026-10-0${(n % 9) + 1}T09:00:00+03:00`, by: 'claude', op: 'add', id: it.id, changes: {}}));
  const calls = [];
  let conflictsLeft = 0;
  const versions = () => Object.fromEntries(data.items.map(it => {
    const last = [...history.entries()].filter(([, e]) => e.id === it.id).at(-1) || null;
    return [it.id, createHash('sha256').update(JSON.stringify([it, last])).digest('hex')];
  }));
  const snapshot = (extra = {}) => ({data, history, raw_history: history.map(h => JSON.stringify(h)).join('\n') + '\n', versions: versions(), page: '<html></html>', ...extra});
  const json = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(value)); };

  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const raw = Buffer.concat(parts).toString('utf8');
    calls.push({method: req.method, url: req.url, headers: req.headers, body: raw});
    try {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, {error: 'Request failed. Please try again.'});
      if (req.url === '/board/api/board' && req.method === 'GET') return json(res, 200, snapshot());
      if (req.method !== 'POST') return json(res, 404, {error: 'nf'});
      if (req.headers.origin !== 'https://mastan.ai' || req.headers['x-board-token'] !== 'board') return json(res, 403, {error: 'csrf'});
      if (req.headers['content-type'] !== 'application/json' || !/^\d+$/.test(req.headers['content-length'] || '')) return json(res, 415, {error: 'type'});
      const body = JSON.parse(raw);
      const now = '2026-10-26';
      if (req.url === '/board/api/items') {
        let n = 1; while (data.items.some(i => i.id === `t${String(n).padStart(3, '0')}`)) n++;
        const item = {id: `t${String(n).padStart(3, '0')}`, title: body.title, area: body.area, lane: body.lane || 'open',
          needs_you: Boolean(body.needs_you), note: body.note || '', next: body.next || '', updated: now};
        if (['high', 'medium', 'low'].includes(body.priority)) item.priority = body.priority;
        data.items.push(item);
        history.push({ts: `${now}T03:00:00+03:00`, by: 'mastan-me', op: 'add', id: item.id, changes: {}});
        return json(res, 201, snapshot({item: {...item, version: versions()[item.id]}, message: `Added ${item.id}`}));
      }
      const m = req.url.match(/^\/board\/api\/items\/([A-Za-z0-9_-]+)(\/done)?$/);
      if (!m) return json(res, 404, {error: 'nf'});
      const item = data.items.find(i => i.id === m[1]);
      if (conflictsLeft > 0) {
        conflictsLeft--;
        if (item) { item.note = (item.note || '') + ' (changed elsewhere)'; history.push({ts: `${now}T03:01:00+03:00`, by: 'owner', op: 'update', id: item.id, changes: {}}); }
        return json(res, 409, snapshot({error: 'Changed elsewhere. Reload this card and try again.'}));
      }
      if (!item || versions()[item.id] !== body.version) return json(res, 409, snapshot({error: 'Changed elsewhere. Reload this card and try again.'}));
      const {version, ...fields} = body;
      if (m[2]) { Object.assign(item, {lane: 'done', needs_you: false, next: ''}); if (fields.note !== undefined) item.note = fields.note; }
      else {
        if (fields.priority === 'none') { delete item.priority; delete fields.priority; }
        Object.assign(item, fields);
      }
      item.updated = now;
      history.push({ts: `${now}T03:02:00+03:00`, by: 'mastan-me', op: m[2] ? 'done' : 'update', id: item.id, changes: {}});
      return json(res, 200, snapshot({item: {...item, version: versions()[item.id]}, message: `Updated ${item.id}`}));
    } catch {
      return json(res, 400, {error: 'bad'});
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    resolve({url: `http://127.0.0.1:${port}/board/`, data, calls, conflict(n = 1) { conflictsLeft = n; },
      close: () => new Promise(r => server.close(r))});
  }));
}
