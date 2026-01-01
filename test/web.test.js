// Web track tests: host check, auth ceremonies (mocked verification), CSRF, rate limit,
// unauthenticated access, pages, API routes against an invented fixture atlas, board and brain fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, cpSync, rmSync, existsSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {execFileSync} from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = existsSync('/private/tmp/claude-501') ? '/private/tmp/claude-501' : tmpdir();
const DATA = mkdtempSync(join(base, 'mastan-me-web-test-'));
process.env.MASTAN_ME_DATA = DATA;
process.env.MASTAN_ME_HOSTNAME = 'me.example.com';
process.env.MASTAN_ME_RP_ID = 'mastan.ai';

const {config, loadModels, saveModels} = await import('../src/config.js');
const {openDb, jobStart, jobEnd} = await import('../src/db.js');
const {Atlas} = await import('../src/atlas/store.js');
const {createWeb, COOKIE, CEREMONY} = await import('../src/web/index.js');
const A = await import('../src/web/auth.js');

// --- fixture workspace (invented data only)
cpSync(join(HERE, 'fixtures', 'atlas'), config.atlasDir, {recursive: true});
const git = (...args) => execFileSync('git', ['-C', config.workspace, ...args], {encoding: 'utf8'});
git('init', '-q');
git('add', '-A');
git('-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'fixture');
const commits = () => Number(git('rev-list', '--count', 'HEAD').trim());

const db = openDb();
const atlas = new Atlas();

// --- capture logs: nothing written may contain tokens or atlas text
const logged = [];
for (const k of ['log', 'error', 'warn', 'info']) {
  const orig = console[k];
  console[k] = (...args) => { logged.push(args.join(' ')); if (process.env.WEB_TEST_VERBOSE) orig(...args); };
}

// --- fakes
let releaseAnswer = null;
const brain = {
  answer(id, text) {
    atlas.setQuestionStatus(id, 'answered', text);
    atlas.put('questions', {id: 'q-fixture-followup', domain: 'Work & building', text: 'Invented follow-up?', why: 'Fixture follow-up.', asked_at: '2026-10-26', status: 'open'});
    return new Promise(resolve => { releaseAnswer = () => resolve({summary: 'Filed the fixture answer.', created: ['p-x'], changed: [], followups: ['q-fixture-followup']}); });
  },
  dump(text, channel) {
    const {id} = atlas.addDump(text, channel);
    return Object.assign(new Promise(() => {}), {dumpId: id});
  },
};
const boardCalls = [];
let boardDown = false;
const board = {
  items: [
    {id: 't001', title: 'Fixture task', area: 'Mastan', lane: 'open', needs_you: true, note: 'n', next: '', priority: 'high', updated: '2026-10-25', last_by: 'owner'},
    {id: 't002', title: 'Fixture later', area: 'Personal', lane: 'interest', needs_you: false, note: '', next: '', priority: null, updated: '2026-10-20'},
    {id: 't003', title: 'Work item', area: 'Work', lane: 'open', needs_you: true, note: '', next: '', priority: null, updated: '2026-10-21'},
    {id: 't004', title: 'Odd area item', area: 'Work Events', lane: 'open', needs_you: false, note: '', next: '', priority: null, updated: '2026-10-21'},
  ],
  snapshot() { if (boardDown) throw new Error('down'); return {items: this.items, synced_at: '2026-10-26T00:00:00Z'}; },
  async add(item) { boardCalls.push(['add', item]); const it = {id: `t${900 + this.items.length}`, needs_you: false, note: '', next: '', ...item}; this.items.push(it); return it; },
  async update(id, patch) { boardCalls.push(['update', id, patch]); const it = this.items.find(i => i.id === id); Object.assign(it, patch); return it; },
  async done(id) { boardCalls.push(['done', id]); const it = this.items.find(i => i.id === id); it.lane = 'done'; return it; },
};

const verification = {
  register: null,
  login: null,
  async verifyRegistrationResponse(args) { return verification.register(args); },
  async verifyAuthenticationResponse(args) { return verification.login(args); },
};

const ctx = {config, db, atlas, brain, board, models: {load: loadModels, save: saveModels}};
const handler = createWeb(ctx, {verification});
const server = http.createServer(handler);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
test.after(async () => {
  await new Promise(r => server.close(r));
  rmSync(DATA, {recursive: true, force: true});
});

const ORIGIN = 'https://me.example.com';
function req(path, {method = 'GET', body, cookie, csrf, host = 'me.example.com', origin = ORIGIN, headers = {}, ip = '203.0.113.9', raw} = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {Host: host, 'X-Real-IP': ip, ...headers};
    if (payload) { h['Content-Type'] ??= 'application/json'; h['Content-Length'] = String(payload.length); }
    if (origin && method !== 'GET' && method !== 'HEAD') h.Origin = origin;
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
    const r = http.request({host: '127.0.0.1', port, path, method, headers: h, setHost: false}, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, headers: res.headers, text, json});
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const auth = (path, body, opts = {}) => req('/auth/' + path, {...opts, method: 'POST', body, headers: {'X-Mastan-Me': '1', ...(opts.headers || {})}});
const cookieOf = (res, name) => (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));

// A signed-in passkey session made directly in the store (ceremonies are tested separately).
const sessionCred = A.addCredential(db, {id: 'c2Vzc2lvbi1maXh0dXJlLWNyZWQ', publicKey: new Uint8Array(40).fill(7), origin: 'local'});
assert.ok(sessionCred);
const S = A.createSession(db, 'c2Vzc2lvbi1maXh0dXJlLWNyZWQ');
const SC = `${COOKIE}=${S.value}`;
const get = (path, opts = {}) => req(path, {cookie: SC, ...opts});
const post = (path, body = {}, opts = {}) => req(path, {method: 'POST', body, cookie: SC, csrf: S.csrf, ...opts});

test('host header must be the public host or loopback', async () => {
  assert.equal((await req('/login', {host: 'evil.example'})).status, 403);
  assert.equal((await req('/login', {host: 'mastan.ai'})).status, 403);
  assert.equal((await req('/login', {host: `127.0.0.1:${port}`})).status, 200);
  assert.equal((await req('/login')).status, 200);
});

test('login page: security headers, CSP nonce, no inline handlers, nothing private', async () => {
  const r = await req('/login');
  assert.equal(r.status, 200);
  const csp = r.headers['content-security-policy'];
  const nonce = csp.match(/'nonce-([A-Za-z0-9_-]+)'/)[1];
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['x-robots-tag'], /noindex/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  for (const tag of r.text.match(/<script[^>]*>/g)) assert.match(tag, new RegExp(`nonce="${nonce}"`));
  assert.doesNotMatch(r.text, /\son[a-z]+=|style="/i);
  assertThemeBoot(r.text, nonce);
  assert.match(r.text, /Sign in with passkey/);
  assert.doesNotMatch(r.text, /fixture|csrf-token|Sam Example/i);
  const head = await req('/login', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('unauthenticated: pages redirect to login, API 401, private assets 401, public assets 200', async () => {
  for (const p of ['/', '/questions', '/board', '/positions', '/dump', '/settings', '/nope']) {
    const r = await req(p);
    assert.equal(r.status, 303, p);
    assert.equal(r.headers.location, '/login');
  }
  assert.equal((await req('/', {method: 'HEAD'})).status, 303);
  for (const p of ['/api/graph', '/api/stats', '/api/questions', '/api/board', '/api/settings', '/api/node/p-fixture-walks']) {
    const r = await req(p);
    assert.equal(r.status, 401, p);
    assert.doesNotMatch(r.text, /fixture/);
  }
  assert.equal((await req('/api/positions/p-fixture-walks/confirm', {method: 'POST', body: {}})).status, 401);
  for (const p of ['common.js', 'atlas.js', 'questions.js', 'vendor/3d-force-graph-1.80.1.min.js']) assert.equal((await req('/static/' + p)).status, 401, p);
  for (const p of ['theme-boot.js', 'app.css', 'login.js', 'webauthn.js', 'mastan.png', 'icon-64.png', 'icon-180.png']) assert.equal((await req('/static/' + p)).status, 200, p);
  assert.equal((await req('/static/mastan.png')).headers['content-type'], 'image/png');
  const traversal = await req('/static/../src/config.js');
  assert.notEqual(traversal.status, 200);
  assert.doesNotMatch(traversal.text, /sessionSecret/);
  assert.notEqual((await req('/static/%2e%2e/src/config.js')).status, 200);
  assert.equal((await req('/static/missing.js')).status, 404);
  assert.equal((await get('/api/graph', {cookie: `${COOKIE}=${A.token()}`})).status, 401);
});

test('auth endpoints: same origin, custom header, JSON only, POST only', async () => {
  assert.equal((await auth('login/options', {}, {origin: 'https://evil.example'})).status, 403);
  assert.equal((await auth('login/options', {}, {origin: 'https://mastan.ai'})).status, 403);
  assert.equal((await auth('login/options', {}, {origin: null})).status, 403);
  assert.equal((await req('/auth/login/options', {method: 'POST', body: {}})).status, 403);
  assert.equal((await auth('login/options', {}, {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
  assert.equal((await auth('login/options', undefined, {raw: '{}', headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await req('/auth/login/options')).status, 405);
  assert.equal((await auth('login/options', {extra: 1})).status, 400);
  const ok = await auth('login/options', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.rpId, 'mastan.ai');
  assert.equal(ok.json.userVerification, 'required');
  assert.deepEqual(ok.json.allowCredentials || [], []);
  // loopback host uses its own origin
  const loop = await auth('login/options', {}, {host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`});
  assert.equal(loop.status, 200);
});

test('enrol link registers a passkey once, with RP mastan.ai and origin me.example.com', async () => {
  const link = A.enrol(db);
  assert.equal(db.prepare('SELECT hash FROM enrollments').get().hash, A.hash(link));
  const opts = await auth('register/options', {enrollment: link}, {ip: '198.51.100.1'});
  assert.equal(opts.status, 200);
  assert.equal(opts.json.rp.id, 'mastan.ai');
  assert.equal(opts.json.authenticatorSelection.userVerification, 'required');
  assert.equal(opts.json.authenticatorSelection.residentKey, 'required');
  // only passkeys registered here are excluded, so an imported board passkey never blocks the fallback
  A.importPasskeys(db, [{id: 'aW1wb3J0ZWQtYm9hcmQtZXhjbHVkZQ', public_key_b64: Buffer.alloc(40, 3).toString('base64'), counter: 0, transports: ['internal'], created: 1760000000000}]);
  const opts2 = await auth('register/options', {enrollment: link}, {ip: '198.51.100.1'});
  assert.ok(!opts2.json.excludeCredentials.some(c => c.id === 'aW1wb3J0ZWQtYm9hcmQtZXhjbHVkZQ'));
  assert.ok(opts2.json.excludeCredentials.some(c => c.id === 'c2Vzc2lvbi1maXh0dXJlLWNyZWQ'));
  const ceremony = cookieOf(opts2, CEREMONY);
  assert.ok(ceremony);
  let calls = 0;
  verification.register = args => {
    calls++;
    assert.equal(args.expectedOrigin, 'https://me.example.com');
    assert.equal(args.expectedRPID, 'mastan.ai');
    assert.equal(args.requireUserVerification, true);
    return {verified: true, registrationInfo: {credential: {id: 'bmV3LWxvY2FsLXBhc3NrZXktMDAwMQ', publicKey: new Uint8Array(40).fill(9), counter: 0, transports: ['internal']}}};
  };
  assert.equal((await auth('register/verify', {response: {}}, {ip: '198.51.100.1'})).status, 401); // no ceremony cookie
  const done = await auth('register/verify', {response: {}}, {cookie: ceremony, ip: '198.51.100.1'});
  assert.equal(done.status, 200);
  assert.equal(calls, 1);
  const set = done.headers['set-cookie'].find(c => c.startsWith(COOKIE + '='));
  assert.match(set, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000/);
  const session = set.split(';')[0];
  assert.equal((await req('/api/stats', {cookie: session})).status, 200);
  const row = db.prepare("SELECT origin FROM credentials WHERE id='bmV3LWxvY2FsLXBhc3NrZXktMDAwMQ'").get(); // gitleaks:allow (fake fixture id)
  assert.equal(row.origin, 'local');
  // single use
  assert.equal((await auth('register/verify', {response: {}}, {cookie: ceremony, ip: '198.51.100.1'})).status, 401);
  assert.equal((await auth('register/options', {enrollment: link}, {ip: '198.51.100.1'})).status, 401);
  // expired link
  const expired = A.enrol(db, Date.now() - A.ENROL_TTL - 1);
  assert.equal((await auth('register/options', {enrollment: expired}, {ip: '198.51.100.1'})).status, 401);
});

test('imported board passkey signs in: origin me.example.com, RP mastan.ai, UV required, counter checked', async () => {
  const pk = Buffer.alloc(77, 5);
  const r = A.importPasskeys(db, [{id: 'Ym9hcmQtY3JlZGVudGlhbC1maXh0dXJl', public_key_b64: pk.toString('base64'), counter: 3, transports: '["hybrid","internal"]', created: 1760000000000}]);
  assert.deepEqual(r, {inserted: 1, updated: 0, unchanged: 0});
  const opts = await auth('login/options', {}, {ip: '198.51.100.2'});
  const ceremony = cookieOf(opts, CEREMONY);
  verification.login = args => {
    assert.equal(args.expectedOrigin, 'https://me.example.com');
    assert.equal(args.expectedRPID, 'mastan.ai');
    assert.equal(args.requireUserVerification, true);
    assert.equal(args.expectedChallenge, opts.json.challenge);
    assert.deepEqual(Buffer.from(args.credential.publicKey), pk);
    assert.equal(args.credential.counter, 3);
    assert.deepEqual(args.credential.transports, ['hybrid', 'internal']);
    return {verified: true, authenticationInfo: {newCounter: 4}};
  };
  const ok = await auth('login/verify', {response: {id: 'Ym9hcmQtY3JlZGVudGlhbC1maXh0dXJl'}}, {cookie: ceremony, ip: '198.51.100.2'});
  assert.equal(ok.status, 200);
  assert.equal(db.prepare("SELECT counter FROM credentials WHERE id='Ym9hcmQtY3JlZGVudGlhbC1maXh0dXJl'").get().counter, 4); // gitleaks:allow (fake fixture id)
  const session = cookieOf(ok, COOKIE);
  assert.equal((await req('/api/graph', {cookie: session})).status, 200);
  // challenge is single use
  assert.equal((await auth('login/verify', {response: {id: 'Ym9hcmQtY3JlZGVudGlhbC1maXh0dXJl'}}, {cookie: ceremony, ip: '198.51.100.2'})).status, 401);
  // failed verification (for example a counter going backwards) gives 401
  const opts2 = await auth('login/options', {}, {ip: '198.51.100.2'});
  verification.login = () => { throw new Error('counter'); };
  assert.equal((await auth('login/verify', {response: {id: 'Ym9hcmQtY3JlZGVudGlhbC1maXh0dXJl'}}, {cookie: cookieOf(opts2, CEREMONY), ip: '198.51.100.2'})).status, 401);
  // unknown credential
  const opts3 = await auth('login/options', {}, {ip: '198.51.100.2'});
  assert.equal((await auth('login/verify', {response: {id: 'missing'}}, {cookie: cookieOf(opts3, CEREMONY), ip: '198.51.100.2'})).status, 401);
  // revoking the passkey ends its sessions
  const handle = db.prepare("SELECT handle FROM credentials WHERE id='Ym9hcmQtY3JlZGVudGlhbC1maXh0dXJl'").get().handle; // gitleaks:allow (fake fixture id)
  assert.equal(A.revokeCredential(db, handle), true);
  assert.equal((await req('/api/graph', {cookie: session})).status, 401);
});

test('operator link: single use, 30 minute session, cannot change models', async () => {
  const link = A.operatorLink(db);
  assert.equal(db.prepare('SELECT count(*) n FROM operator_links WHERE hash=?').get(A.hash(link)).n, 1);
  assert.equal((await auth('operator', {token: 'x'.repeat(43)}, {ip: '198.51.100.3'})).status, 401);
  const ok = await auth('operator', {token: link}, {ip: '198.51.100.3'});
  assert.equal(ok.status, 200);
  const set = ok.headers['set-cookie'].find(c => c.startsWith(COOKIE + '='));
  assert.match(set, /Max-Age=1800/);
  assert.equal((await auth('operator', {token: link}, {ip: '198.51.100.3'})).status, 401);
  const cookie = set.split(';')[0];
  const value = cookie.slice(COOKIE.length + 1);
  const row = A.findSession(db, value);
  assert.equal(row.operator, true);
  assert.ok(row.expires - Date.now() <= A.OPERATOR_SESSION_TTL);
  const page = await req('/', {cookie});
  assert.equal(page.status, 200);
  assert.match(page.text, /Operator session/);
  const csrf = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
  const settings = await req('/api/settings', {cookie});
  assert.equal(settings.json.operator, true);
  const save = await req('/api/settings/models', {method: 'POST', body: {roles: {main: 'claude-sonnet-5-5'}}, cookie, csrf});
  assert.equal(save.status, 403);
  assert.equal(loadModels().roles.main.model, 'claude-opus-5-5');
  // expired operator links are refused
  const old = A.operatorLink(db, Date.now() - A.OPERATOR_LINK_TTL - 1);
  assert.equal((await auth('operator', {token: old}, {ip: '198.51.100.3'})).status, 401);
});

test('CSRF on API writes: origin and per-session token', async () => {
  const path = '/api/positions/p-fixture-plan-long/confirm';
  assert.equal((await post(path, {}, {csrf: null})).status, 403);
  assert.equal((await post(path, {}, {csrf: 'wrong'})).status, 403);
  assert.equal((await post(path, {}, {csrf: A.token()})).status, 403);
  assert.equal((await post(path, {}, {origin: 'https://evil.example'})).status, 403);
  assert.equal((await post(path, {}, {origin: null})).status, 403);
  assert.equal((await post(path, {}, {headers: {'Sec-Fetch-Site': 'same-site'}})).status, 403);
  assert.equal((await post(path, undefined, {raw: '{}', headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal(atlas.get('positions', 'p-fixture-plan-long').status, 'needs_confirmation');
  assert.equal((await req(path, {method: 'PUT', cookie: SC, csrf: S.csrf, body: {}})).status, 405);
});

function assertThemeBoot(html, nonce) {
  const tag = html.match(/<script[^>]*src="\/static\/theme-boot\.js\?v=[0-9a-f]{12}"[^>]*><\/script>/)?.[0];
  assert.ok(tag, 'theme boot script is present');
  assert.match(tag, new RegExp(`nonce="${nonce}"`));
  assert.doesNotMatch(tag, /\b(?:defer|async|type)=?/);
  assert.ok(html.indexOf(tag) < html.indexOf('<link rel="stylesheet"'), 'theme boot precedes styles');
}

test('pages render with top bar, stats chips, nav, csrf meta and nonce scripts', async () => {
  const pages = {'/': 'atlas.js', '/questions': 'questions.js', '/board': 'board.js', '/positions': 'positions.js', '/dump': 'dump.js', '/settings': 'settings.js'};
  for (const [p, script] of Object.entries(pages)) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /class="topbar"/);
    assert.match(r.text, /class="shell-theme" type="button" aria-label="Switch to light mode">light<\/button>/);
    for (const label of ['Atlas', 'Questions', 'Board', 'Positions', 'Dump', 'Settings']) assert.match(r.text, new RegExp(`>${label}</a>`));
    assert.match(r.text, /<link rel="icon" href="\/static\/icon-64\.png\?v=[0-9a-f]{12}" type="image\/png">/);
    assert.match(r.text, /<link rel="apple-touch-icon" href="\/static\/icon-180\.png\?v=/);
    assert.match(r.text, /<a class="brand" href="\/"><img src="\/static\/mastan\.png\?v=/);
    assert.match(r.text, new RegExp(`href="${p}" aria-current="page"`));
    assert.match(r.text, /data-stat="positions"><b>5<\/b>/);
    assert.match(r.text, new RegExp(`/static/${script.replace('.', '\\.')}\\?v=[0-9a-f]{12}`));
    assert.match(r.text, /<meta name="csrf-token" content="[A-Za-z0-9_-]{43}">/);
    const nonce = r.headers['content-security-policy'].match(/'nonce-([A-Za-z0-9_-]+)'/)[1];
    assertThemeBoot(r.text, nonce);
    for (const tag of r.text.match(/<script[^>]*>/g)) assert.match(tag, new RegExp(`nonce="${nonce}"`));
    assert.doesNotMatch(r.text, /\son[a-z]+=|style="/i);
    assert.equal((await get(p, {method: 'HEAD'})).status, 200);
  }
  assert.match((await get('/')).text, /3d-force-graph-1\.80\.1\.min\.js/);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/login')).status, 200);
  const js = await get('/static/atlas.js', {headers: {'Accept-Encoding': 'gzip'}});
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-encoding'], 'gzip');
  const vendor = await get('/static/vendor/3d-force-graph-1.80.1.min.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers['content-type'], /javascript/);
});

test('graph, node detail and stats', async () => {
  const g = (await get('/api/graph')).json;
  assert.equal(g.domains.length, 10);
  assert.equal(g.nodes.filter(n => n.kind === 'position').length, 5);
  assert.equal(g.nodes.filter(n => n.domain === 'People').length, 2);
  assert.ok(g.links.some(l => l.type === 'tension'));
  assert.ok(g.nodes.every(n => typeof n.added === 'string' && !Number.isNaN(Date.parse(n.added))), 'every star carries the date it entered the atlas');
  const p = (await get('/api/node/p-fixture-short-updates')).json;
  assert.equal(p.kind, 'position');
  assert.equal(p.sources[0].quote, 'invented fixture quote about updates');
  assert.deepEqual(p.notes, []);
  const person = (await get('/api/node/person-fixture-sam')).json;
  assert.equal(person.name, 'Sam Example');
  assert.equal(person.file, undefined);
  assert.deepEqual(person.notes, []);
  assert.equal(person.context, '');
  assert.equal((await get('/api/node/..%2Fsecret')).status, 404);
  assert.equal((await get('/api/node/BAD_ID')).status, 404);
  assert.equal((await get('/api/node/p-missing')).status, 404);
  const s = (await get('/api/stats')).json;
  assert.equal(s.positions, 5);
  assert.equal(s.tensions, 1);
});

test('questions: grouped by domain with counts and waiting days; later, skip, reopen', async () => {
  const q = (await get('/api/questions')).json;
  assert.deepEqual(q.groups.map(g => g.domain), ['Self & psychology', 'Work & building']);
  assert.deepEqual(q.groups.map(g => g.count), [1, 1]);
  const card = q.groups[1].questions[0];
  assert.equal(card.id, 'q-fixture-meetings');
  assert.match(card.why, /counter example/);
  assert.equal(typeof card.waiting_days, 'number');
  assert.equal(q.later.length, 1);
  assert.equal(q.stats.open_questions, 2);
  const before = commits();
  assert.equal((await post('/api/questions/q-fixture-plans/later')).json.status, 'later');
  assert.equal(atlas.get('questions', 'q-fixture-plans').status, 'later');
  assert.ok(commits() > before);
  assert.equal((await post('/api/questions/q-fixture-plans/reopen')).json.status, 'open');
  assert.equal((await post('/api/questions/q-fixture-money/skip')).json.status, 'skipped');
  assert.equal(atlas.get('questions', 'q-fixture-money').status, 'skipped');
  assert.equal((await post('/api/questions/q-missing/skip')).status, 404);
});

test('answer: responds once marked answered, then follow-ups appear by polling', async () => {
  assert.equal((await post('/api/questions/q-fixture-meetings/answer', {text: '   '})).status, 400);
  const started = Date.now();
  const r = await post('/api/questions/q-fixture-meetings/answer', {text: 'An invented fixture answer.'});
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'filing');
  assert.ok(Date.now() - started < 3000);
  assert.equal(atlas.get('questions', 'q-fixture-meetings').status, 'answered');
  assert.equal((await get('/api/questions/q-fixture-meetings/answer')).json.state, 'filing');
  assert.equal((await post('/api/questions/q-fixture-meetings/answer', {text: 'again'})).json.state, 'filing');
  releaseAnswer();
  await new Promise(r => setTimeout(r, 20));
  const done = (await get('/api/questions/q-fixture-meetings/answer')).json;
  assert.equal(done.state, 'done');
  assert.equal(done.summary, 'Filed the fixture answer.');
  assert.equal(done.created, 1);
  assert.deepEqual(done.followups.map(f => f.id), ['q-fixture-followup']);
  assert.equal((await post('/api/questions/q-fixture-meetings/answer', {text: 'third'})).status, 409);
});

test('positions: list, confirm, edit, reject, each committed', async () => {
  const list = (await get('/api/positions')).json;
  assert.equal(list.positions.length, 5);
  assert.equal(list.positions[0].domain, 'Self & psychology');
  let n = commits();
  const c = await post('/api/positions/p-fixture-walks/confirm');
  assert.equal(c.json.position.status, 'active');
  assert.ok(c.json.position.confidence >= 0.8);
  assert.ok(commits() > n);
  n = commits();
  const e = await post('/api/positions/p-fixture-walks/edit', {statement: 'A daily walk, rain or shine.'});
  assert.equal(e.json.position.statement, 'A daily walk, rain or shine.');
  assert.equal(atlas.get('positions', 'p-fixture-walks').statement, 'A daily walk, rain or shine.');
  assert.ok(commits() > n);
  assert.equal((await post('/api/positions/p-fixture-walks/edit', {statement: 'x'.repeat(601)})).status, 400);
  assert.equal((await post('/api/positions/p-fixture-walks/edit', {statement: 'ok', extra: 1})).status, 400);
  const rej = await post('/api/positions/p-fixture-ship-small/reject', {reason: 'I ship small, but not every week. Wrong emphasis.'});
  assert.equal(rej.status, 200, rej.text);
  assert.equal(rej.json.position.status, 'superseded');
  const file = atlas.get('positions', 'p-fixture-ship-small');
  assert.equal(file.rejected_reason, 'I ship small, but not every week. Wrong emphasis.');
  assert.match(file.rejected_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(file.body, /rejected by Owner: I ship small, but not every week/);
  assert.deepEqual(atlas.rejected().map(r => [r.id, r.reason]), [['p-fixture-ship-small', 'I ship small, but not every week. Wrong emphasis.']]);
  assert.equal((await get('/api/positions')).json.positions.length, 4);
  assert.ok(!(await get('/api/graph')).json.nodes.some(x => x.id === 'p-fixture-ship-small'));
  assert.match(git('log', '-1', '--format=%s'), /web: reject position p-fixture-ship-small/);
  assert.equal((await post('/api/positions/p-fixture-walks/reject', {reason: 'x'.repeat(601)})).status, 400);
  assert.equal((await post('/api/positions/p-fixture-walks/confirm', {reason: 'no'})).status, 400, 'confirm takes no reason');
  assert.equal(atlas.get('positions', 'p-fixture-walks').status, 'active', 'refused calls change nothing');
});

test('notes on a position and on a person, dated and attributed, each committed', async () => {
  let n = commits();
  const r = await post('/api/positions/p-fixture-walks/note', {text: 'Only when the weather allows it.'});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.notes.length, 1);
  assert.equal(r.json.notes[0].by, 'owner');
  assert.equal(r.json.notes[0].text, 'Only when the weather allows it.');
  assert.match(r.json.notes[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(commits() > n);
  assert.match(git('log', '-1', '--format=%s'), /web: note on p-fixture-walks/);
  assert.deepEqual(atlas.get('positions', 'p-fixture-walks').notes.map(x => x.text), ['Only when the weather allows it.']);
  assert.equal((await get('/api/node/p-fixture-walks')).json.notes.length, 1);
  const p = await post('/api/people/person-fixture-sam/note', {text: 'Met through the walking group.'});
  assert.equal(p.status, 200, p.text);
  assert.equal((await get('/api/node/person-fixture-sam')).json.notes[0].text, 'Met through the walking group.');
  assert.equal((await post('/api/people/person-fixture-sam/note', {text: ''})).status, 400);
  assert.equal((await post('/api/people/person-fixture-sam/note', {text: 'x'.repeat(2001)})).status, 400);
  assert.equal((await post('/api/people/person-missing/note', {text: 'x'})).status, 404);
  assert.equal((await post('/api/positions/p-fixture-walks/note', {text: 'x', extra: 1})).status, 400);
  const OPS = A.createSession(db, A.OPERATOR, {ttl: A.OPERATOR_SESSION_TTL});
  const op = await req('/api/people/person-fixture-sam/note', {method: 'POST', body: {text: 'operator note'}, cookie: `${COOKIE}=${OPS.value}`, csrf: OPS.csrf});
  assert.equal(op.status, 200, op.text);
  assert.equal(op.json.notes.at(-1).by, 'operator');
});

test('dumps: save through the brain without waiting, list recent', async () => {
  const r = await post('/api/dumps', {text: 'Invented dump from the test.'});
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'filing');
  assert.match(r.json.id, /^\d{4}-\d{2}-\d{2}-invented-dump/);
  const list = (await get('/api/dumps')).json.dumps;
  assert.ok(list.some(d => d.preview === 'Invented dump from the test.' && d.status === 'new'));
  assert.ok(list.some(d => d.id === '2026-10-25-fixture-dump' && d.status === 'filed'));
  assert.equal((await post('/api/dumps', {text: ''})).status, 400);
});

test('board: every area shown, lanes mapped, writes go through ctx.board, Work editable', async () => {
  const b = (await get('/api/board')).json;
  assert.equal(b.available, true);
  assert.deepEqual(b.items.map(i => i.id), ['t001', 't002', 't003', 't004']);
  assert.equal(b.items[1].lane, 'later');
  assert.ok(b.areas.includes('Work'));
  assert.equal((await post('/api/board/items/t001', {lane: 'in_progress'})).json.item.lane, 'in_progress');
  assert.deepEqual(boardCalls.at(-1), ['update', 't001', {lane: 'in_progress'}]);
  await post('/api/board/items/t001', {note: 'Edited note', needs_you: false});
  assert.deepEqual(boardCalls.at(-1), ['update', 't001', {note: 'Edited note', needs_you: false}]);
  await post('/api/board/items/t002/done');
  assert.deepEqual(boardCalls.at(-1), ['done', 't002']);
  await post('/api/board/items/t001', {lane: 'done'});
  assert.deepEqual(boardCalls.at(-1), ['done', 't001']);
  const added = await post('/api/board/items', {title: 'New fixture item', area: 'Personal', lane: 'later', needs_you: true});
  assert.equal(added.status, 200);
  assert.deepEqual(boardCalls.at(-1), ['add', {title: 'New fixture item', area: 'Personal', lane: 'later', needs_you: true}]);
  assert.equal((await post('/api/board/items', {title: 'Work fixture add', area: 'Work'})).status, 200);
  assert.deepEqual(boardCalls.at(-1), ['add', {title: 'Work fixture add', area: 'Work', lane: 'open'}]);
  assert.equal((await post('/api/board/items/t003', {note: 'x'})).status, 200);
  assert.equal((await post('/api/board/items/t004/done')).status, 200);
  assert.equal((await post('/api/board/items/t001', {area: 'Work'})).status, 200);
  assert.deepEqual(boardCalls.at(-1), ['update', 't001', {area: 'Work'}]);
  const calls = boardCalls.length;
  assert.equal((await post('/api/board/items', {title: 'x', area: 'Nowhere'})).status, 400);
  assert.equal((await post('/api/board/items/t001', {title: 'x'.repeat(121)})).status, 400);
  assert.equal((await post('/api/board/items/t001', {})).status, 400);
  assert.equal(boardCalls.length, calls);
});

test('board unavailable and read-only states never crash or write', async () => {
  boardDown = true;
  const r = await get('/api/board');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, false);
  assert.equal((await post('/api/board/items/t001', {note: 'x'})).status, 503);
  boardDown = false;
  const orig = board.snapshot;
  board.snapshot = () => ({items: [], synced_at: null, unavailable: 'board token not set'});
  const nt = (await get('/api/board')).json;
  assert.equal(nt.available, false);
  assert.match(nt.reason, /not set up/);
  board.snapshot = () => ({items: orig.call(board).items, synced_at: '2026-10-26T00:10:00Z', source: 'mirror', read_only: 'writer token not approved yet'});
  const ro = (await get('/api/board')).json;
  assert.equal(ro.available, true);
  assert.equal(ro.read_only, 'writer token not approved yet');
  assert.equal(ro.items.length, board.items.length, 'read-only snapshot shows every item, Work included');
  const before = boardCalls.length;
  assert.equal((await post('/api/board/items/t001', {note: 'x'})).status, 403);
  assert.equal((await post('/api/board/items/t001/done')).status, 403);
  assert.equal((await post('/api/board/items', {title: 'x', area: 'Personal'})).status, 403);
  assert.equal(boardCalls.length, before);
  board.snapshot = orig;
  const web2 = createWeb({...ctx, board: undefined}, {verification});
  const s2 = http.createServer(web2);
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const res = await new Promise(resolve => http.get({host: '127.0.0.1', port: s2.address().port, path: '/api/board', headers: {Cookie: SC}}, x => {
    let t = ''; x.on('data', c => t += c); x.on('end', () => resolve({status: x.statusCode, json: JSON.parse(t)}));
  }));
  await new Promise(r => s2.close(r));
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
});

test('empty atlas: pages and API render with zero positions and questions', async () => {
  const emptyWs = join(DATA, 'empty-ws');
  const empty = new Atlas(join(emptyWs, 'atlas'), emptyWs);
  const web3 = createWeb({...ctx, atlas: empty}, {verification});
  const s3 = http.createServer(web3);
  await new Promise(r => s3.listen(0, '127.0.0.1', r));
  const fetchIt = (path, method = 'GET') => new Promise(resolve => http.request({host: '127.0.0.1', port: s3.address().port, path, method, headers: {Cookie: SC}}, x => {
    let t = ''; x.on('data', c => t += c); x.on('end', () => resolve({status: x.statusCode, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })()}));
  }).end());
  try {
    for (const p of ['/', '/questions', '/board', '/positions', '/dump', '/settings']) assert.equal((await fetchIt(p)).status, 200, p);
    assert.match((await fetchIt('/')).text, /data-stat="positions"><b>0<\/b>/);
    assert.deepEqual((await fetchIt('/api/graph')).json.nodes, []);
    const q = (await fetchIt('/api/questions')).json;
    assert.deepEqual(q.groups, []);
    assert.equal(q.stats.open_questions, 0);
    assert.deepEqual((await fetchIt('/api/positions')).json.positions, []);
    assert.deepEqual((await fetchIt('/api/dumps')).json.dumps, []);
    assert.equal((await fetchIt('/api/settings')).json.stats.positions, 0);
    const head = await fetchIt('/api/stats', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  } finally { await new Promise(r => s3.close(r)); }
});

test('settings: models with choices, save validates, jobs and stats shown', async () => {
  const id = jobStart('board-sync'); jobEnd(id, 'ok', 'synced');
  const s = (await get('/api/settings')).json;
  assert.equal(s.roles.main.model, 'claude-opus-5-5');
  assert.ok(s.choices['claude-cli'].includes('claude-sonnet-5-5'));
  assert.equal(s.jobs.find(j => j.job === 'board-sync').status, 'ok');
  assert.equal(s.stats.positions >= 1, true);
  assert.equal(s.operator, false);
  assert.equal((await post('/api/settings/models', {roles: {main: 'gpt-6.1-sol'}})).status, 400);
  assert.equal((await post('/api/settings/models', {roles: {ghost: 'claude-opus-5-5'}})).status, 400);
  const ok = await post('/api/settings/models', {roles: {main: 'claude-sonnet-5-5', coder: 'gpt-6.1-sol'}});
  assert.deepEqual(ok.json.changed, ['main']);
  const m = loadModels();
  assert.equal(m.roles.main.model, 'claude-sonnet-5-5');
  assert.equal(m.changed_by, 'owner');
  await post('/api/settings/models', {roles: {main: 'claude-opus-5-5'}});
});

test('body limits and logout', async () => {
  assert.equal((await post('/api/positions/p-fixture-index-funds/edit', {statement: 'x'.repeat(20000)})).status, 413);
  const s = A.createSession(db, 'c2Vzc2lvbi1maXh0dXJlLWNyZWQ');
  const cookie = `${COOKIE}=${s.value}`;
  const out = await req('/api/logout', {method: 'POST', body: {}, cookie, csrf: s.csrf});
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await req('/api/stats', {cookie})).status, 401);
});

test('auth rate limit: 30 per 5 minutes per client IP, persisted', async () => {
  const ip = '192.0.2.77';
  for (let i = 0; i < 30; i++) assert.equal((await auth('register/options', {enrollment: 'invalid'}, {ip})).status, 401);
  const blocked = await auth('login/options', {}, {ip});
  assert.equal(blocked.status, 429);
  assert.equal((await auth('login/options', {}, {ip: '192.0.2.78'})).status, 200);
  assert.ok(db.prepare('SELECT count(*) n FROM limits').get().n >= 2);
});

test('logs carry no tokens, ids from URLs or atlas text', () => {
  const all = logged.join('\n');
  assert.doesNotMatch(all, /fixture|Invented|Sam Example|daily walk/i);
  assert.doesNotMatch(all, new RegExp(S.value));
  assert.doesNotMatch(all, /[A-Za-z0-9_-]{43}/);
});
