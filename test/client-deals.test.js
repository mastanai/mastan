// Entire hub deal flow offline. Invented identities and keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDeals, FAILURE, COPY, addMonths} from '../src/clients/deals.js';
import {createClientsStore, normalizePersonId, pickable} from '../src/clients/store.js';
import {parseFeed, buildPeople, matchAccount, publicPerson, kpis} from '../src/clients/people.js';

const temp = mkdtempSync(join(tmpdir(), 'client-deals-')), key = join(temp, 'key'), NOW = Date.parse('2026-11-05T12:00:00Z'), DAY = 86400_000;
writeFileSync(key, 'rk_test_' + 'inventedDealKey');
test.after(() => rmSync(temp, {recursive: true, force: true}));
const databases = [];
test.afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const terms = patch => ({kind: 'discount_percent', plan: 'pro', duration: 'months', months: 3, value: 20, reason: 'Invented early supporter', note: '', ...patch});
// Same as the /pay route. A random token can itself contain "d_", so never split on it.
const payToken = link => new URL(link).pathname.slice('/pay/d_'.length);
function world({connect = true} = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const store = createClientsStore(db), id = store.save({name: 'Invented Person', person_id: '+994555000111', phone: '+994555000111', source: 'People'});
  const w = {db, store, id, at: NOW, calls: [], sessions: new Map(), subs: new Map(), events: [], status: 200};
  w.person = {id, name: 'Invented Person', person_id: '+994555000111', account: 'found', canary_user_id: 'u_invented', language: 'az', cost: {all_time: 4}, _account: {user_id: 'u_invented', status: 'active', minor: false}};
  w.transport = async (url, init) => {
    const u = new URL(url), path = u.pathname.replace('/v1', ''), fields = Object.fromEntries(new URLSearchParams(init.body || ''));
    w.calls.push({method: init.method, path, fields, query: Object.fromEntries(u.searchParams), headers: init.headers});
    const ok = value => ({ok: true, json: async () => value});
    if (w.status !== 200) return {ok: false, status: w.status, json: async () => ({secret: 'never-log-Stripe-body'})};
    if (path === '/prices') { const plan = u.searchParams.get('lookup_keys[]').split('_')[0]; return ok({data: [{id: 'price_' + plan, product: 'prod_' + plan, active: true, unit_amount: plan === 'pro' ? 3000 : 1000, currency: 'usd', lookup_key: plan + '_monthly', recurring: {interval: 'month'}}]}); }
    if (path === '/coupons') return ok({id: 'coupon_invented'});
    if (path === '/checkout/sessions' && init.method === 'POST') { const s = {id: 'cs_' + (w.sessions.size + 1), status: 'open', url: 'https://checkout.stripe.com/c/invented' + w.sessions.size}; w.sessions.set(s.id, s); return ok(s); }
    if (path.startsWith('/checkout/sessions/')) { const s = w.sessions.get(path.split('/')[3]); if (path.endsWith('/expire')) s.status = 'expired'; return ok(s); }
    if (path.startsWith('/subscriptions/')) { const s = w.subs.get(path.split('/')[2]); if (init.method === 'DELETE' && !path.endsWith('/discount')) s.status = 'canceled'; return ok(s); }
    throw new Error('Unexpected fake request');
  };
  w.billingCalls = [];
  w.billing = {stop: async id => w.billingCalls.push(['stop', id]), send: async (id, value) => w.billingCalls.push(['send', id, value]), link: () => 'https://me.example.com/pay/invented-server-link'};
  w.d = createDeals({db, store, billing: w.billing, config: {stripeBillingKeyFile: key, stripeBillingPaymentConfig: 'pmc_invented'}}, {transport: w.transport, now: () => w.at, onEvent: (_, text) => w.events.push(text)});
  if (connect) w.token = w.d.connect();
  w.sync = acks => w.d.sync('Bearer ' + w.token, {acks: acks || []});
  w.apply = patch => w.d.apply(id, w.person, terms(patch));
  w.current = () => w.d.view(id).current;
  w.paid = (plan = 'pro') => { w.person._subscription = {id: 'sub_invented', plan: plan === 'pro' ? 'Pro' : 'Plus', status: 'active'}; w.subs.set('sub_invented', {id: 'sub_invented', status: 'active', items: {data: [{price: {lookup_key: plan + '_monthly'}}]}}); };
  return w;
}

test('every coupon kind and duration uses exact Stripe fields and restricts the plan product', async () => {
  for (const kind of ['discount_percent', 'discount_amount', 'custom']) for (const duration of ['once', 'months', 'forever']) {
    if (kind === 'custom' && duration === 'once') continue;
    const w = world(); await w.apply({kind, duration, value: kind === 'custom' ? 12 : 20});
    const call = w.calls.find(c => c.path === '/coupons');
    assert.deepEqual(call.fields, {duration: duration === 'months' ? 'repeating' : duration, max_redemptions: '1', 'applies_to[products][0]': 'prod_pro',
      ...(duration === 'months' ? {duration_in_months: '3'} : {}), ...(kind === 'discount_percent' ? {percent_off: '20'} : {amount_off: kind === 'custom' ? '1800' : '2000', currency: 'usd'})});
    assert.deepEqual(w.calls[0].query, {'lookup_keys[]': 'pro_monthly', active: 'true'});
    assert.equal(w.current().state, 'link'); assert.equal(w.current().given_up, kind === 'discount_percent' ? 6 : kind === 'custom' ? 18 : 20);
    assert.match(w.current().link, /\/pay\/d_[\w-]+$/); assert.equal(w.calls.filter(c => c.method !== 'GET').length, 1);
  }
});
test('custom must be below list; input bounds and sample people cause zero Stripe writes', async () => {
  const w = world();
  for (const value of [30, 31]) await assert.rejects(w.apply({kind: 'custom', value}), /below/);
  for (const patch of [{reason: ''}, {value: 101}, {kind: 'wat'}, {months: 0}, {plan: 'private'}, {value: 1.111}]) await assert.rejects(w.apply(patch));
  w.person.sample = true; await assert.rejects(w.apply()); await assert.rejects(w.d.send(w.id, w.person, 'hello', 'en'));
  assert.ok(w.calls.every(c => c.method === 'GET')); assert.equal(w.current(), null);
});
test('public free plans refuse discounts and custom prices in preview and apply before Stripe calls', async () => {
  for (const free_forever of [true, 1]) for (const kind of ['discount_percent', 'discount_amount', 'custom']) {
    const w = world(); w.person._account.free_forever = free_forever;
    for (const run of [() => w.d.preview(w.person, terms({kind})), () => w.apply({kind})]) {
      await assert.rejects(run(), {message: 'They already have a free plan. End it first.'});
    }
    assert.equal(w.calls.length, 0); assert.equal(w.current(), null);
  }
  const w = world(); w.person._account.free_forever = true;
  await w.apply({kind: 'free'}); assert.equal(w.current().state, 'queued');
});
test('Checkout exact fields, customer, one open page, complete checked on page load', async () => {
  const w = world(); w.person.stripe_customer_id = 'cus_invented'; await w.apply();
  const token = payToken(w.current().link);
  const first = await w.d.payRedirect(token), again = await w.d.payRedirect(token); assert.deepEqual(first, again);
  const c = w.calls.find(c => c.path === '/checkout/sessions');
  assert.deepEqual(c.fields, {mode: 'subscription', 'line_items[0][quantity]': '1', 'line_items[0][price]': 'price_pro', 'discounts[0][coupon]': 'coupon_invented',
    client_reference_id: 'u_invented', 'subscription_data[metadata][mastan_user_id]': 'u_invented', customer: 'cus_invented', payment_method_configuration: 'pmc_invented',
    'consent_collection[terms_of_service]': 'required', 'tax_id_collection[enabled]': 'true', billing_address_collection: 'auto', success_url: c.fields.success_url, cancel_url: c.fields.success_url});
  assert.equal(c.fields.allow_promotion_codes, undefined); assert.equal(w.calls.filter(c => c.method === 'POST' && c.path === '/checkout/sessions').length, 1);
  Object.assign([...w.sessions.values()][0], {status: 'complete', subscription: 'sub_paid'}); await w.d.refresh(w.id);
  assert.equal(w.current().state, 'active'); assert.equal((await w.d.payRedirect(token)).page, 'paid');
  assert.equal(w.current().ends_at, addMonths(NOW, 3));
});
test('free paying: grant acknowledged before cancellation; failed grant never cancels; acks are idempotent', async () => {
  for (const status of ['done', 'failed']) {
    const w = world(); w.paid(); await w.apply({kind: 'free', cancel_paid: true});
    assert.equal(w.current().state, 'queued'); assert.ok(w.calls.every(c => c.method !== 'DELETE'));
    const [grant] = (await w.sync()).commands; assert.deepEqual(grant.params, {user: 'u_invented', plan: 'pro'});
    await w.sync([{id: grant.id, status, ...(status === 'failed' ? {reason: 'guard'} : {})}]);
    await w.sync([{id: grant.id, status, ...(status === 'failed' ? {reason: 'guard'} : {})}]);
    assert.equal(w.calls.filter(c => c.method === 'DELETE').length, status === 'done' ? 1 : 0);
    assert.equal(w.current().state, status === 'done' ? 'active' : 'failed');
  }
});
test('free with a live paid subscription requires the explicit boolean cancellation confirmation', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete']) {
    const w = world(); w.paid(); w.person._subscription.status = status; w.subs.get('sub_invented').status = status;
    assert.equal((await w.d.preview(w.person, terms({kind: 'free'}))).cancel_paid, true);
    for (const patch of [{}, ...[false, null, 'true', 1].map(cancel_paid => ({cancel_paid}))]) {
      await assert.rejects(w.apply({kind: 'free', ...patch}), {message: 'Their paid plan changed. Review the deal again before applying.'});
      assert.equal(w.current(), null); assert.equal((await w.sync()).commands.length, 0);
      assert.ok(w.calls.every(c => c.method === 'GET'));
    }
    await w.apply({kind: 'free', cancel_paid: true}); assert.equal(w.current().state, 'queued');
  }
});
test('failed paid cancellation after grant is retried without a second grant', async () => {
  const w = world(); w.paid(); await w.apply({kind: 'free', cancel_paid: true}); const [c] = (await w.sync()).commands;
  w.status = 503; await w.sync([{id: c.id, status: 'done'}]); assert.equal(w.current().state, 'active');
  w.status = 200; await w.d.tick(); assert.equal(w.subs.get('sub_invented').status, 'canceled'); assert.equal((await w.sync()).commands.length, 0);
});
test('free without a paid subscription uses no Stripe writes and needs no card', async () => {
  const w = world(); await w.apply({kind: 'free', duration: 'forever'}); const [c] = (await w.sync()).commands; await w.sync([{id: c.id, status: 'done'}]);
  assert.equal(w.current().ends_at, null); assert.ok(w.calls.every(c => c.method === 'GET')); assert.equal(w.current().link, null);
});
test('same plan subscription gets a coupon directly, another plan refuses before writes', async () => {
  const w = world(); w.paid(); await w.apply();
  assert.deepEqual(w.calls.find(c => c.path === '/subscriptions/sub_invented' && c.method === 'POST').fields, {coupon: 'coupon_invented'});
  assert.equal(w.current().state, 'active'); assert.equal(w.current().link, null);
  const other = world(); other.paid('plus'); await assert.rejects(other.apply(), /They are on Plus. Change the plan first./); assert.ok(other.calls.every(c => c.method === 'GET'));
});
test('waiting account saved, discovery never auto-applies, then explicit Apply; minor and inactive refuse', async () => {
  const w = world(); w.person.account = 'none'; w.person._account = null; await w.apply({kind: 'free'});
  assert.equal(w.current().state, 'waiting'); assert.equal(w.calls.filter(c => c.method !== 'GET').length, 0); assert.equal(w.d.copy(w.id).link, 'https://mastan.ai');
  w.person.account = 'found'; w.person._account = {user_id: 'u_invented', status: 'active', minor: false};
  await w.d.refresh(w.id); await w.d.tick(); assert.equal((await w.sync()).commands.length, 0);
  await w.apply({kind: 'free'}); assert.equal((await w.sync()).commands.length, 1);
  for (const patch of [{minor: true}, {status: 'paused'}]) { const bad = world(); Object.assign(bad.person._account, patch); await assert.rejects(bad.apply()); assert.equal(bad.calls.length, 0); }
});
test('end free queues end_grant; coupon removes only discount; unused link closed and open Checkout expired', async () => {
  const w = world(); await w.apply({kind: 'free'}); const [g] = (await w.sync()).commands; await w.sync([{id: g.id, status: 'done'}]); await w.d.end(w.id);
  const [end] = (await w.sync()).commands; assert.equal(end.kind, 'end_grant'); await w.sync([{id: end.id, status: 'done'}]); assert.equal(w.current(), null); assert.equal(w.d.view(w.id).history.length, 1);
  const paying = world(); paying.paid(); await paying.apply(); await paying.d.end(paying.id);
  assert.deepEqual(paying.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/subscriptions/sub_invented/discount']); assert.equal(paying.subs.get('sub_invented').status, 'active');
  const unused = world(); await unused.apply(); const token = payToken(unused.current().link); await unused.d.payRedirect(token); await unused.d.end(unused.id);
  assert.equal((await unused.d.payRedirect(token)).page, 'closed'); assert.equal([...unused.sessions.values()][0].status, 'expired');
});
test('months end on the calendar once; coupons expire in Stripe and only local state changes', async () => {
  const w = world(); await w.apply({kind: 'free', months: 1}); const [c] = (await w.sync()).commands; await w.sync([{id: c.id, status: 'done'}]);
  w.at = addMonths(NOW, 1); await w.d.tick(); await w.d.tick(); assert.deepEqual((await w.sync()).commands.map(c => c.kind), ['end_grant']);
  const p = world(); p.paid(); await p.apply({months: 1}); p.at = addMonths(NOW, 1); await p.d.tick(); assert.equal(p.current(), null); assert.equal(p.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.equal(new Date(addMonths(Date.parse('2027-01-31T10:00Z'), 1)).toISOString(), '2027-02-28T10:00:00.000Z');
});
test('own server supports Free and Custom price, reuses billing link, stores follow-up; disconnected servers are records', async () => {
  for (const kind of ['free', 'custom']) {
    const w = world(); w.person.billing = {connected: true, state: 'active'}; await w.apply({kind, value: 15, months: 1});
    assert.deepEqual(w.billingCalls, kind === 'free' ? [['stop', w.id]] : [['send', w.id, 15]]); assert.equal(w.current().given_up, null);
    assert.match(w.store.rows()[0].follow_up, /^2026-12-05$/); w.at += 60 * DAY; await w.d.tick(); assert.equal(w.current().state, 'active');
    if (kind === 'custom') assert.equal(w.d.copy(w.id).link, w.billing.link());
    await w.d.end(w.id); assert.equal(w.billingCalls.length, 1);
  }
  const bad = world(); bad.person.billing = {connected: true}; await assert.rejects(bad.apply(), /Free or Custom/);
  for (const fields of [{account: 'none', person_id: null, canary_user_id: null}, {server: 'disconnected'}]) {
    const w = world(); Object.assign(w.person, fields); await w.apply(); assert.equal(w.current().notice, 'Saved as a note. Nothing enforces this.'); assert.equal(w.calls.length, 0);
  }
});
test('target order keeps connected billing on server, linked servers as records, and public identities waiting', async () => {
  const cases = [
    [{}, 'record'], [{phone: 'Call 12345'}, 'record'], [{phone: '1234'}, 'record'],
    [{phone: '+994 (555) 000-111'}, 'public'], [{phone: 'Telegram 12345'}, 'public'],
    [{person_id: '+994555000111', people_origin: 'other', source: 'Client A'}, 'public'],
    [{canary_user_id: 'u_invented'}, 'public'], [{person_id: 'Telegram 12345'}, 'public'],
    [{account: 'found', source: 'Client A', people_origin: 'other'}, 'public'],
    [{server: 'disconnected', phone: '+994555000111', account: 'found'}, 'record'],
    [{billing: {connected: true, state: 'none'}, server: 'disconnected', person_id: 'Telegram 12345'}, 'server'],
  ];
  for (const [fields, target] of cases) {
    const w = world(); w.person = {id: w.id, name: 'Invented contact', ...fields};
    const proposal = await w.d.preview(w.person, terms({kind: 'free'}));
    assert.equal(proposal.target, target, JSON.stringify(fields));
    const waiting = target === 'public' && fields.account !== 'found';
    assert.equal(proposal.state, waiting ? 'waiting' : 'draft');
    await w.apply({kind: 'free'}); assert.equal(w.current().target, target);
    if (waiting) {
      assert.equal(w.current().state, 'waiting'); assert.equal(w.calls.filter(c => c.method !== 'GET').length, 0);
      assert.match(w.current().notice, /They need to write to Mastan first/);
    }
  }
});
test('Copy works without token; Send refuses without token; one say per click, fixed copy languages and exact text', async () => {
  const w = world(); await w.apply(); const copied = w.d.copy(w.id, 'ar'); assert.equal(copied.language, 'ar'); assert.equal(w.d.copy(w.id, 'xx').language, 'en');
  assert.deepEqual(Object.keys(COPY), ['en','az','ru','ar','tr']);
  const text = 'Exact chosen text'; await w.d.send(w.id, w.person, text, 'en'); assert.equal((await w.sync()).commands.length, 1);
  assert.deepEqual((await w.sync()).commands[0].params, {user: 'u_invented', text, link: copied.link}); assert.equal(w.current().delivery.state, 'Waiting');
  const c = (await w.sync()).commands[0]; await w.sync([{id: c.id, status: 'done'}]); assert.equal(w.current().delivery.state, 'Sent');
  w.db.exec('DELETE FROM client_deals_connection'); assert.ok(w.d.copy(w.id).text); await assert.rejects(w.d.send(w.id, w.person, text, 'en'), /not connected/);
  const disconnected = world({connect: false}); await assert.rejects(disconnected.apply(), /not connected/); assert.equal(disconnected.calls.filter(c => c.method !== 'GET').length, 0);
});
test('say expires after 24h; every fixed failure reason is shown, never free text', async () => {
  for (const reason of Object.keys(FAILURE)) {
    const w = world(); await w.apply(); await w.d.send(w.id, w.person, 'hello', 'en'); const [c] = (await w.sync()).commands;
    await w.sync([{id: c.id, status: 'failed', reason}]); assert.equal(w.current().delivery.reason, FAILURE[reason]);
  }
  const w = world(); await w.apply(); await w.d.send(w.id, w.person, 'hello', 'en'); w.at += DAY; assert.equal((await w.sync()).commands.length, 0); assert.match(w.current().delivery.reason, /write first/);
});
test('sync maps unknown reasons to error for messages, grants and end grants', async () => {
  for (const kind of ['say', 'grant', 'end_grant']) for (const reason of ['unknown private detail', 'toString', '__proto__']) {
    const w = world(); await w.apply(kind === 'say' ? {} : {kind: 'free'});
    if (kind === 'say') await w.d.send(w.id, w.person, 'hello', 'en');
    if (kind === 'end_grant') {
      const [g] = (await w.sync()).commands; await w.sync([{id: g.id, status: 'done'}]); await w.d.end(w.id);
    }
    const [c] = (await w.sync()).commands;
    await w.sync([{id: c.id, status: 'failed', reason}]);
    assert.equal(w.db.prepare('SELECT reason FROM client_deal_commands WHERE id=?').get(c.id).reason, 'error');
    if (kind === 'say') assert.equal(w.current().delivery.reason, FAILURE.error);
    else { assert.equal(w.current().failure, 'error'); assert.equal(w.current().failure_text, FAILURE.error); }
    assert.match(w.events.at(-1), /Something went wrong\. Try again\./);
    assert.ok(w.events.every(e => !e.includes(reason) && !e.includes('undefined')));
    assert.ok(!JSON.stringify(w.current()).includes(reason));
  }
});
test('sync authentication, rotation, strict acks, oldest first and command limit', async () => {
  const w = world(); assert.equal(await w.d.sync('Bearer wrong', {acks: []}), null); assert.equal(await w.d.sync('Bearer ' + 'x'.repeat(43), {acks: []}), null);
  const token = w.token; w.token = w.d.connect(); assert.equal(await w.d.sync('Bearer ' + token, {acks: []}), null);
  await w.apply(); for (let i = 0; i < 12; i++) await w.d.send(w.id, w.person, 'hello', 'en');
  const commands = (await w.sync()).commands; assert.equal(commands.length, 10); assert.deepEqual(commands.map(c => c.id), [...commands.map(c => c.id)].sort((a,b) => a-b));
  await assert.rejects(w.sync(Array.from({length: 51}, () => ({id: 1, status: 'done'}))));
  for (const ack of [{id: 1, status: 'failed'}, {id: 1, status: 'failed', reason: {}}, {id: 1, status: 'done', reason: 1}, {id: 1, status: 'other'}, {id: 1, status: 'done', extra: 1}]) await assert.rejects(w.sync([ack]), /valid command results/);
  const raw = JSON.stringify(w.db.prepare('SELECT hex(token_hash) AS hash FROM client_deals_connection').get()); assert.ok(!raw.includes(w.token));
});
test('403 safe message leaves deal unapplied, other Stripe errors sanitized, no private logs', async () => {
  for (const status of [403, 500]) {
    const w = world(); const logged = [], old = console.error; console.error = (...v) => logged.push(v);
    try { w.status = status; await assert.rejects(w.apply(), status === 403 ? /The Stripe key is missing a permission. Nothing changed./ : /Stripe did not answer. Nothing changed./); assert.equal(w.current(), null); assert.deepEqual(logged, []); }
    finally { console.error = old; }
  }
});
test('identity matching only exact one account; persistence includes only picked person; free costs and account output privacy', () => {
  const w = world();
  const account = {user_id: 'u_invented', status: 'active', minor: 0, plan: 'pro', source: 'free', free_forever: 1, language: 'az', identities: [{channel: 'whatsapp', kind: 'pn', address_digits: '994555000111'}]};
  const feed = parseFeed({version: 1, generated_at: NOW, private_requests: [], billing: [], costs: [{user_id: 'u_invented', day: '2026-11-05', micros: 2500000}], accounts: [account, {...account, user_id: 'u_unpicked', identities: [{channel: 'telegram', kind: 'id', address_digits: '4444'}]}]}, NOW);
  const people = buildPeople({people: []}, feed, w.store, NOW); assert.equal(people[0].account, 'found'); assert.equal(w.store.rows()[0].canary_user_id, 'u_invented'); assert.equal(w.store.rows().length, 1);
  assert.equal(people[0].cost.last_30, 2.5); assert.equal(people[0].margin, -2.5); assert.equal(people[0].margin_label, 'Cost with no revenue');
  assert.doesNotMatch(JSON.stringify(people.map(publicPerson)), /identities|address_digits|u_unpicked|free_forever/);
  assert.equal(matchAccount({phone: '+994 (555) 000-111'}, feed).account, 'found'); assert.equal(matchAccount({phone: 'Telegram 4444'}, feed).account, 'found');
  assert.equal(matchAccount({phone: '+994555000111'}, {...feed, accounts: [account, {...account, user_id: 'u_duplicate'}]}).account, 'none');
  assert.equal(matchAccount({phone: '+994555000111'}, {...feed, accounts: undefined}).account, 'unknown');
  const hidden = {...account, identities: [{channel: 'whatsapp', kind: 'lid', address_digits: '7890'}]}; assert.equal(matchAccount({person_id: 'WhatsApp hidden 7890'}, {...feed, accounts: [hidden]}).account, 'found');
  people[0].deal = {state: 'active', given_up: 30}; assert.equal(kpis(people, 'live').given_up, 30); assert.deepEqual(kpis(people, 'live').mrr, {});
});
test('picker rejects masked and special ids, and store refuses normalized typed duplicates', () => {
  const w = world(); for (const p of [{id: 'You'}, {id: 'ID not found'}, {id: '+994555000111', masked: true}]) assert.equal(pickable(p), false);
  assert.equal(pickable({id: 'Telegram 12345'}), true); assert.equal(normalizePersonId('994 (555) 000-111'), '+994555000111');
  assert.throws(() => w.store.save({name: 'Duplicate', phone: '+994 (555) 000-111'}), /already in Clients/);
  assert.throws(() => w.store.save({name: 'Duplicate', person_id: '+994555000111'}), /already in Clients/);
  const ui = readFileSync(new URL('../src/web/public/clients.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /\/api\/clients\/[^'"\s]*\$\{/); assert.match(ui, /pool = \[\]/); assert.match(ui, /MM.loadPeople/);
  assert.doesNotMatch(ui.slice(ui.indexOf('function peoplePicker'), ui.indexOf('function dealSection')), /localStorage|sessionStorage|console\.|location\./);
});


test('export accounts cover non-test users and free users enter cost eligibility, strictly read-only', async () => {
  const {execFileSync} = await import('node:child_process');
  const script = readFileSync(new URL('../deploy/canary/clients-export.py', import.meta.url), 'utf8');
  const check = `
import sqlite3, datetime, json, contextlib, io, sys
db = sqlite3.connect(':memory:')
db.executescript('''CREATE TABLE users(user_id TEXT,is_test INTEGER,minor INTEGER,status TEXT,language TEXT);
CREATE TABLE public_plans(user_id TEXT,plan TEXT,source TEXT,free_forever INTEGER);
CREATE TABLE public_billing(user_id TEXT,customer_id TEXT,plan TEXT,status TEXT,period_start INTEGER,period_end INTEGER,payment_problem INTEGER);
CREATE TABLE public_private_requests(user_id TEXT,plan TEXT,business TEXT,people INTEGER,identity TEXT,language TEXT,requested_at INTEGER,ready_at INTEGER);
CREATE TABLE identities(user_id TEXT,channel TEXT,kind TEXT,address_digits TEXT,created_at INTEGER);
CREATE TABLE public_costs(user_id TEXT,micros INTEGER,created_at INTEGER);''')
now = int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)
db.executemany('INSERT INTO users VALUES(?,?,?,?,?)', [('u_free',0,0,'active','az'),('u_other',0,0,'active','en'),('u_minor',0,1,'active','en'),('u_test',1,0,'active','en')])
db.execute('INSERT INTO public_plans VALUES(?,?,?,?)', ('u_free','pro','free',1))
db.executemany('INSERT INTO identities VALUES(?,?,?,?,?)', [('u_free','whatsapp','pn','994555000123',now),('u_other','telegram','id','456789',now)])
db.executemany('INSERT INTO public_costs VALUES(?,?,?)', [(u,1000000,now) for u in ('u_free','u_other','u_minor','u_test')])
db.set_authorizer(lambda op,a,b,*args: sqlite3.SQLITE_OK if op in (sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION) or op == sqlite3.SQLITE_PRAGMA and a == 'query_only' and b == 'ON' else sqlite3.SQLITE_DENY)
sqlite3.connect = lambda *args,**kwargs: db
out = io.StringIO()
with contextlib.redirect_stdout(out): exec(sys.stdin.read())
feed = json.loads(out.getvalue())
assert {r['user_id'] for r in feed['accounts']} == {'u_free','u_other','u_minor'}
free = next(a for a in feed['accounts'] if a['user_id'] == 'u_free')
assert free == {'user_id':'u_free','status':'active','minor':False,'plan':'pro','source':'free','free_forever':True,'language':'az','identities':[{'channel':'whatsapp','kind':'pn','address_digits':'994555000123'}]}
assert {r['user_id'] for r in feed['costs']} == {'u_free'}
`;
  execFileSync('python3', ['-B', '-c', check], {input: script});
});
test('coupon 403 after price read remains unapplied and can retry safely', async () => {
  const w = world(), transport = w.transport;
  const d = createDeals({db: w.db, config: {stripeBillingKeyFile: key}}, {transport: async (url, init) => new URL(url).pathname === '/v1/coupons' ? {ok:false,status:403} : transport(url, init)});
  await assert.rejects(d.apply(w.id, w.person, terms()), /Coupons set to Write/);
  assert.equal(d.view(w.id).current.state, 'draft'); assert.equal(d.view(w.id).current.link, null);
});
test('403 from subscriptions and Checkout uses the generic permission message', async () => {
  for (const path of ['/subscriptions/sub_invented', '/checkout/sessions']) {
    const w = world(); if (path.startsWith('/subscriptions/')) w.paid();
    const d = createDeals({db: w.db, config: {stripeBillingKeyFile: key}}, {transport: async (url, init) => new URL(url).pathname === '/v1' + path ? {ok: false, status: 403} : w.transport(url, init)});
    if (path === '/checkout/sessions') await d.apply(w.id, w.person, terms());
    const run = path === '/checkout/sessions' ? () => d.payRedirect(payToken(d.view(w.id).current.link)) : () => d.apply(w.id, w.person, terms());
    await assert.rejects(run(), {message: 'The Stripe key is missing a permission. Nothing changed.'});
    assert.equal(w.sessions.size, 0);
    if (path.startsWith('/subscriptions/')) assert.equal(d.view(w.id).current, null);
  }
});
test('failed coupon draft keeps its id and retries unchanged fields with the same key, changed terms with a new key', async () => {
  const w = world(), keys = new Map(), attempts = [];
  const d = createDeals({db: w.db, config: {stripeBillingKeyFile: key}}, {transport: async (url, init) => {
    if (new URL(url).pathname === '/v1/coupons') {
      const operation = init.headers['Idempotency-Key']; attempts.push(operation);
      if (keys.has(operation) && keys.get(operation) !== init.body) return {ok: false, status: 409};
      keys.set(operation, init.body);
      if (attempts.length < 3) return {ok: false, status: 503};
    }
    return w.transport(url, init);
  }});
  await assert.rejects(d.apply(w.id, w.person, terms()), /Stripe did not answer/);
  const id = d.view(w.id).current.id;
  await assert.rejects(d.apply(w.id, w.person, terms({reason: 'Updated note only'})), /Stripe did not answer/);
  await d.apply(w.id, w.person, terms({value: 25}));
  assert.equal(d.view(w.id).current.id, id); assert.equal(d.view(w.id).current.state, 'link');
  assert.equal(attempts[0], attempts[1]); assert.notEqual(attempts[0], attempts[2]);
  for (const operation of attempts) assert.ok(operation.startsWith(id + '-coupon-'));
});
test('same person concurrent Apply and Checkout calls make only one coupon, grant or session', async () => {
  const w = world(); const applied = await Promise.allSettled([w.apply(), w.apply()]); assert.equal(applied.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(w.calls.filter(c => c.path === '/coupons').length, 1);
  const token = payToken(w.current().link); await Promise.all([w.d.payRedirect(token), w.d.payRedirect(token)]);
  assert.equal(w.calls.filter(c => c.path === '/checkout/sessions').length, 1);
});
test('end-grant failure stays visible and may be explicitly retried', async () => {
  const w = world(); await w.apply({kind:'free'}); const [g] = (await w.sync()).commands; await w.sync([{id:g.id,status:'done'}]); await w.d.end(w.id);
  const [e] = (await w.sync()).commands; await w.sync([{id:e.id,status:'failed',reason:'error'}]); assert.equal(w.current().state, 'end_failed');
  await w.d.end(w.id); assert.equal((await w.sync()).commands.length, 1);
});

test('merging local notes keeps their deal and history on the surviving contact', async () => {
  const w = world(); await w.apply(); const extra = w.store.save({name:'An older overlay'});
  w.store.save({notes:'Merged'}, {ids:[extra,w.id]});
  assert.equal(w.d.view(extra).current.state, 'link'); assert.equal(w.d.view(w.id).current, null);
});
test('a second contact for the same account cannot open a second deal', async () => {
  const w = world(); await w.apply(); const id = w.store.save({name:'Other identity', person_id:'Telegram 12345'});
  await assert.rejects(w.d.apply(id, {...w.person, id, person_id:'Telegram 12345'}, terms()), /already has a deal/);
  assert.equal(w.calls.filter(c => c.path === '/coupons').length, 1);
});

test('ending a deal whose first-month coupon is already used still ends it', async () => {
  const w = world(); w.paid(); await w.apply();
  const transport = w.transport; w.transport = null;
  const d = createDeals({db: w.db, config: {stripeBillingKeyFile: key}}, {transport: async (url, init) => init.method === 'DELETE' && url.endsWith('/discount') ? {ok: false, status: 404, json: async () => ({})} : transport(url, init)});
  await d.end(w.id);
  assert.equal(d.view(w.id).current, null);
});
