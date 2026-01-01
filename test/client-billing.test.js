// Offline: the whole money timeline against a fake Stripe, driven by the same calls the page and the servers make.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const data = mkdtempSync(join(tmpdir(), 'client-billing-'));
process.env.MASTAN_ME_DATA = data;
const {openDb} = await import('../src/db.js');
const {config} = await import('../src/config.js');
const B = await import('../src/clients/billing.js');
const {createClientsStore} = await import('../src/clients/store.js');
const {DAY, HOUR} = B;
const db = openDb(), T0 = Date.parse('2026-11-05T12:00:00Z'), keyFile = join(data, 'key');
writeFileSync(keyFile, 'rk_test_inventedBillingFixture');
config.stripeBillingKeyFile = keyFile; config.stripeBillingPaymentConfig = 'pmc_fixture';
test.after(() => { db.close(); rmSync(data, {recursive: true, force: true}); });
let seq = 0;

function world() {
  const w = {at: T0, calls: [], sessions: new Map(), subs: new Map(), down: false, events: [], alerts: [], charges: []};
  w.transport = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1', ''), form = Object.fromEntries(new URLSearchParams(init.body || ''));
    w.calls.push({method: init.method, path, form, auth: init.headers.Authorization});
    if (w.down) return {ok: false, status: 503, json: async () => ({})};
    const ok = value => ({ok: true, status: 200, json: async () => value});
    if (init.method === 'POST' && path === '/checkout/sessions') { const s = {id: 'cs_' + ++seq, status: 'open', url: 'https://checkout.stripe.com/c/' + seq, form}; w.sessions.set(s.id, s); return ok(s); }
    if (init.method === 'GET' && path.startsWith('/checkout/sessions/')) return ok(w.sessions.get(path.split('/').pop()));
    if (path === '/billing_portal/sessions') return ok({url: 'https://billing.stripe.com/p/session/x'});
    if (init.method === 'GET' && path === '/charges') return ok({data: w.charges});
    if (path.startsWith('/subscriptions/')) {
      const s = w.subs.get(path.split('/').pop());
      if (init.method === 'DELETE') s.status = 'canceled';
      return ok(s);
    }
    throw new Error('unexpected ' + path);
  };
  const store = createClientsStore(db), id = store.save({name: 'Client ' + ++seq});
  w.id = id;
  w.b = B.createBilling({db, config}, {transport: w.transport, now: () => w.at, onEvent: (_, text) => w.events.push(text), alert: text => w.alerts.push(text)});
  w.told = async () => { await new Promise(resolve => setImmediate(resolve)); return w.alerts.splice(0); };
  w.token = w.b.connect(id, 'server-' + seq);
  w.sync = acks => w.b.sync('Bearer ' + w.token, {acks});
  w.deliverAll = () => { const pending = w.sync().commands; return w.sync(pending.map(c => ({id: c.id, status: 'sent'}))) && pending; };
  w.pay = async () => {
    const link = w.b.view(id) && w.sync().url, token = link.split('/').pop(), r = await w.b.payRedirect(token);
    const session = [...w.sessions.values()].find(s => s.url === r.redirect);
    const sub = {id: 'sub_' + ++seq, status: 'active', customer: 'cus_1', cancel_at_period_end: false, current_period_end: (w.at + 30 * DAY) / 1000};
    w.subs.set(sub.id, sub); Object.assign(session, {status: 'complete', subscription: sub.id, customer: 'cus_1'});
    return {sub, token, session};
  };
  w.state = () => w.b.view(id).state;
  return w;
}
const kinds = list => list.map(c => c.kind);

test('Send asks through the server, and the 24 hours start on delivery', async () => {
  const w = world();
  await w.b.send(w.id, 50);
  assert.equal(w.state(), 'requested');
  w.at += 5 * DAY; await w.b.tick();
  assert.equal(w.state(), 'requested', 'an undelivered request never starts the clock');
  assert.equal(w.sync().stop, false);
  const [request] = w.sync().commands;
  assert.equal(request.kind, 'payment_request'); assert.equal(request.params.amount_cents, 5000); assert.equal(request.params.hours, 24);
  assert.match(request.params.url, /^https:\/\/me\.example\.com\/pay\/[\w-]{32,}$/);
  w.sync([{id: request.id, status: 'failed'}]);
  assert.equal(w.state(), 'requested'); assert.equal(w.sync().commands.length, 1, 'a failed delivery is retried');
  w.sync([{id: request.id, status: 'sent'}]);
  assert.equal(w.state(), 'awaiting'); assert.equal(w.b.view(w.id).pay_by, w.at + 24 * HOUR);
  assert.equal(w.sync().commands.length, 0);
});

test('Unpaid: stops after 24 hours, Free after 3 days, server notice, export after 7 more, never deletes', async () => {
  const w = world();
  await w.b.send(w.id, 20); w.deliverAll();
  w.at += 23 * HOUR; await w.b.tick(); assert.equal(w.sync().stop, false);
  w.at += 2 * HOUR; await w.b.tick(); assert.equal(w.state(), 'paused'); assert.equal(w.sync().stop, true);
  assert.equal(w.sync().commands.length, 0, 'no payment message during a pause: it is up to them');
  w.at += 3 * DAY - HOUR; await w.b.tick(); assert.equal(w.state(), 'paused');
  w.at += 2 * HOUR; await w.b.tick(); assert.equal(w.state(), 'free'); assert.equal(w.sync().stop, false, 'answers again on Free'); assert.equal(w.sync().free_since, w.at);
  const [notice] = w.sync().commands;
  assert.equal(notice.kind, 'free_notice'); assert.equal(notice.params.date, w.at + 7 * DAY);
  w.sync([{id: notice.id, status: 'sent'}]);
  w.at += 7 * DAY + HOUR; await w.b.tick(); assert.equal(w.state(), 'retired'); assert.equal(w.sync().stop, true);
  const [exp] = w.sync().commands; assert.equal(exp.kind, 'export_data');
  w.sync([{id: exp.id, status: 'sent'}]);
  assert.ok(w.events.some(e => /ready to retire/i.test(e)));
  assert.ok(!w.calls.some(c => c.method === 'DELETE' && !c.path.startsWith('/subscriptions/')));
});

test('A failed export is reported to Owner and not retried silently', async () => {
  const w = world();
  await w.b.send(w.id, 20); w.deliverAll();
  w.at += 25 * HOUR; await w.b.tick(); w.at += 3 * DAY; await w.b.tick(); w.deliverAll(); w.at += 7 * DAY; await w.b.tick();
  const [exp] = w.sync().commands; w.sync([{id: exp.id, status: 'failed'}]);
  assert.ok(w.events.some(e => /export FAILED/i.test(e))); assert.equal(w.sync().commands.length, 0);
});

test('Paying: exact Checkout, one open page reused, confirmed once, charged monthly, reminded once a day before', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll();
  const first = await w.b.payRedirect(w.sync().url.split('/').pop()), again = await w.b.payRedirect(w.sync().url.split('/').pop());
  assert.equal(first.redirect, again.redirect);
  const made = w.calls.filter(c => c.path === '/checkout/sessions');
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].form, {mode: 'subscription', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': '5000', 'line_items[0][price_data][recurring][interval]': 'month', 'line_items[0][price_data][product_data][name]': 'Mastan',
    'subscription_data[metadata][mastan_client_id]': w.id, billing_address_collection: 'auto', payment_method_configuration: 'pmc_fixture',
    'consent_collection[terms_of_service]': 'required', 'tax_id_collection[enabled]': 'true',
    success_url: made[0].form.success_url, cancel_url: made[0].form.success_url});
  assert.equal(made[0].form.client_reference_id, undefined, 'public Mastan must ignore this subscription');
  const {sub} = await w.pay();
  await w.b.tick(); assert.equal(w.state(), 'active'); assert.equal(w.sync().stop, false);
  assert.deepEqual(kinds(w.deliverAll()), ['payment_confirmed']);
  await w.b.tick(); assert.equal(w.sync().commands.length, 0);
  w.at = sub.current_period_end * 1000 - DAY - HOUR; await w.b.tick(); assert.equal(w.sync().commands.length, 0);
  w.at += 2 * HOUR; await w.b.tick(); await w.b.tick();
  const reminders = w.deliverAll(); assert.deepEqual(kinds(reminders), ['renewal_reminder']); assert.equal(reminders[0].params.amount_cents, 5000);
  sub.current_period_end += 30 * DAY / 1000; w.at += 2 * HOUR; await w.b.tick();
  assert.equal(w.sync().commands.length, 0, 'charged by Stripe, next reminder is next month');
  w.at = sub.current_period_end * 1000 - HOUR; await w.b.tick();
  assert.deepEqual(kinds(w.deliverAll()), ['renewal_reminder']);
});

test('Paying links the Stripe customer to the client, so they stay one person; a set link is left alone', async () => {
  const customerOf = id => db.prepare('SELECT stripe_customer_id c FROM clients WHERE id=?').get(id).c;
  const w = world();
  await w.b.send(w.id, 30); w.deliverAll();
  const {sub, session} = await w.pay();
  Object.assign(session, {customer: 'cus_link_new'}); sub.customer = 'cus_link_new';
  await w.b.tick();
  assert.equal(w.state(), 'active');
  assert.equal(customerOf(w.id), 'cus_link_new');
  const other = world();
  db.prepare('UPDATE clients SET stripe_customer_id=? WHERE id=?').run('cus_link_kept', other.id);
  await other.b.send(other.id, 30); other.deliverAll();
  const second = await other.pay();
  Object.assign(second.session, {customer: 'cus_link_new'}); second.sub.customer = 'cus_link_new';
  await other.b.tick();
  assert.equal(customerOf(other.id), 'cus_link_kept');
});

test('Card failure: told once, 3 days of grace, then stop; paying later resumes with nothing lost', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub, token} = await w.pay(); await w.b.tick(); w.deliverAll();
  sub.status = 'past_due'; await w.b.tick(); await w.b.tick();
  assert.equal(w.state(), 'past_due'); assert.equal(w.sync().stop, false);
  const [failed] = w.deliverAll(); assert.equal(failed.kind, 'card_failed'); assert.match(failed.params.url, /\/pay\//);
  assert.match((await w.b.payRedirect(token)).redirect, /billing\.stripe\.com/);
  w.at += 3 * DAY - HOUR; await w.b.tick(); assert.equal(w.sync().stop, false);
  w.at += 2 * HOUR; await w.b.tick(); assert.equal(w.state(), 'paused'); assert.equal(w.sync().stop, true);
  sub.status = 'active'; await w.b.tick();
  assert.equal(w.state(), 'active'); assert.equal(w.sync().stop, false);
  assert.deepEqual(kinds(w.deliverAll()), ['payment_confirmed']);
});

test('Moving to Free cancels the Stripe plan first, so a stopped client is never charged again', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); w.deliverAll();
  sub.status = 'past_due'; await w.b.tick(); w.at += 3 * DAY + HOUR; await w.b.tick(); assert.equal(w.state(), 'paused');
  w.at += 3 * DAY + HOUR; w.down = true; await w.b.tick();
  assert.equal(w.state(), 'paused', 'no notice while the cancel cannot be done'); w.down = false;
  await w.b.tick(); assert.equal(w.state(), 'free'); assert.equal(sub.status, 'canceled');
  assert.ok(w.calls.some(c => c.method === 'DELETE' && c.path === '/subscriptions/' + sub.id));
});

test('Paying after the old plan was cancelled is noticed and resumes service', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); w.deliverAll();
  sub.status = 'past_due'; await w.b.tick(); w.deliverAll(); w.at += 3 * DAY + HOUR; await w.b.tick(); w.at += 3 * DAY + HOUR; await w.b.tick(); w.deliverAll();
  assert.equal(w.state(), 'free'); assert.equal(sub.status, 'canceled');
  const {sub: second} = await w.pay();
  assert.notEqual(second.id, sub.id);
  await w.b.tick();
  assert.equal(w.state(), 'active'); assert.equal(w.sync().stop, false); assert.equal(w.b.view(w.id).retire_at, null);
  assert.deepEqual(kinds(w.deliverAll()), ['payment_confirmed']);
});

test('A client cancelling in Stripe stops service at that point', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); w.deliverAll();
  sub.status = 'canceled'; await w.b.tick(); assert.equal(w.state(), 'paused'); assert.equal(w.sync().stop, true);
});

test('Stripe trouble never moves anyone along the timeline', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); w.deliverAll();
  w.down = true; w.at = sub.current_period_end * 1000 + 40 * DAY; await w.b.tick();
  assert.equal(w.state(), 'active'); assert.equal(w.sync().stop, false);
});

test('Extra days lift the stop and push every deadline; they end by themselves', async () => {
  const w = world();
  await w.b.send(w.id, 20); w.deliverAll(); w.at += 25 * HOUR; await w.b.tick();
  assert.equal(w.sync().stop, true);
  w.b.giveDays(w.id, 5); assert.equal(w.sync().stop, false); assert.equal(w.state(), 'paused');
  w.at += 4 * DAY; await w.b.tick(); assert.equal(w.state(), 'paused'); assert.equal(w.sync().stop, false);
  w.at += 2 * DAY; await w.b.tick(); assert.equal(w.sync().stop, true); assert.equal(w.state(), 'paused', 'a full three days remain before Free');
  w.at += 2 * DAY; await w.b.tick(); assert.equal(w.state(), 'free');
  w.b.giveDays(w.id, 30); assert.equal(w.sync().stop, false); assert.equal(w.sync().free_since, null, 'extra days on Free lift its limits too');
  w.at += 29 * DAY; await w.b.tick(); assert.equal(w.state(), 'free');
});

test('Stop billing cancels Stripe and leaves the agent answering; Send refuses a second running plan', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); w.deliverAll();
  await assert.rejects(w.b.send(w.id, 20), /running plan/);
  await w.b.stop(w.id);
  assert.equal(w.state(), 'stopped'); assert.equal(sub.status, 'canceled'); assert.equal(w.sync().stop, false);
  w.at += 60 * DAY; await w.b.tick(); assert.equal(w.state(), 'stopped');
  assert.equal((await w.b.payRedirect(w.sync().url.split('/').pop())).page, 'closed');
  await w.b.send(w.id, 20); assert.equal(w.state(), 'requested');
});

test('Refusals: amounts, no server, no key, bad tokens', async () => {
  const w = world();
  for (const bad of [0, -5, 0.5, 20000, 'x', null]) await assert.rejects(w.b.send(w.id, bad), /monthly amount/);
  for (const bad of [0, 366, 1.5]) assert.throws(() => w.b.giveDays(w.id, bad), /days/);
  await assert.rejects(w.b.send('nobody', 20), /server first/);
  assert.equal(w.b.sync('Bearer ' + 'x'.repeat(43), {}), null); assert.equal(w.b.sync('', {}), null); assert.equal(w.b.sync(undefined, {}), null);
  assert.equal((await w.b.payRedirect('../etc')).page, 'closed');
  const other = world(); await other.b.send(other.id, 30);
  const [theirs] = other.sync().commands;
  w.sync([{id: theirs.id, status: 'sent'}]);
  assert.equal(other.state(), 'requested', "one server cannot acknowledge another's commands");
  assert.throws(() => w.b.connect(w.id, 'BAD NAME!'), /server name/);
  const saved = config.stripeBillingKeyFile; config.stripeBillingKeyFile = join(data, 'absent');
  try { await assert.rejects(w.b.send(w.id, 20), /key is not installed/); assert.equal(w.state(), 'none'); } finally { config.stripeBillingKeyFile = saved; }
});

test('A new connect replaces the token and keeps the payment link', async () => {
  const w = world(); await w.b.send(w.id, 20); const url = w.sync().url, old = w.token;
  w.token = w.b.connect(w.id, 'server-new');
  assert.equal(w.b.sync('Bearer ' + old, {}), null); assert.equal(w.sync().url, url);
});

test('Owner is told on Telegram when a client pays, once per monthly charge, and only after Stripe charged', async () => {
  const w = world(), name = 'Client ' + w.b.view(w.id).server.split('-')[1];
  await w.b.send(w.id, 17.65); w.deliverAll();
  assert.deepEqual(await w.told(), [], 'sending a request is Owner\'s own action');
  const {sub} = await w.pay(); await w.b.tick();
  assert.deepEqual(await w.told(), [`Billing: ${name} paid $17.65. Monthly plan active, next charge 5 Dec.`]);
  await w.b.tick(); assert.deepEqual(await w.told(), []);
  sub.current_period_end += 30 * DAY / 1000; w.at = (sub.current_period_end - 30 * DAY / 1000) * 1000 + 10 * 60_000; await w.b.tick();
  assert.deepEqual(await w.told(), [], 'the period moved but nothing was charged yet');
  w.charges.push({status: 'succeeded', paid: true, refunded: false});
  await w.b.tick(); await w.b.tick();
  assert.deepEqual(await w.told(), [`Billing: ${name} paid $17.65 for another month. Next charge 4 Jan.`]);
  const charges = w.calls.filter(c => c.path === '/charges');
  assert.equal(charges.length, 2, 'charges are read only while a new month waits for its payment');
});

test('Owner is told when a card fails, when service stops, and when it pays again', async () => {
  const w = world(), name = 'Client ' + w.b.view(w.id).server.split('-')[1];
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); await w.told();
  sub.status = 'past_due'; await w.b.tick(); await w.b.tick();
  assert.deepEqual(await w.told(), [`Billing: ${name}'s card failed for $50.00. Their agent sent the card link. Service stops in 3 days if it stays unpaid.`]);
  w.at += 3 * DAY + HOUR; await w.b.tick();
  assert.deepEqual(await w.told(), [`Billing: ${name}'s card stayed failed for 3 days. Their agent stopped answering. Free with limits starts in 3 days.`]);
  sub.status = 'active'; await w.b.tick();
  assert.match((await w.told())[0], new RegExp(`^Billing: ${name} paid \\$50\\.00\\. Monthly plan active`));
});

test('Owner is told when an unpaid client stops, moves to Free, retires and the export lands', async () => {
  const w = world(), name = 'Client ' + w.b.view(w.id).server.split('-')[1];
  await w.b.send(w.id, 20); w.deliverAll();
  w.at += 25 * HOUR; await w.b.tick();
  assert.deepEqual(await w.told(), [`Billing: ${name} did not pay $20.00 in time. Their agent stopped answering. Free with limits starts in 3 days.`]);
  w.at += 3 * DAY + HOUR; await w.b.tick(); w.deliverAll();
  assert.match((await w.told())[0], new RegExp(`^Billing: ${name} is on Free now\\. Their server retires on \\d+ \\w+\\.$`));
  w.at += 7 * DAY + HOUR; await w.b.tick();
  assert.deepEqual(await w.told(), [`Billing: ${name}'s Free days are over. Their data export is on its way, then the server is ready to retire.`]);
  const [exp] = w.sync().commands; w.sync([{id: exp.id, status: 'failed'}]);
  assert.deepEqual(await w.told(), [`Billing: ${name}: Data export FAILED. Export it by hand before retiring the server.`]);
});

test('A plan already active before alerts existed is not announced again, and a broken Telegram never stops billing', async () => {
  const w = world();
  await w.b.send(w.id, 50); w.deliverAll(); const {sub} = await w.pay(); await w.b.tick(); await w.told();
  db.prepare('UPDATE client_billing SET paid_through=NULL WHERE client_id=?').run(w.id);
  await w.b.tick(); assert.deepEqual(await w.told(), []);
  assert.equal(db.prepare('SELECT paid_through p FROM client_billing WHERE client_id=?').get(w.id).p, sub.current_period_end * 1000);
  const broken = B.createBilling({db, config}, {transport: w.transport, now: () => w.at, alert: async () => { throw new Error('Telegram down'); }});
  sub.status = 'past_due'; await broken.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.state(), 'past_due');
});
