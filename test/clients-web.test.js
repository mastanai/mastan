// Offline clients routes, using real sessions and sanitized Stripe response shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {execFileSync, spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {createDeals} from '../src/clients/deals.js';

const data = mkdtempSync(join(tmpdir(), 'clients-web-'));
process.env.MASTAN_ME_DATA = data;
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const {normalize, stripeList, riyadhDay} = await import('../src/clients/stripe.js');
const {kpis} = await import('../src/clients/people.js');
const A = await import('../src/web/auth.js');
const db = openDb(), fixture = JSON.parse(readFileSync(new URL('./fixtures/stripe-test-mode.json', import.meta.url)));
A.addCredential(db, {id: 'clients-owner-fixture', publicKey: new Uint8Array(32).fill(1)});
const owner = A.createSession(db, 'clients-owner-fixture'), operator = A.createSession(db, A.OPERATOR);
const NOW = Date.parse('2026-11-05T12:00:00Z'), DAY = 86400_000;
let seq = 0;
test.after(() => { db.close(); rmSync(data, {recursive: true, force: true}); });
test.beforeEach(() => { if (seq) db.exec('DELETE FROM client_events; DELETE FROM clients'); });

function setup({mode = 'test', source = structuredClone(fixture), feed, fleet, clock = {at: NOW}, transport, canaryFetch} = {}) {
  const prefix = join(data, String(++seq)), key = prefix + '.key', canaryKey = prefix + '.canary-key', fleetFile = prefix + '.fleet.json', calls = [], canaryCalls = [];
  const secret = mode === 'invalid' ? 'sk_live_' + 'forbiddenFixture' : `rk_${mode}_` + 'inventedRestrictedFixture';
  if (mode !== 'sample') writeFileSync(key, secret);
  if (feed !== undefined || canaryFetch) writeFileSync(canaryKey, 'inventedCanaryKey');
  let canaryData = feed;
  const checkedCanary = async () => { canaryCalls.push(clock.at); return canaryFetch ? canaryFetch() : typeof canaryData === 'string' ? canaryData : JSON.stringify(canaryData ?? null); };
  if (fleet !== undefined) writeFileSync(fleetFile, typeof fleet === 'string' ? fleet : JSON.stringify(fleet));
  const checkedTransport = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.stripe.com');
    assert.ok(['/v1/customers', '/v1/subscriptions', '/v1/charges'].includes(u.pathname));
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Stripe-Version'], '2024-06-20'); assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    assert.ok(options.signal instanceof AbortSignal); assert.equal(u.searchParams.get('limit'), '100');
    if (u.pathname === '/v1/subscriptions') assert.equal(u.searchParams.get('status'), 'all');
    calls.push(u);
    return transport ? transport(u, options) : {ok: true, json: async () => ({data: source[u.pathname.split('/').at(-1)], has_more: false})};
  };
  const ctx = {config: {...config, stripeReadKeyFile: key, clientsCanaryKeyFile: canaryKey}, db, atlas: {stats: () => ({})}, fleetUsageFile: fleetFile};
  const handler = createWeb(ctx, {stripeTransport: checkedTransport, canaryFetch: checkedCanary, now: () => clock.at});
  return {handler, calls, canaryCalls, source, setFeed(value) { writeFileSync(canaryKey, 'inventedCanaryKey'); canaryData = value; clock.at += 60_001; }, fleetFile, key, clock};
}

function request(path = '/api/clients', {handler, session = owner, method = 'GET', body, csrf = true, origin = 'https://me.example.com', contentType = 'application/json'} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body)), req = Readable.from(payload ? [payload] : []);
    req.url = path; req.method = method;
    req.headers = {host: 'me.example.com', ...(session ? {cookie: `${COOKIE}=${session.value}`} : {}),
      ...(method === 'POST' ? {origin, ...(csrf && session ? {'x-csrf-token': session.csrf} : {})} : {}),
      ...(payload ? {'content-type': contentType, 'content-length': String(payload.length)} : {})};
    req.socket = {localPort: 3100, remoteAddress: '127.0.0.1'};
    const headers = {};
    const res = {statusCode: 200, headersSent: false, setHeader(k, v) { headers[k.toLowerCase()] = v; },
      writeHead(status, values = {}) { this.statusCode = status; this.headersSent = true; for (const [k, v] of Object.entries(values)) this.setHeader(k, v); },
      end(value) { const text = String(value ?? ''); let json; try { json = JSON.parse(text); } catch {} resolve({status: this.statusCode, headers, text, json}); }};
    handler(req, res).catch(reject);
  });
}
const get = s => request('/api/clients', s);
const post = (s, path, body, extra = {}) => request(path, {...s, method: 'POST', body, ...extra});
const person = (result, id = 'cus_fixture1') => result.json.people.find(p => p.stripe_customer_id === id);
const feed = (extra = {}) => ({version: 1, generated_at: NOW, private_requests: [], billing: [], costs: [], ...extra});
const fleet = (extra = {}) => ({generated_at: NOW / 1000,
  servers: [{name: 'studio-01', kind: 'Client', client: 'Invented Studio', monthly_eur: 12.5, connected: true, last_ok: NOW / 1000}],
  usage: [], ...extra});

test('owner access, signed-out 303, anonymous API 404, generic API 401, operator nav and trailing slash', async () => {
  const s = setup();
  for (const path of ['/clients', '/clients/']) {
    assert.equal((await request(path, {...s, session: null})).status, 303);
    assert.equal((await request(path, {...s, session: operator})).status, 404);
    const page = await request(path, s);
    assert.equal(page.status, 200); assert.match(page.text, /clients\.js/); assert.match(page.text, /href="\/clients" aria-current="page"/);
    assert.ok(page.text.indexOf('href="/clients"') < page.text.indexOf('href="/fleet"'));
    assert.doesNotMatch(page.text, /\son[a-z]+=|style="/i);
    assert.match(page.headers['content-security-policy'], /style-src 'self';.*connect-src 'self'/);
  }
  for (const session of [null, operator]) for (const path of ['/api/clients', '/api/clients/stripe:cus_fixture1', '/api/clientsanything']) {
    assert.equal((await request(path, {...s, session})).status, 404);
    assert.equal((await post({...s, session}, path, {})).status, 404);
  }
  assert.equal((await request('/api/stats', {...s, session: null})).status, 401);
  assert.doesNotMatch((await request('/chat', {...s, session: operator})).text, /href="\/clients"/);
  assert.equal((await request('/static/clients.js', {...s, session: null})).status, 401);
  assert.equal((await request('/static/clients.js', s)).status, 200);
  assert.equal(s.calls.length, 0);
});

test('POST enforces CSRF, JSON, 16 KB, onlyKeys, tags and real calendar dates', async () => {
  const s = setup();
  assert.equal((await post(s, '/api/clients', {name: 'Lead'}, {csrf: false})).status, 403);
  assert.equal((await post(s, '/api/clients', {name: 'Lead'}, {origin: 'https://invented.invalid'})).status, 403);
  assert.equal((await post(s, '/api/clients', {name: 'Lead'}, {contentType: 'text/plain'})).status, 415);
  assert.equal((await post(s, '/api/clients', {name: 'Lead', notes: 'x'.repeat(17000)})).status, 413);
  for (const patch of [{unknown: 1}, {tag: 'VIP'}, {follow_up: '2026-02-30'}, {last_contact: 'tomorrow'}, {llm_covered: 2}, {notes: 'x'.repeat(8001)}, {email: 'invalid'}]) {
    assert.equal((await post(s, '/api/clients', {name: 'Lead', ...patch})).status, 400);
  }
  assert.equal((await post(s, '/api/clients', {name: 'Leap', follow_up: '2028-02-29'})).status, 201);
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', name: 'Overwrite Stripe'})).status, 400);
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', amount: 0})).status, 400);
});

test('missing key returns labeled samples in KPIs and refuses every sample write', async () => {
  const s = setup({mode: 'sample'}), result = await get(s);
  assert.equal(result.json.mode, 'sample'); assert.equal(result.json.kpis.paying, 5);
  assert.equal(s.calls.length, 0); assert.ok(result.json.people.every(p => p.name.startsWith('Sample:') && p.sample));
  assert.ok(result.json.people.some(p => p.status === 'past_due')); assert.ok(result.json.people.some(p => p.cancelling));
  assert.ok(result.json.people.some(p => p.discount === '50% off first month')); assert.ok(result.json.people.some(p => p.margin === null));
  for (const action of ['update', 'log', 'delete']) assert.equal((await post(s, '/api/clients/' + action, {id: 'sample:0', ...(action === 'log' ? {text: 'No save'} : {})})).status, 400);
  assert.ok(result.json.kpis.mrr.usd > 0);
  assert.ok(result.json.people.some(p => p.sample && p.action_reason));
  assert.equal(kpis(result.json.people, 'live').paying, 0); assert.equal(kpis(result.json.people, 'test').paying, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM clients').get().n, 0);
  await post(s, '/api/clients', {name: 'Real manual lead', follow_up: riyadhDay(NOW)});
  assert.equal((await get(s)).json.kpis.follow_ups, 1);
});

test('write routes keep person IDs in JSON, reject old paths and enforce exact body keys', async () => {
  const s = setup();
  for (const path of ['/api/clients/stripe:cus_fixture1', '/api/clients/canary:someone/log', '/api/clients/stripe%3Acus_fixture1/delete']) {
    assert.equal((await post(s, path, {})).status, 404);
  }
  for (const action of ['update', 'log', 'delete']) {
    for (const id of [undefined, null, 12, '', 'x'.repeat(201)]) assert.equal((await post(s, '/api/clients/' + action, {id})).status, 400);
    assert.equal((await post(s, '/api/clients/' + action, {id: 'stripe:cus_fixture1', text: 'Contact', extra: 'refused'})).status, 400);
  }
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', tag: 'customer'})).status, 200);
  assert.equal(person(await get(s)).tag_default, false);
  assert.equal((await post(s, '/api/clients/log', {id: 'stripe:cus_fixture1', text: 'Contact'})).status, 200);
  assert.equal((await post(s, '/api/clients/delete', {id: 'stripe:cus_fixture1'})).status, 200);
});

test('restricted key only, mode labels and livemode cross-check on all three lists', async () => {
  const invalid = setup({mode: 'invalid'}), refused = await get(invalid);
  assert.equal(refused.json.mode, 'error'); assert.equal(refused.json.warning, 'key is not restricted'); assert.equal(invalid.calls.length, 0);
  const s = setup(); assert.equal((await get(s)).json.mode, 'test');
  const source = structuredClone(fixture); for (const list of Object.values(source).filter(Array.isArray)) for (const row of list) row.livemode = true;
  const live = setup({mode: 'live', source}); assert.equal((await get(live)).json.mode, 'live');
  const old = console.error; console.error = () => {};
  try {
    for (const list of ['customers', 'subscriptions', 'charges']) {
      const bad = structuredClone(fixture); bad[list][0].livemode = true;
      const result = await get(setup({source: bad}));
      assert.match(result.json.warning, /mode mismatch/); assert.equal(result.json.people.length, 0);
    }
  } finally { console.error = old; }
  let called = false;
  await assert.rejects(stripeList('/v1/refunds', 'invented', 'test', () => { called = true; })); assert.equal(called, false);
});

test('fixture normalization: incomplete_expired is a lead, lookup_key beats metadata and best subscription beats latest', async () => {
  const source = structuredClone(fixture), s = setup({source});
  source.subscriptions[0].metadata.plan = 'enterprise';
  source.subscriptions.push({...structuredClone(source.subscriptions[0]), status: 'incomplete', created: source.subscriptions[0].created + 100});
  const result = await get(s), p = person(result);
  assert.equal(p.plan, 'Pro'); assert.equal(p.amount.usd, 30); assert.equal(p.status, 'active');
  const failed = person(result, 'cus_fixture2'); assert.equal(failed.status_label, 'Checkout failed'); assert.equal(failed.customer, false); assert.equal(failed.paying, false);
  assert.equal(result.json.kpis.paying, 3); assert.equal(result.json.kpis.mrr.usd, 330);
});

test('cancelling, overdue, trial, once and recurring discount MRR and next due rules', async () => {
  const source = structuredClone(fixture);
  source.subscriptions[0].discount = {coupon: {percent_off: 50, duration: 'once'}};
  source.subscriptions[3].cancel_at_period_end = true;
  source.subscriptions[3].discount = {coupon: {percent_off: 20, duration: 'forever'}};
  source.subscriptions[4].status = 'past_due';
  const result = await get(setup({source}));
  assert.equal(person(result).mrr.usd, 30); assert.equal(person(result).discount, '50% off first month');
  const c = person(result, 'cus_fixture4'); assert.equal(c.status_label, 'Cancelling'); assert.equal(c.next_due, null); assert.equal(c.mrr.usd, 160);
  const late = person(result, 'cus_fixture5'); assert.equal(late.overdue_since, source.subscriptions[4].current_period_start * 1000); assert.equal(late.next_due, null);
  assert.equal(result.json.kpis.paying, 3); assert.equal(result.json.kpis.mrr.usd, 190); assert.equal(result.json.kpis.at_risk.amount.usd, 260); assert.equal(result.json.kpis.at_risk.count, 2);
  assert.equal(result.json.kpis.overdue.count, 1);
  source.subscriptions[4].status = 'trialing';
  const trial = normalize(source).find(p => p.stripe_customer_id === 'cus_fixture5'); assert.equal(trial.status_label, 'Trial'); assert.ok(trial.next_due); assert.equal(trial.paying, false);
  source.subscriptions[4].status = 'canceled'; assert.equal(normalize(source).at(-1).next_due, null);
});

test('multi-currency MRR and lifetime never combine currencies, charges subtract refunds and ignore failures', async () => {
  const source = structuredClone(fixture);
  source.subscriptions[3].items.data[0].price.currency = 'sar';
  source.charges[0].amount_refunded = 1000;
  source.charges.push({...source.charges[0], id: 'ch_sar', amount: 37500, amount_refunded: 0, currency: 'sar', created: source.charges[0].created + 1});
  source.charges.push({...source.charges[0], status: 'failed', amount: 999999});
  const result = await get(setup({source}));
  assert.deepEqual(person(result).lifetime, {usd: 20, sar: 375}); assert.equal(person(result).last_paid, source.charges.at(-2).created * 1000);
  assert.deepEqual(result.json.kpis.mrr, {usd: 130, sar: 200});
  source.subscriptions[0].items.data[0].price.recurring = {interval: 'year', interval_count: 1};
  source.subscriptions[0].items.data[0].quantity = 2;
  assert.equal(normalize(source)[0].amount.usd, 5);
  source.subscriptions[0].discount = {coupon: {currency: 'usd', amount_off: 1200, duration: 'forever'}};
  assert.equal(normalize(source)[0].mrr.usd, 4);
  for (const [currency, amount] of [['jpy', 500], ['isk', 5], ['ugx', 5], ['kwd', .5]]) {
    source.charges = [{...source.charges[0], amount: 500, amount_refunded: 0, currency}];
    assert.equal(normalize(source)[0].lifetime[currency], amount);
  }
});

test('first-month net payment survives a removed once coupon without lowering list price or MRR', async () => {
  const source = structuredClone(fixture), sub = source.subscriptions[4];
  const charge = {...source.charges[0], customer: sub.customer, amount: 6000, amount_refunded: 1000,
    created: sub.current_period_start - 86400};
  source.charges = [charge];
  const normalized = () => normalize(source).find(p => p.stripe_customer_id === sub.customer);
  let p = normalized();
  assert.equal(p.discount, '50% off first month'); assert.equal(p.period_paid, 50);
  assert.deepEqual(p.lifetime, {usd: 50}); assert.equal(p.amount.usd, 100); assert.equal(p.mrr.usd, 100); assert.ok(p.next_due);
  sub.discount = {coupon: {duration: 'once', percent_off: 50}};
  assert.equal(normalized().period_paid, 50); assert.equal(normalized().discount, '50% off first month');
  sub.discount.coupon.percent_off = 25; assert.equal(normalized().discount, '25% off first month');
  sub.discount.coupon.duration = 'forever'; assert.equal(normalized().period_paid, null); assert.equal(normalized().mrr.usd, 75);
  sub.discount = null;
  charge.created--; assert.equal(normalized().period_paid, null); assert.equal(normalized().discount, null);
  charge.created++; charge.currency = 'sar'; assert.equal(normalized().period_paid, null);
  charge.currency = 'usd'; charge.amount = 11000; assert.equal(normalized().period_paid, null);
  charge.amount = 6000;
  source.charges.push({...charge, status: 'failed'}); assert.equal(normalized().period_paid, 50);
  source.charges.push({...charge, created: sub.current_period_start + 86400});
  assert.equal(normalized().period_paid, null); assert.equal(normalized().discount, null);
  source.charges.pop();
  const s = setup({source});
  await post(s, '/api/clients/update', {id: 'stripe:' + sub.customer, llm_covered: 0});
  p = person(await get(s), sub.customer); assert.equal(p.margin, 50); assert.equal(p.margin_percent, 100); assert.equal(p.mrr.usd, 100);
  // A free first month is a real payment base of zero.
  charge.amount_refunded = charge.amount; s.clock.at += 60_001;
  p = person(await get(s), sub.customer); assert.equal(p.period_paid, 0); assert.equal(p.margin, 0); assert.equal(p.margin_percent, null);
  sub.items.data[0].price.lookup_key = 'pro_monthly'; sub.items.data[0].price.unit_amount = 3000;
  charge.amount = 1500; charge.amount_refunded = 0; s.clock.at += 60_001;
  s.setFeed(feed({billing: [{user_id: sub.metadata.mastan_user_id, customer_id: sub.customer,
    period_start: sub.current_period_start * 1000, period_end: sub.current_period_end * 1000, period_micros: 2_500_000}]}));
  await post(s, '/api/clients/update', {id: 'stripe:' + sub.customer, llm_covered: 1});
  p = person(await get(s), sub.customer); assert.equal(p.margin, 12.5); assert.ok(Math.abs(p.margin_percent - 83.3333333) < .001);
});

test('recent untagged checkout failures rank after follow-ups and before cancelling without subscription IDs', async () => {
  const source = structuredClone(fixture), failed = source.subscriptions[1];
  failed.created = (NOW - 14 * DAY) / 1000;
  source.subscriptions[3].cancel_at_period_end = true;
  const s = setup({source});
  let result = await get(s), p = person(result, failed.customer);
  assert.equal(p.checkout_failed_at, NOW - 14 * DAY); assert.equal(p.action_reason, 'Checkout failed');
  assert.ok(p.action_rank < person(result, 'cus_fixture4').action_rank);
  assert.doesNotMatch(result.text, /sub_fixture/);
  await post(s, '/api/clients/update', {id: p.id, follow_up: riyadhDay(NOW)});
  assert.equal(person(await get(s), failed.customer).action_rank, 1);
  await post(s, '/api/clients/update', {id: p.id, follow_up: '', tag: 'warm'});
  assert.equal(person(await get(s), failed.customer).action_reason, '');
  await post(s, '/api/clients/update', {id: p.id, tag: null});
  failed.created--; s.clock.at += 60_001;
  assert.equal(person(await get(s), failed.customer).action_reason, '');
  failed.status = 'incomplete'; failed.created = s.clock.at / 1000; s.clock.at += 60_001;
  assert.equal(person(await get(s), failed.customer).action_reason, 'Checkout failed');
});

test('cache, single in-flight, refresh throttle and pagination cap', async () => {
  const s = setup();
  await Promise.all([get(s), get(s), get(s)]); assert.equal(s.calls.length, 3);
  await get(s); await request('/api/clients?refresh=1', s); assert.equal(s.calls.length, 3);
  s.clock.at += 10_001; await request('/api/clients?refresh=1', s); assert.equal(s.calls.length, 6);
  await request('/api/clients?refresh=1', s); assert.equal(s.calls.length, 6);
  s.clock.at += 60_001; await get(s); assert.equal(s.calls.length, 9);
  const capped = setup({transport: async u => ({ok: true, json: async () => ({data: [{...fixture[u.pathname.split('/').at(-1)][0], id: 'page_' + (u.searchParams.get('starting_after') || '0')}], has_more: true})})});
  const result = await get(capped); assert.equal(result.json.truncated, true); assert.equal(capped.calls.length, 30);
  assert.ok(capped.calls.filter(u => u.searchParams.has('starting_after')).length === 27);
});

test('Stripe errors serve the last good in memory, keep leads working, and log no private data', async () => {
  let broken = false; const logged = [], old = console.error;
  const s = setup({transport: async u => {
    if (broken) throw new Error('fixture1@example.invalid rk_test_doNotLog');
    return {ok: true, json: async () => ({data: fixture[u.pathname.split('/').at(-1)], has_more: false})};
  }});
  const first = await get(s); broken = true; s.clock.at += 60_001; console.error = line => logged.push(line);
  try {
    const stale = await get(s); assert.equal(stale.json.stale, true); assert.match(stale.json.warning, /Stripe unavailable/);
    assert.equal(stale.json.updated_at, first.json.updated_at); assert.equal(person(stale).name, person(first).name);
    await post(s, '/api/clients', {name: 'Works while offline'});
    assert.ok((await get(s)).json.people.some(p => p.name === 'Works while offline'));
    const empty = setup({transport: async () => ({ok: false, status: 503})});
    const error = await get(empty); assert.ok(error.json.people.every(p => !p.stripe_customer_id)); assert.match(error.json.warning, /unavailable/);
    await request('/api/clients?refresh=1', empty); assert.equal(empty.calls.length, 3);
  } finally { console.error = old; }
  assert.ok(logged.length); assert.doesNotMatch(logged.join(' '), /fixture1@|rk_|Works while/);
});

test('explicit output allowlist excludes payment credentials and key strings', async () => {
  const source = structuredClone(fixture);
  Object.assign(source.customers[0], {card: {last4: '4242'}, payment_method: 'pm_private', tax_id: 'private'});
  source.charges[0].payment_method_details = {card: {last4: '4242'}};
  source.subscriptions[0].default_payment_method = 'pm_private';
  const result = await get(setup({source})); assert.doesNotMatch(result.text, /card|last4|payment_method|rk_|4242|pm_private/);
});

test('feed exact period costs require matching customer, metadata user, periods and a fresh feed', async () => {
  for (const value of [undefined, '{bad', feed({costs: [{user_id: 'x', day: 'bad', micros: -1}]}),
    feed({billing: [{user_id: 'x', period_micros: -1}]})]) assert.equal((await get(setup({feed: value}))).json.feed.state, 'unavailable');
  const source = structuredClone(fixture), sub = source.subscriptions[0];
  const billing = {user_id: 'user-fixture-1', customer_id: 'cus_fixture1', period_start: sub.current_period_start * 1000,
    period_end: sub.current_period_end * 1000, period_micros: 2_500_000};
  const fresh = feed({billing: [billing], costs: [{user_id: billing.user_id, day: '2026-11-04', micros: 8_000_000}]});
  const s = setup({source, feed: fresh}), p = person(await get(s));
  assert.equal(p.cost.period, 2.5); assert.equal(p.cost.all_time, 8); assert.equal(p.margin, 27.5);
  assert.ok(Math.abs(p.margin_percent - 91.6666667) < .001); assert.equal(p.llm_default, true);
  // Spending on a partial payment boundary day no longer prevents an exact total.
  fresh.costs.push({user_id: billing.user_id, day: new Date(billing.period_start).toISOString().slice(0, 10), micros: 1_000_000});
  const check = async (row, expected) => {
    s.setFeed({...fresh, billing: [row]});
    assert.equal(person(await get(s)).cost.period, expected);
  };
  await check(billing, 2.5);
  await check({...billing, period_start: billing.period_start + DAY, period_end: billing.period_end - DAY}, 2.5);
  for (const patch of [{customer_id: 'different'}, {user_id: 'different'}, {period_start: billing.period_start + DAY + 1},
    {period_end: billing.period_end - DAY - 1}, {period_start: null}, {period_micros: null}]) await check({...billing, ...patch}, null);
  await check({...billing, period_micros: 0}, 0);
  assert.equal(person(await get(s)).margin, 30);
  await check(billing, 2.5);
  sub.current_period_start -= 120 * DAY / 1000;
  billing.period_start = sub.current_period_start * 1000; s.clock.at += 60_001;
  await check(billing, 2.5);
  s.setFeed({...fresh, generated_at: NOW - 49 * 3600_000});
  const stale = await get(s); assert.equal(stale.json.feed.state, 'stale'); assert.equal(person(stale).cost.period, null); assert.equal(person(stale).cost.all_time, null);
  await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', llm_covered: 0});
  assert.equal(person(await get(s)).margin, 30); assert.equal(person(await get(s)).margin_label, 'LLM not on us');
  sub.items.data[0].price.currency = 'sar'; s.clock.at += 60_001;
  assert.equal(person(await get(s)).margin, null);
});

test('only Plus and Pro public costs can establish margin when we cover LLM', async () => {
  const source = structuredClone(fixture), sub = source.subscriptions[0];
  const s = setup({source, feed: feed({billing: [{user_id: 'user-fixture-1', customer_id: sub.customer,
    period_start: sub.current_period_start * 1000, period_end: sub.current_period_end * 1000, period_micros: 2_500_000}],
    costs: [{user_id: 'user-fixture-1', day: '2026-11-04', micros: 2_500_000}]})});
  for (const plan of ['private', 'enterprise', 'other']) {
    sub.items.data[0].price.lookup_key = plan + '_monthly'; s.clock.at += 60_001;
    for (const llm_covered of [null, 1, 0]) {
      await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', llm_covered});
      const p = person(await get(s)); assert.equal(p.cost.period, null); assert.equal(p.cost.all_time, null); assert.equal(p.cost.reason, 'Link a server');
      assert.equal(p.margin, llm_covered === 0 ? 30 : null);
    }
  }
});

test('private requests become leads, merge into paying user, and preserve edited overlays across source refreshes', async () => {
  const requestRow = {user_id: 'new-private', plan: 'private', business: 'Invented Studio', people: 4, identity: 'work', language: 'en', requested_at: NOW, ready_at: null, contact: {channel: 'whatsapp', address_digits: '966555123456'}};
  const s = setup({feed: feed({private_requests: [requestRow]})});
  let result = await get(s), lead = result.json.people.find(p => p.id === 'canary:new-private');
  assert.equal(lead.source, 'Private request'); assert.equal(lead.phone, '966555123456'); assert.equal(lead.paying, undefined);
  assert.equal((await post(s, '/api/clients/update', {id: 'canary:new-private', tag: 'hot', company: 'Owner edit', notes: 'Keep this', follow_up: '2026-11-05'})).status, 200);
  requestRow.business = 'Source changed'; s.setFeed(feed({private_requests: [requestRow]}));
  s.source.subscriptions[0].metadata.mastan_user_id = 'new-private'; s.clock.at += 60_001;
  result = await get(s); const merged = person(result);
  assert.equal(result.json.people.filter(p => p.canary_user_id === 'new-private').length, 1);
  assert.equal(merged.tag, 'hot'); assert.equal(merged.company, 'Owner edit'); assert.equal(merged.notes, 'Keep this'); assert.equal(merged.follow_up, '2026-11-05');
  assert.equal(merged.name, fixture.customers[0].name); assert.equal(merged.tag_default, false);
  await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', notes: 'Still here'}); s.clock.at += 60_001;
  assert.equal(person(await get(s)).notes, 'Still here');
});

test('billing joins requests without guessing a cost user; canary delete only clears local notes', async () => {
  const requestRow = {user_id: 'billing-request', plan: 'private', business: 'Invented business', requested_at: NOW};
  const s = setup({feed: feed({private_requests: [requestRow], billing: [{user_id: 'billing-request', customer_id: 'cus_fixture1'}],
    costs: [{user_id: 'billing-request', day: '2026-11-04', micros: 1_000_000}]})});
  const result = await get(s);
  assert.equal(result.json.people.length, fixture.customers.length); assert.equal(person(result).private_request.user_id, 'billing-request');
  assert.equal(person(result).cost.period, null);
  const local = setup({mode: 'sample', feed: feed({private_requests: [requestRow]})});
  await post(local, '/api/clients/update', {id: 'canary:billing-request', notes: 'Local note', tag: 'hot'});
  await post(local, '/api/clients/log', {id: 'canary:billing-request', text: 'Called'});
  await post(local, '/api/clients/delete', {id: 'canary:billing-request'});
  const lead = (await get(local)).json.people.find(p => p.id === 'canary:billing-request');
  assert.ok(lead); assert.equal(lead.tag, null); assert.equal(lead.events.length, 0); assert.ok(!lead.notes);
});

test('manual email dedup keeps CRM fields, logs Riyadh contact day, delete clears only overlays or manual leads', async () => {
  const s = setup({clock: {at: Date.parse('2026-11-05T22:30:00Z')}});
  const created = await post(s, '/api/clients', {name: 'Manual name', email: 'FIXTURE1@example.invalid', tag: 'warm', notes: 'Keep manual note', follow_up: '2026-11-06'});
  assert.equal(created.status, 201);
  let result = await get(s), p = person(result);
  assert.equal(result.json.people.length, fixture.customers.length); assert.equal(p.name, fixture.customers[0].name); assert.equal(p.notes, 'Keep manual note'); assert.equal(p.tag, 'warm');
  assert.equal((await post(s, '/api/clients/log', {id: 'stripe:cus_fixture1', text: 'Called about renewal'})).status, 200);
  p = person(await get(s)); assert.equal(p.last_contact, '2026-11-06'); assert.equal(p.events[0].text, 'Called about renewal');
  assert.equal((await post(s, '/api/clients/delete', {id: 'stripe:cus_fixture1'})).status, 200);
  p = person(await get(s)); assert.equal(p.tag, null); assert.equal(p.tag_label, 'Customer'); assert.equal(p.tag_default, true); assert.equal(p.events.length, 0);
  assert.equal(s.source.customers.length, fixture.customers.length);
  const manual = await post(s, '/api/clients', {name: 'Delete me'}), id = manual.json.id;
  await post(s, '/api/clients/log', {id, text: 'One note'});
  await post(s, '/api/clients/delete', {id});
  assert.ok(!(await get(s)).json.people.some(row => row.id === id)); assert.equal(db.prepare('SELECT count(*) AS n FROM client_events').get().n, 0);
  assert.equal((await post(s, '/api/clients/update', {id: 'not-a-person'})).status, 404);
});

test('server links validate, refuse duplicates, survive notes and can be cleared or reassigned', async () => {
  const s = setup({fleet: fleet()});
  const result = await get(s);
  assert.deepEqual(result.json.servers, [{name: 'studio-01', client: 'Invented Studio'}]);
  for (const server of ['missing', 'x'.repeat(65), 42, {}, true]) {
    assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', server})).status, 400);
  }
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', server: 'studio-01'})).status, 200);
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', notes: 'Keep link'})).status, 200);
  assert.equal(person(await get(s)).server, 'studio-01');
  const duplicate = await post(s, '/api/clients/update', {id: 'stripe:cus_fixture2', server: 'studio-01'});
  assert.equal(duplicate.status, 400); assert.match(duplicate.text, /already linked to another person/);
  assert.equal((await post(s, '/api/clients', {name: 'Duplicate lead', server: 'studio-01'})).status, 400);
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', server: null})).status, 200);
  const lead = await post(s, '/api/clients', {name: 'Server lead', server: 'studio-01'});
  assert.equal(lead.status, 201);
  assert.equal((await get(s)).json.people.find(p => p.id === lead.json.id).server, 'studio-01');
  assert.equal((await post(s, '/api/clients/update', {id: lead.json.id, server: ''})).status, 200);
  // The transaction also prevents concurrent writes from linking two people.
  const concurrent = await Promise.all(['cus_fixture1', 'cus_fixture2'].map(id => post(s, '/api/clients/update', {id: 'stripe:' + id, server: 'studio-01'})));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 400]);
});

test('unavailable Fleet accepts only plain server names and readable stale Fleet still validates membership', async () => {
  const s = setup();
  for (const server of ['has space', '../bad/path', '<script>', 'é', 'x'.repeat(65)]) {
    assert.equal((await post(s, '/api/clients', {name: 'Lead', server})).status, 400);
  }
  const lead = await post(s, '/api/clients', {name: 'Offline link', server: 'manual_server-01.example'});
  assert.equal(lead.status, 201);
  assert.equal((await get(s)).json.people.find(p => p.id === lead.json.id).cost.reason, 'Fleet data is old');
  writeFileSync(s.fleetFile, JSON.stringify(fleet({generated_at: NOW / 1000 - 49 * 3600})));
  assert.equal((await post(s, '/api/clients/update', {id: lead.json.id, server: 'unknown'})).status, 400);
});

test('server cost uses Riyadh day boundaries on any plan, replaces public cost and keeps rent out of margin', async () => {
  const source = structuredClone(fixture), sub = source.subscriptions[0];
  // These UTC evenings fall on the following Riyadh days.
  sub.current_period_start = Date.parse('2026-11-01T22:15:00Z') / 1000;
  sub.current_period_end = Date.parse('2026-11-04T22:15:00Z') / 1000;
  const row = (day, cost, server = 'studio-01') => ({server, day, input: 100, output: 20, cost, model: 'never-send-model', source: 'never-send-source'});
  const s = setup({source, feed: feed({billing: [{user_id: sub.metadata.mastan_user_id, customer_id: sub.customer,
    period_start: sub.current_period_start * 1000, period_end: sub.current_period_end * 1000, period_micros: 9_000_000}]}),
  fleet: fleet({servers: [...fleet().servers, {name: 'internal', kind: 'Internal', client: 'Hidden option', connected: true, last_ok: NOW / 1000, ip: 'never-send-ip'}],
    usage: [row('2026-11-01', 100), row('2026-11-02', 1.25), row('2026-11-03', 2), row('2026-11-04', 3.75), row('2026-11-05', 100), row('2026-11-03', 100, 'other')],
    daily: [{secret: 'never-send-daily'}], invoices: [{secret: 'never-send-invoice'}]})});
  await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', server: 'studio-01', llm_covered: 1});
  for (const plan of ['plus', 'pro', 'private', 'enterprise', 'other']) {
    sub.items.data[0].price.lookup_key = plan + '_monthly'; s.clock.at += 60_001;
    const result = await get(s), p = person(result);
    assert.equal(p.cost.period, 7); assert.equal(p.cost.source, 'Server studio-01'); assert.equal(p.cost.reason, null);
    assert.equal(p.cost.monthly_eur, 12.5); assert.equal(p.margin, 23); assert.equal(p.cost.last_30, null);
    assert.equal(p.cost.all_time, null); assert.deepEqual(result.json.servers, [{name: 'studio-01', client: 'Invented Studio'}]);
    assert.doesNotMatch(result.text, /never-send|"usage"|"daily"|"invoices"|"input"|"output"|"last_ok"|"connected"/);
  }
  const script = readFileSync(new URL('../src/web/public/clients.js', import.meta.url), 'utf8');
  assert.match(script, /Priced at API list price, not what we actually pay\./);
  assert.match(script, /LLM cost, last 30 days/); assert.match(script, /Server rent, /);
  assert.doesNotMatch(script, /\/api\/clients\/[^'"\s]*\$\{/);
});

test('server costs distinguish fresh zero, stale or bad data, missing reports and unpriced models', async () => {
  const s = setup({fleet: fleet()});
  await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', server: 'studio-01'});
  assert.equal(person(await get(s)).cost.period, 0); assert.equal(person(await get(s)).margin, 30);
  const reporting = patch => fleet({servers: [{...fleet().servers[0], ...patch}]});
  const row = (cost, day = '2026-11-05') => ({server: 'studio-01', day, input: 1, output: 1, cost});
  const cases = [
    ['{bad', 'Fleet data is old'], [null, 'Fleet data is old'], [{}, 'Fleet data is old'],
    [fleet({generated_at: NOW / 1000 - 48 * 3600 - 1}), 'Fleet data is old'],
    [fleet({servers: []}), 'Server not reporting'],
    [reporting({last_ok: NOW / 1000 - 48 * 3600 - 1}), 'Server not reporting'],
    [reporting({last_ok: null}), 'Server not reporting'], [reporting({connected: false}), 'Server not reporting'],
    [fleet({usage: [row(2), row(null)]}), 'Unpriced model'], [fleet({usage: [row(2), row(0)]}), 'Unpriced model'],
    [fleet({usage: [row(-1)]}), 'Fleet data is old'], [fleet({usage: [row(1, '2026-02-30')]}), 'Fleet data is old']
  ];
  for (const [value, reason] of cases) {
    writeFileSync(s.fleetFile, typeof value === 'string' ? value : JSON.stringify(value));
    const p = person(await get(s));
    assert.equal(p.cost.period, null); assert.equal(p.margin, null); assert.equal(p.cost.reason, reason);
  }
  rmSync(s.fleetFile); assert.equal(person(await get(s)).cost.reason, 'Fleet data is old');
  writeFileSync(s.fleetFile, JSON.stringify(reporting({last_ok: NOW / 1000 - 48 * 3600})));
  assert.equal(person(await get(s)).cost.period, 0);
  writeFileSync(s.fleetFile, JSON.stringify(fleet({generated_at: NOW / 1000 - 48 * 3600,
    usage: [row(null, '2020-01-01'), {...row(0), input: 0, output: 0}]})));
  assert.equal(person(await get(s)).cost.period, 0);
});

test('last 30 days includes today in Riyadh, requires reporting and never creates a payment margin', async () => {
  const clock = {at: Date.parse('2026-11-05T22:30:00Z')}; // Riyadh November 6.
  const row = (day, cost) => ({server: 'studio-01', day, input: 10, output: 1, cost});
  const s = setup({clock, fleet: fleet({usage: [row('2026-10-07', 100), row('2026-10-08', 1), row('2026-11-06', 2), row('2026-11-07', 100)]})});
  const created = await post(s, '/api/clients', {name: 'Server prospect', server: 'studio-01'}), id = created.json.id;
  let p = (await get(s)).json.people.find(p => p.id === id);
  assert.equal(p.cost.last_30, 3); assert.equal(p.cost.period, null); assert.equal(p.margin, null);
  assert.equal(p.cost.reason, 'Set LLM coverage to see margin');
  await post(s, '/api/clients/update', {id, llm_covered: 1});
  p = (await get(s)).json.people.find(p => p.id === id);
  assert.equal(p.cost.reason, null); assert.equal(p.margin, null);
  writeFileSync(s.fleetFile, JSON.stringify(fleet({usage: [row('2026-11-06', 0)]})));
  p = (await get(s)).json.people.find(p => p.id === id);
  assert.equal(p.cost.last_30, null); assert.equal(p.cost.reason, 'Unpriced model');
  writeFileSync(s.fleetFile, JSON.stringify(fleet()));
  assert.equal((await get(s)).json.people.find(p => p.id === id).cost.last_30, 0);
  // A Canary request also has no payment period.
  await post(s, '/api/clients/update', {id, server: ''});
  s.setFeed(feed({private_requests: [{user_id: 'server-request', plan: 'private', requested_at: NOW}]}));
  await post(s, '/api/clients/update', {id: 'canary:server-request', server: 'studio-01'});
  p = (await get(s)).json.people.find(p => p.id === 'canary:server-request');
  assert.equal(p.cost.last_30, 0); assert.equal(p.margin, null);
});

test('Private server margin requires coverage and LLM not on us keeps existing margin rules', async () => {
  const source = structuredClone(fixture); source.subscriptions[0].items.data[0].price.lookup_key = 'private_monthly';
  const s = setup({source, fleet: fleet({usage: [{server: 'studio-01', day: '2026-11-05', input: 10, output: 1, cost: 5}]})});
  await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', server: 'studio-01'});
  let p = person(await get(s)); assert.equal(p.cost.period, 5); assert.equal(p.margin, null); assert.equal(p.cost.reason, 'Set LLM coverage to see margin');
  await post(s, '/api/clients/update', {id: p.id, llm_covered: 1});
  p = person(await get(s)); assert.equal(p.margin, 25); assert.equal(p.cost.reason, null);
  await post(s, '/api/clients/update', {id: p.id, llm_covered: 0}); rmSync(s.fleetFile);
  p = person(await get(s)); assert.equal(p.margin, 30); assert.equal(p.cost.period, null); assert.equal(p.margin_label, 'LLM not on us');
});

test('existing clients tables gain server once and keep stored overlays', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const {createClientsStore} = await import('../src/clients/store.js');
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec(db.prepare("SELECT sql FROM sqlite_master WHERE name='clients'").get().sql.replace(', server TEXT', ''));
    legacy.prepare('INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,?,?,?,?)').run('legacy', 'Existing lead', 'Keep notes', NOW, NOW);
    const store = createClientsStore(legacy); createClientsStore(legacy);
    assert.equal(store.rows()[0].notes, 'Keep notes'); assert.equal(store.rows()[0].server, null);
    store.save({server: 'studio-01'}, {ids: ['legacy'], now: NOW});
    assert.equal(store.rows()[0].server, 'studio-01'); assert.equal(store.rows()[0].notes, 'Keep notes');
  } finally { legacy.close(); }
});

test('POST reuses any last good Canary data without fetching, including during a refresh', async () => {
  let pending = false, finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const s = setup({canaryFetch: async () => {
    if (!pending) return JSON.stringify(feed());
    entered(); return new Promise(resolve => { finish = resolve; });
  }});
  await get(s); assert.equal(s.canaryCalls.length, 1);
  s.clock.at += 60_001;
  assert.equal((await post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', notes: 'Saved past cache expiry'})).status, 200);
  assert.equal(s.canaryCalls.length, 1);
  s.clock.at += 49 * 3600_000;
  assert.equal((await post(s, '/api/clients/log', {id: 'stripe:cus_fixture1', text: 'Saved with stale Canary'})).status, 200);
  assert.equal(s.canaryCalls.length, 1);
  pending = true;
  const loading = request('/api/clients?refresh=1', s);
  await started;
  let timer;
  try {
    const saved = await Promise.race([post(s, '/api/clients/update', {id: 'stripe:cus_fixture1', notes: 'Saved during refresh'}),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Save waited on SSH')), 1000); })]);
    assert.equal(saved.status, 200); assert.equal(s.canaryCalls.length, 2);
  } finally { clearTimeout(timer); finish(JSON.stringify(feed())); await loading; }
});

test('Canary failure exposes a warning and makes public cost Unknown after 48 hours', async () => {
  let broken = false;
  const sub = fixture.subscriptions[0], logged = [], old = console.error;
  const s = setup({canaryFetch: async () => {
    if (broken) throw Object.assign(new Error('never-log-fixture'), {code: 255, stdout: 'never-log-fixture', stderr: 'never-log-fixture'});
    return JSON.stringify(feed({billing: [{user_id: sub.metadata.mastan_user_id, customer_id: sub.customer,
      period_start: sub.current_period_start * 1000, period_end: sub.current_period_end * 1000, period_micros: 2_500_000}]}));
  }});
  console.error = line => logged.push(line);
  try {
    assert.equal(person(await get(s)).cost.period, 2.5);
    broken = true; s.clock.at += 60_000;
    const failed = await get(s);
    assert.equal(person(failed).cost.period, 2.5);
    assert.equal(failed.json.feed.warning, 'Canary unavailable, showing data from 15:00');
    s.clock.at = NOW + 48 * 3600_000 + 1;
    const stale = await get(s);
    assert.equal(stale.json.feed.state, 'stale'); assert.equal(person(stale).cost.period, null); assert.equal(person(stale).margin, null);
    assert.equal(stale.json.feed.generated_at, NOW); assert.equal(stale.json.feed.warning, failed.json.feed.warning);
    assert.deepEqual(logged, ['[clients] canary 255', '[clients] canary 255']);
    assert.doesNotMatch(logged.join(' '), /never-log-fixture/);
    const script = readFileSync(new URL('../src/web/public/clients.js', import.meta.url), 'utf8');
    assert.match(script, /role: 'alert', text: data\.feed\.warning/); assert.match(script, /Canary data from/);
    assert.doesNotMatch(script, /uploaded|scheduled|Canary feed/);
  } finally { console.error = old; }
});

test('export query selects only eligible users, requester contact and UTC daily costs without writes', () => {
  const script = readFileSync(new URL('../deploy/canary/clients-export.py', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|ATTACH)\b/i);
  assert.deepEqual(script.match(/PRAGMA[^'\n]*/gi), ['PRAGMA query_only=ON']);
  assert.doesNotMatch(script, /environ|sys\.argv/);
  const check = `
import contextlib, datetime, io, json, sqlite3, sys
db = sqlite3.connect(':memory:')
db.executescript('''CREATE TABLE users(user_id TEXT,is_test INTEGER,minor INTEGER);
CREATE TABLE public_private_requests(user_id TEXT,plan TEXT,business TEXT,people INTEGER,identity TEXT,language TEXT,requested_at INTEGER,ready_at INTEGER);
CREATE TABLE public_billing(user_id TEXT,customer_id TEXT,plan TEXT,status TEXT,period_start INTEGER,period_end INTEGER,payment_problem INTEGER);
CREATE TABLE identities(user_id TEXT,channel TEXT,address_digits TEXT,created_at INTEGER);
CREATE TABLE public_costs(user_id TEXT,micros INTEGER,created_at INTEGER);''')
now = int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)
db.executemany('INSERT INTO users VALUES(?,?,?)', [('paid',0,0),('request',0,0),('test',1,0),('minor',0,1),('outsider',0,0)])
db.executemany('INSERT INTO public_billing VALUES(?,?,?,?,?,?,?)', [(u,'cus_'+u,'pro','active',now-1000,now+1000,0) for u in ('paid','test','minor')])
db.execute('INSERT INTO public_private_requests VALUES(?,?,?,?,?,?,?,?)', ('request','private','Invented',4,'work','en',now,None))
db.executemany('INSERT INTO identities VALUES(?,?,?,?)', [('outsider','whatsapp','unrelated',now+1000),('request','whatsapp','own-number',now)])
db.executemany('INSERT INTO public_costs VALUES(?,?,?)', [(u,1000000,now) for u in ('paid','request','test','minor','outsider')]+[('paid',250000,now),('paid',9000000,now-401*86400000),('paid',3000000,now+1000),('paid',4000000,now-1000),('paid',5000000,now-1001)])
db.set_authorizer(lambda op,a,b,*args: sqlite3.SQLITE_OK if op in (sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION) or op == sqlite3.SQLITE_PRAGMA and a == 'query_only' and b == 'ON' else sqlite3.SQLITE_DENY)
calls = []
def connect(file, **kwargs):
    assert file == 'file:/var/lib/mastan-public/me.sqlite?mode=ro' and kwargs == {'uri':True}
    calls.append(file)
    return db
sqlite3.connect = connect
out = io.StringIO()
with contextlib.redirect_stdout(out): exec(sys.stdin.read())
feed = json.loads(out.getvalue())
assert len(out.getvalue().splitlines()) == 1 and isinstance(feed['generated_at'], str)
assert len(calls) == 1 and feed['version'] == 1
assert [r['user_id'] for r in feed['private_requests']] == ['request']
assert feed['private_requests'][0]['contact'] == {'channel':'whatsapp','address_digits':'own-number'}
assert [r['user_id'] for r in feed['billing']] == ['paid']
assert feed['billing'][0]['period_micros'] == 5250000
assert {r['user_id']:r['micros'] for r in feed['costs']} == {'paid':13250000,'request':1000000}
assert all(r['day'] == datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d') for r in feed['costs'])
`;
  execFileSync('python3', ['-c', check], {input: script});
});

test('export failures produce no stdout and only the exception class on stderr', () => {
  const script = readFileSync(new URL('../deploy/canary/clients-export.py', import.meta.url), 'utf8');
  for (const failAt of ['connect', 'query']) {
    const check = `
import sqlite3, sys
class Broken:
    def execute(self, *args): raise sqlite3.OperationalError('never-print-fixture')
def connect(*args, **kwargs):
    if '${failAt}' == 'connect': raise sqlite3.OperationalError('never-print-fixture')
    return Broken()
sqlite3.connect = connect
exec(sys.stdin.read())
`;
    const result = spawnSync('python3', ['-B', '-c', check], {input: script, encoding: 'utf8', env: {...process.env, SSH_ORIGINAL_COMMAND: 'never-use-command'}});
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'OperationalError\n');
  }
});

test('People fields, session-only membership and duplicate opening; invalid picks store nobody else', async () => {
  const s = setup();
  const selected = {name: 'Invented picked person', phone: '+994555000111', person_id: '+994555000111', country: 'AZ', language: 'az', source: 'People'};
  const added = await post(s, '/api/clients', selected); assert.equal(added.status, 201);
  for (const input of [selected, {name: 'Typed duplicate', phone: '994 (555) 000-111'}]) {
    const duplicate = await post(s, '/api/clients', input); assert.equal(duplicate.status, 409); assert.equal(duplicate.json.existing_id, added.json.id);
  }
  for (const input of [{...selected, masked: true}, {...selected, person_id: 'You'}, {...selected, person_id: 'ID not found'}]) assert.equal((await post(s, '/api/clients', input)).status, 400);
  const ids = await post(s, '/api/clients/person-ids', {}); assert.deepEqual(ids.json, {person_ids: ['+994555000111']});
  assert.equal((await request('/api/clients/person-ids', s)).status, 405);
  assert.equal((await post({...s, session: operator}, '/api/clients/person-ids', {})).status, 404);
  assert.equal((await post({...s, session: null}, '/api/clients/person-ids', {})).status, 404);
  assert.equal((await post(s, '/api/clients/person-ids', {person_id: selected.person_id})).status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM clients').get().n, 1);
});

test('accounts stay private in all client responses, old export stays unknown, manual phone matches once', async () => {
  const account = {user_id: 'u_match_invented', status: 'active', minor: false, plan: 'pro', source: 'manual', free_forever: true, language: 'az', identities: [{channel: 'whatsapp', kind: 'pn', address_digits: '994555000222'}]};
  const s = setup({feed: feed({accounts: [account, {...account, user_id: 'u_never_picked', identities: [{channel: 'telegram', kind: 'id', address_digits: '1234567'}]}], costs: [{user_id: account.user_id, day: '2026-11-05', micros: 3000000}]})});
  const added = await post(s, '/api/clients', {name: 'Invented manual match', phone: '+994555000222'});
  const result = await get(s), p = result.json.people.find(p => p.canary_user_id === account.user_id);
  assert.equal(p.account, 'found'); assert.equal(p.margin, -3); assert.equal(p.cost.last_30, 3);
  assert.equal(db.prepare('SELECT canary_user_id FROM clients WHERE id=?').get(added.json.id).canary_user_id, account.user_id);
  for (const response of [result, await post(s, '/api/clients/person-ids', {}), await post(s, '/api/clients/deals/copy', {id: p.id})]) assert.doesNotMatch(response.text, /accounts|identities|address_digits|u_never_picked|1234567|free_forever|_account|_subscription/);
  s.setFeed(feed()); assert.equal((await get(s)).json.people.find(p => p.canary_user_id === account.user_id).account, 'unknown');
});

test('deals POST body ids, sample and operator refusals, preview output and no automatic waiting application', async () => {
  const s = setup({feed: feed({accounts: []})}), selected = await post(s, '/api/clients', {name: 'Invented waiting', person_id: 'Telegram 456789', phone: 'Telegram 456789', source: 'People'});
  const input = {id: selected.json.id, kind: 'free', plan: 'pro', duration: 'months', months: 2, reason: 'Invited supporter'};
  const preview = await post(s, '/api/clients/deals/preview', input); assert.equal(preview.status, 200); assert.equal(preview.json.state, 'waiting');
  assert.doesNotMatch(preview.text, /user_id|price_id|product_id|accounts|identities/);
  assert.equal((await post(s, '/api/clients/deals/apply', {...input, extra: 1})).status, 400);
  assert.equal((await post(s, '/api/clients/deals/apply', input, {csrf: false})).status, 403);
  assert.equal((await post({...s, session: operator}, '/api/clients/deals/apply', input)).status, 404);
  assert.equal((await post(s, '/api/clients/deals/apply', input)).status, 200);
  const copy = await post(s, '/api/clients/deals/copy', {id: selected.json.id}); assert.equal(copy.json.link, 'https://mastan.ai');
  const account = {user_id: 'u_later', status: 'active', minor: false, plan: 'free', source: 'free', free_forever: false, language: 'en', identities: [{channel:'telegram',kind:'id',address_digits:'456789'}]};
  s.setFeed(feed({accounts: [account]})); const p = (await get(s)).json.people.find(p => p.person_id === 'Telegram 456789'); assert.equal(p.account, 'found'); assert.equal(p.deal.state, 'waiting');
  assert.equal((await post(s, '/api/clients/deals/apply', {...input, id: p.id})).status, 400, 'no public token');
  for (const path of ['/api/clients/deals/apply/'+p.id, '/api/clients/deals/'+p.id+'/end']) assert.equal((await post(s, path, {})).status, 404);
  const sample = setup({mode: 'sample'}); for (const action of ['preview','apply','end','send']) assert.equal((await post(sample, '/api/clients/deals/'+action, {id:'sample:0'})).status, 400);
});

test('deal sync wrong tokens receive 401 without a session; only POST accepted', async () => {
  const s = setup();
  assert.equal((await request('/api/client-deals/sync', {...s, session: null, method: 'POST', body: {acks: []}})).status, 401);
  assert.equal((await request('/api/client-deals/sync', {...s, session: null})).status, 405);
});

test('deal page sends cancellation consent only after accepting a confirmation that states it', async () => {
  const ui = readFileSync(new URL('../src/web/public/clients.js', import.meta.url), 'utf8');
  const sectionSource = ui.slice(ui.indexOf('  function dealSection('), ui.indexOf('\n  function detail('));
  for (const cancel_paid of [true, false]) {
    const nodes = [], timers = new Map(), writes = [], confirmations = [];
    let accepted = false, timerId = 0;
    const h = (tag, attrs = {}, ...children) => {
      const node = {tag, value: '', disabled: false, ...attrs, children: children.flat().filter(Boolean), isConnected: true,
        append(...more) { this.children.push(...more.flat().filter(Boolean)); },
        replaceChildren(...more) { this.children = more.flat().filter(Boolean); },
        addEventListener() {}, querySelector(selector) { return this.children.find(child => selector === `[value="${child.value}"]`); }};
      nodes.push(node); return node;
    };
    const proposal = {kind: 'free', label: 'Free, Plus, forever', reason: 'Invented supporter', pay_cents: 0, list_cents: 1000,
      given_up: 10, ends_at: null, llm_cost: null, target: 'public', state: 'draft', connected: true, cancel_paid};
    const dealSection = runInNewContext(sectionSource + '\ndealSection', {
      h, data: {mode: 'test', deals: {ready: true}},
      button: (text, onclick, attrs = {}) => h('button', {text, onclick, ...attrs}),
      select: (values, value, attrs = {}) => h('select', {value, ...attrs}, values.map(([value, text]) => h('option', {value, text}))),
      money: String, date: String, busy: (node, state) => { node.disabled = state; }, load: async () => {},
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
      confirm: text => {
        assert.equal(writes.filter(w => w.action === 'deals/apply').length, 0);
        if (cancel_paid) assert.match(text, /Their paid subscription will be cancelled.*with no refund/);
        else assert.doesNotMatch(text, /paid subscription will be cancelled/);
        confirmations.push(text); return accepted;
      },
      write: async (action, p, fields) => {
        if (action === 'deals/apply') assert.equal(accepted, true);
        writes.push({action, fields: {...fields}}); return proposal;
      },
    });
    dealSection({id: 'invented', name: 'Invented person', account: 'found', paying: true}, () => {});
    nodes.find(n => n['aria-label'] === 'Reason, required').value = 'Invented supporter';
    while (timers.size) { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); }
    const apply = nodes.find(n => n.tag === 'button' && n.text === 'Apply');
    assert.equal(apply.disabled, false); assert.ok(!Object.hasOwn(writes[0].fields, 'cancel_paid'));
    await apply.onclick(); assert.equal(writes.filter(w => w.action === 'deals/apply').length, 0);
    accepted = true; await apply.onclick();
    assert.equal(confirmations.length, 2);
    const sent = writes.filter(w => w.action === 'deals/apply');
    assert.equal(sent.length, 1); assert.equal(sent[0].fields.cancel_paid, cancel_paid);
  }
});

test('a monthly plan token starting with d_ opens its own Checkout; deal and unknown d_ tokens are unchanged', async () => {
  const s = setup(), posts = [];
  const transport = async (url, init) => {
    const path = new URL(url).pathname, ok = value => ({ok: true, json: async () => value});
    if (path === '/v1/prices') return ok({data: [{id: 'price_pro', product: 'prod_pro', active: true, unit_amount: 3000, currency: 'usd', lookup_key: 'pro_monthly', recurring: {interval: 'month'}}]});
    assert.equal(path, '/v1/checkout/sessions'); posts.push(Object.fromEntries(new URLSearchParams(init.body)));
    return ok({id: 'cs_invented_' + posts.length, url: 'https://checkout.stripe.com/c/invented' + posts.length});
  };
  s.handler = createWeb({db, config: {...config, stripeBillingKeyFile: s.key}, atlas: {stats: () => ({})}}, {stripeTransport: transport, now: () => NOW});
  const planToken = 'd_' + 'p'.repeat(43), dealToken = 'q'.repeat(43);
  db.prepare('INSERT INTO client_billing(client_id,amount_cents,state,pay_token,updated_at) VALUES(?,?,?,?,?)').run('plan_d_token', 5000, 'requested', planToken, NOW);
  db.prepare('INSERT INTO client_deals VALUES(?,?,?,?,?,?)').run('deal_d_token', 'deal_d_token', 'link', JSON.stringify({kind: 'discount_percent', plan: 'pro', duration: 'months', months: 3, pay_token: dealToken, session_id: null,
    list_cents: 3000, product_id: 'prod_pro', coupon_id: 'coupon_invented', user_id: 'u_invented'}), NOW, NOW);
  const plan = await request('/pay/' + planToken, {...s, session: null});
  assert.equal(plan.status, 303); assert.equal(plan.headers.location, 'https://checkout.stripe.com/c/invented1');
  assert.equal(posts[0]['line_items[0][price_data][unit_amount]'], '5000'); assert.equal(posts[0]['subscription_data[metadata][mastan_client_id]'], 'plan_d_token');
  const deal = await request('/pay/d_' + dealToken, {...s, session: null});
  assert.equal(deal.status, 303); assert.equal(deal.headers.location, 'https://checkout.stripe.com/c/invented2');
  assert.equal(posts[1]['discounts[0][coupon]'], 'coupon_invented');
  const unknown = await request('/pay/d_' + 'u'.repeat(43), {...s, session: null});
  assert.equal(unknown.status, 200); assert.match(unknown.text, /no longer active/); assert.equal(posts.length, 2);
});

test('deal payment return page only shows the note; the tick checks completion without creating sessions', async () => {
  const s = setup(), calls = [], sessions = new Map();
  const transport = async (url, init) => {
    const path = new URL(url).pathname; calls.push({path, method: init.method});
    const ok = value => ({ok: true, json: async () => value});
    if (path === '/v1/prices') return ok({data: [{id: 'price_pro', product: 'prod_pro', active: true, unit_amount: 3000, currency: 'usd', lookup_key: 'pro_monthly', recurring: {interval: 'month'}}]});
    if (path === '/v1/checkout/sessions') return ok({id: 'cs_new', url: 'https://checkout.stripe.com/c/invented'});
    return ok(sessions.get(path.split('/').pop()));
  };
  const ctx = {db, config: {...config, stripeBillingKeyFile: s.key}, atlas: {stats: () => ({})}};
  s.handler = createWeb(ctx, {stripeTransport: transport, now: () => NOW});
  const deals = createDeals(ctx, {transport, now: () => NOW});
  for (const [index, state] of ['absent', 'expired', 'complete'].entries()) {
    const id = 'return_' + state, token = String(index).repeat(43), session_id = state === 'absent' ? null : 'cs_' + state;
    if (session_id) sessions.set(session_id, {id: session_id, status: state, ...(state === 'complete' ? {subscription: 'sub_paid'} : {})});
    const details = {kind: 'discount_percent', plan: 'pro', duration: 'months', months: 3, pay_token: token, session_id,
      list_cents: 3000, product_id: 'prod_pro', coupon_id: 'coupon_invented', user_id: 'u_invented'};
    db.prepare('INSERT INTO client_deals VALUES(?,?,?,?,?,?)').run(id, id, 'link', JSON.stringify(details), NOW, NOW);
    for (const method of ['GET', 'HEAD']) {
      const response = await request('/pay/d_' + token + '/done', {...s, session: null, method});
      assert.equal(response.status, 200); assert.match(response.text, /Thank you\. If you completed the payment/);
      assert.equal(response.headers.location, undefined); assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(deals.view(id).current.state, 'link'); assert.equal(calls.length, 0);
  }
  await deals.tick();
  assert.equal(deals.view('return_complete').current.state, 'active');
  assert.equal(deals.view('return_expired').current.state, 'link');
  assert.ok(calls.length > 0); assert.ok(calls.every(c => c.method === 'GET'));
});
