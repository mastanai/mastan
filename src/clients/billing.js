// Monthly plans for clients on their own servers. Owner sets an amount in /clients and presses Send; the server's agent asks
// the client to pay. Stripe charges every month. This file holds the money timeline and never decides anything on a server:
// servers pull their state with a per-server token, and with no answer from here they keep answering (see service-billing.js).
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {readKey} from './stripe.js';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const PAY_WINDOW = 24 * HOUR;
export const CARD_GRACE = 3 * DAY;
export const FREE_AFTER = 3 * DAY;
export const RETIRE_AFTER = 7 * DAY;
export const REMIND_BEFORE = DAY;
const TERMINAL = new Set(['retired', 'stopped']);
// On Free the agent answers again, with Free's limits, until the server retires.
const STOPPED = new Set(['paused', 'retired']);
const LIVE_SUB = new Set(['active', 'trialing']);
const OPEN_SUB = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
const hash = token => createHash('sha256').update(token).digest();
const tokenFor = () => randomBytes(32).toString('base64url');

export function billingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS client_billing(client_id TEXT PRIMARY KEY, server TEXT, server_hash BLOB UNIQUE,
      amount_cents INTEGER, state TEXT NOT NULL DEFAULT 'none', pay_token TEXT UNIQUE, session_id TEXT, subscription_id TEXT,
      customer_id TEXT, sent_at INTEGER, pay_by INTEGER, past_due_at INTEGER, paused_at INTEGER, free_at INTEGER, retire_at INTEGER,
      hold_until INTEGER, period_end INTEGER, reminded_period INTEGER, last_seen INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_billing_commands(id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, kind TEXT NOT NULL,
      params TEXT NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER, result TEXT);
    CREATE INDEX IF NOT EXISTS client_billing_open ON client_billing_commands(client_id, acked_at);`);
  // The period end of the last payment Owner was told about, so each monthly charge is announced once.
  if (!db.prepare('PRAGMA table_info(client_billing)').all().some(c => c.name === 'paid_through')) db.exec('ALTER TABLE client_billing ADD COLUMN paid_through INTEGER');
}

const usd = cents => `$${(cents / 100).toFixed(2)}`;
const day = ms => new Date(ms).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh'});

// What Owner reads on Telegram when a client's plan moves. Null when the move is not worth a message.
export function alertText(name, row, patch) {
  const amount = usd(row.amount_cents), next = patch.period_end || row.period_end;
  switch (patch.state) {
    case 'active': return row.state === 'past_due'
      ? `Billing: ${name} paid ${amount}. The card works again, next charge ${day(next)}.`
      : `Billing: ${name} paid ${amount}. Monthly plan active, next charge ${day(next)}.`;
    case 'past_due': return `Billing: ${name}'s card failed for ${amount}. Their agent sent the card link. Service stops in 3 days if it stays unpaid.`;
    case 'paused': return row.state === 'awaiting'
      ? `Billing: ${name} did not pay ${amount} in time. Their agent stopped answering. Free with limits starts in 3 days.`
      : row.state === 'past_due'
        ? `Billing: ${name}'s card stayed failed for 3 days. Their agent stopped answering. Free with limits starts in 3 days.`
        : `Billing: ${name}'s plan was cancelled in Stripe. Their agent stopped answering. Free with limits starts in 3 days.`;
    case 'free': return `Billing: ${name} is on Free now. Their server retires on ${day(patch.retire_at)}.`;
    case 'retired': return `Billing: ${name}'s Free days are over. Their data export is on its way, then the server is ready to retire.`;
    default: return null;
  }
}

// The timeline, without Stripe or storage, so every date can be tested. sub is null until a subscription exists.
export function advance(row, sub, now) {
  const patch = {}, commands = [], held = row.hold_until > now, money = {amount_cents: row.amount_cents};
  if (TERMINAL.has(row.state) || row.state === 'none' || row.state === 'requested') return {patch, commands};
  if (sub) {
    if (sub.period_end) patch.period_end = sub.period_end;
    if (LIVE_SUB.has(sub.status)) {
      if (row.state !== 'active') {
        Object.assign(patch, {state: 'active', pay_by: null, past_due_at: null, paused_at: null, free_at: null, retire_at: null});
        commands.push({kind: 'payment_confirmed', params: money});
      }
      const end = sub.period_end;
      if ((row.state === 'active' || patch.state) && !sub.cancel_at_period_end && end && end - now <= REMIND_BEFORE && end > now && row.reminded_period !== end) {
        patch.reminded_period = end;
        commands.push({kind: 'renewal_reminder', params: {...money, date: end}});
      }
      return {patch, commands};
    }
    if (['past_due', 'unpaid'].includes(sub.status) && row.state === 'active') {
      Object.assign(patch, {state: 'past_due', past_due_at: now});
      commands.push({kind: 'card_failed', params: money});
      return {patch, commands};
    }
    if (['canceled', 'incomplete_expired', 'paused'].includes(sub.status) && ['active', 'past_due'].includes(row.state) && !held) {
      Object.assign(patch, {state: 'paused', paused_at: now, past_due_at: null});
      return {patch, commands};
    }
  }
  if (held) return {patch, commands};
  if (row.state === 'awaiting' && now >= row.pay_by) Object.assign(patch, {state: 'paused', paused_at: now, pay_by: null});
  else if (row.state === 'past_due' && now >= row.past_due_at + CARD_GRACE) Object.assign(patch, {state: 'paused', paused_at: now, past_due_at: null});
  else if (row.state === 'paused' && now >= row.paused_at + FREE_AFTER) {
    const retire = now + RETIRE_AFTER;
    Object.assign(patch, {state: 'free', free_at: now, retire_at: retire, paused_at: null, cancel_subscription: true});
    commands.push({kind: 'free_notice', params: {date: retire}});
  } else if (row.state === 'free' && now >= row.retire_at) {
    patch.state = 'retired';
    commands.push({kind: 'export_data', params: {}});
  }
  return {patch, commands};
}

export const serviceStopped = (row, now) => STOPPED.has(row?.state) && !(row.hold_until > now);

export function createBilling(ctx, {transport = globalThis.fetch, now = Date.now, onEvent = () => {}, alert = () => {}, baseUrl = 'https://me.example.com'} = {}) {
  const db = ctx.db;
  billingSchema(db);
  const cfg = () => ctx.config;
  const refuse = message => Object.assign(new Error(message), {status: 400, expose: true});
  const get = id => db.prepare('SELECT * FROM client_billing WHERE client_id=?').get(id);
  const queue = (id, kind, params) => db.prepare('INSERT INTO client_billing_commands(client_id,kind,params,created_at) VALUES(?,?,?,?)').run(id, kind, JSON.stringify(params), now());
  const update = (id, patch) => {
    const keys = Object.keys(patch); if (!keys.length) return;
    db.prepare(`UPDATE client_billing SET ${keys.map(k => k + '=?').join(',')},updated_at=? WHERE client_id=?`).run(...keys.map(k => patch[k]), now(), id);
  };
  const payUrl = row => `${baseUrl}/pay/${row.pay_token}`;
  const nameOf = row => { try { return db.prepare('SELECT name FROM clients WHERE id=?').get(row.client_id)?.name || row.server; } catch { return row.server; } };
  // A message to Owner never holds up or undoes the timeline.
  const tell = text => { if (text) Promise.resolve().then(() => alert(text)).catch(error => console.log('[client-billing] alert failed:', String(error?.message).slice(0, 120))); };

  async function stripe(method, path, fields) {
    const state = await readKey(cfg().stripeBillingKeyFile || '/etc/mastan-me/stripe-billing-key');
    if (!state.key) throw Object.assign(new Error('The Stripe billing key is not installed.'), {status: 503, expose: true, missingKey: true});
    const body = fields ? new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString() : undefined;
    const response = await transport('https://api.stripe.com/v1' + path, {method, redirect: 'error', body,
      headers: {Authorization: `Bearer ${state.key}`, 'Stripe-Version': '2024-06-20', ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})},
      signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw Object.assign(new Error('StripeHttp'), {stripeStatus: response.status});
    return response.json();
  }
  const facts = s => ({status: s.status, cancel_at_period_end: Boolean(s.cancel_at_period_end),
    period_end: Number.isFinite(s.current_period_end) ? s.current_period_end * 1000 : null});

  function connect(clientId, server) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(server || '')) throw refuse('Use a server name such as client-d-01.');
    const token = tokenFor();
    db.prepare(`INSERT INTO client_billing(client_id,server,server_hash,pay_token,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET server=excluded.server,server_hash=excluded.server_hash,updated_at=excluded.updated_at`)
      .run(clientId, server, hash(token), tokenFor(), now());
    onEvent(clientId, `Connected server ${server}`);
    return token;
  }

  async function send(clientId, amountUsd) {
    const row = get(clientId);
    if (!row?.server_hash) throw refuse('Connect this client to a server first.');
    const cents = Math.round(Number(amountUsd) * 100);
    if (!Number.isSafeInteger(cents) || cents < 100 || cents > 1_000_000) throw refuse('Use a monthly amount from $1 to $10,000.');
    if (row.subscription_id && OPEN_SUB.has(row.state === 'free' || row.state === 'retired' ? '' : (await stripe('GET', '/subscriptions/' + row.subscription_id)).status)) {
      throw refuse('This client already has a running plan. Stop billing first to change the amount.');
    }
    await readKey(cfg().stripeBillingKeyFile || '/etc/mastan-me/stripe-billing-key').then(k => { if (!k.key) throw Object.assign(new Error('The Stripe billing key is not installed.'), {status: 503, expose: true}); });
    db.prepare('UPDATE client_billing_commands SET acked_at=?,result=? WHERE client_id=? AND acked_at IS NULL').run(now(), 'replaced', clientId);
    update(clientId, {amount_cents: cents, state: 'requested', session_id: null, subscription_id: null, sent_at: now(), pay_by: null,
      past_due_at: null, paused_at: null, free_at: null, retire_at: null, hold_until: null, period_end: null, reminded_period: null, paid_through: null});
    queue(clientId, 'payment_request', {amount_cents: cents, url: payUrl(get(clientId)), hours: PAY_WINDOW / HOUR});
    onEvent(clientId, `Sent a payment request for $${(cents / 100).toFixed(2)} a month`);
  }

  function giveDays(clientId, days) {
    const row = get(clientId), n = Number(days);
    if (!row?.server_hash) throw refuse('Connect this client to a server first.');
    if (!Number.isInteger(n) || n < 1 || n > 365) throw refuse('Give from 1 to 365 days.');
    const until = Math.max(now(), row.hold_until || 0) + n * DAY, patch = {hold_until: until};
    // Waiting days move forward too, so the extra time is not used up the moment the hold ends.
    if (row.state === 'awaiting') patch.pay_by = until;
    if (row.state === 'past_due') patch.past_due_at = until;
    if (row.state === 'paused') patch.paused_at = until;
    if (row.state === 'free') patch.retire_at = until;
    update(clientId, patch);
    onEvent(clientId, `Gave ${n} extra day${n === 1 ? '' : 's'}`);
  }

  async function stop(clientId) {
    const row = get(clientId);
    if (!row?.server_hash) throw refuse('Connect this client to a server first.');
    if (row.subscription_id) await stripe('DELETE', '/subscriptions/' + row.subscription_id).catch(error => { if (error.stripeStatus !== 404) throw error; });
    db.prepare('UPDATE client_billing_commands SET acked_at=?,result=? WHERE client_id=? AND acked_at IS NULL').run(now(), 'replaced', clientId);
    update(clientId, {state: 'stopped', pay_by: null, past_due_at: null, paused_at: null, free_at: null, retire_at: null, hold_until: null, subscription_id: null, session_id: null});
    onEvent(clientId, 'Stopped billing. The agent keeps answering');
  }

  async function tickOne(row) {
    const at = now();
    let sub = null;
    if (!row.subscription_id && row.session_id) {
      const session = await stripe('GET', '/checkout/sessions/' + row.session_id);
      if (session.status === 'complete' && session.subscription) {
        const id = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        update(row.client_id, {subscription_id: id, customer_id: customer || null});
        // Stripe rows join a client by this id. Without it the payer shows as a second person and this client stays a lead.
        if (customer) db.prepare('UPDATE OR IGNORE clients SET stripe_customer_id=? WHERE id=? AND stripe_customer_id IS NULL').run(customer, row.client_id);
        row = get(row.client_id);
      }
    }
    if (row.subscription_id) sub = facts(await stripe('GET', '/subscriptions/' + row.subscription_id));
    const {patch: {cancel_subscription: cancel, ...patch}, commands} = advance(row, sub, at);
    // Stop charging before telling anyone the plan ended. A Stripe failure leaves the state alone and retries next tick.
    if (cancel && row.subscription_id && sub && sub.status !== 'canceled') await stripe('DELETE', '/subscriptions/' + row.subscription_id);
    let news = alertText(nameOf(row), row, patch);
    if (patch.state === 'active') patch.paid_through = sub.period_end;
    else if (!patch.state && row.state === 'active' && sub?.period_end) {
      if (row.paid_through == null) patch.paid_through = sub.period_end;
      // Stripe moves the period forward about an hour before it charges, so the new month counts only once a charge went through.
      else if (sub.period_end > row.paid_through + DAY && await renewalPaid(row)) {
        patch.paid_through = sub.period_end;
        news = `Billing: ${nameOf(row)} paid ${usd(row.amount_cents)} for another month. Next charge ${day(sub.period_end)}.`;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      update(row.client_id, patch);
      for (const c of commands) queue(row.client_id, c.kind, c.kind === 'card_failed' ? {...c.params, url: payUrl(row)} : c.params);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (patch.state) onEvent(row.client_id, `Plan is now ${patch.state}`);
    tell(news);
  }

  async function renewalPaid(row) {
    if (!row.customer_id) return false;
    const query = new URLSearchParams({customer: row.customer_id, 'created[gte]': String(Math.floor(row.paid_through / 1000) - 6 * 3600), limit: '10'});
    const list = await stripe('GET', '/charges?' + query).catch(() => null);
    return Boolean(list?.data?.some(c => c.status === 'succeeded' && c.paid && !c.refunded));
  }

  async function tick() {
    for (const row of db.prepare("SELECT * FROM client_billing WHERE state NOT IN ('none','requested','stopped','retired')").all()) {
      // Our Stripe trouble must never move a client along the timeline.
      try { await tickOne(row); }
      catch (error) { if (!error.missingKey && error.stripeStatus === undefined && error.name !== 'TimeoutError' && error.name !== 'TypeError') console.log('[client-billing] tick failed:', String(error.message).slice(0, 120)); }
    }
  }

  // Servers: POST /api/client-billing/sync with their token. Reports what was delivered, returns state and new work.
  function sync(authorization, input) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,64})$/.exec(authorization || '');
    if (!match) return null;
    const digest = hash(match[1]);
    const row = db.prepare('SELECT * FROM client_billing WHERE server_hash=?').get(digest);
    if (!row || !timingSafeEqual(row.server_hash, digest)) return null;
    const at = now(), exported = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const ack of Array.isArray(input?.acks) ? input.acks.slice(0, 50) : []) {
        const command = db.prepare('SELECT * FROM client_billing_commands WHERE id=? AND client_id=? AND acked_at IS NULL').get(ack?.id, row.client_id);
        if (!command || ack.status !== 'sent' && ack.status !== 'failed') continue;
        // Servers retry undelivered messages by not acknowledging them. Only a finished export can report failure.
        if (ack.status === 'failed' && command.kind !== 'export_data') continue;
        db.prepare('UPDATE client_billing_commands SET acked_at=?,result=? WHERE id=?').run(at, ack.status, command.id);
        // The 24 hours start when the message reached the client, not when Owner pressed Send.
        if (command.kind === 'payment_request' && ack.status === 'sent' && get(row.client_id).state === 'requested') update(row.client_id, {state: 'awaiting', pay_by: at + PAY_WINDOW});
        if (command.kind === 'export_data') {
          const text = ack.status === 'sent' ? 'Data export delivered. Server is ready to retire' : 'Data export FAILED. Export it by hand before retiring the server';
          onEvent(row.client_id, text); exported.push(`Billing: ${nameOf(row)}: ${text}.`);
        }
      }
      db.prepare('UPDATE client_billing SET last_seen=? WHERE client_id=?').run(at, row.client_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    exported.forEach(tell);
    const fresh = get(row.client_id);
    const commands = db.prepare('SELECT id,kind,params FROM client_billing_commands WHERE client_id=? AND acked_at IS NULL ORDER BY id LIMIT 10').all(row.client_id)
      .map(c => ({id: c.id, kind: c.kind, params: JSON.parse(c.params)}));
    return {stop: serviceStopped(fresh, at), state: fresh.state, free_since: fresh.state === 'free' && !(fresh.hold_until > at) ? fresh.free_at : null,
      url: fresh.pay_token && fresh.amount_cents ? payUrl(fresh) : null, commands};
  }

  // The link in the message never expires: each visit gets a current Stripe page, and a failed card goes to the card page.
  async function payRedirect(token) {
    const row = /^[A-Za-z0-9_-]{32,64}$/.test(token || '') ? db.prepare('SELECT * FROM client_billing WHERE pay_token=?').get(token) : null;
    if (!row?.amount_cents || ['none', 'stopped', 'retired'].includes(row.state)) return {page: 'closed'};
    if (row.subscription_id) {
      const sub = await stripe('GET', '/subscriptions/' + row.subscription_id);
      if (LIVE_SUB.has(sub.status)) return {page: 'paid'};
      if (['past_due', 'unpaid'].includes(sub.status)) {
        const portal = await stripe('POST', '/billing_portal/sessions', {customer: typeof sub.customer === 'string' ? sub.customer : sub.customer.id, return_url: `${baseUrl}/pay/${token}/done`});
        return {redirect: portal.url};
      }
      // That plan is over. Forget it, or the new payment would never be noticed.
      update(row.client_id, {subscription_id: null, session_id: null, ...(row.state === 'active' || row.state === 'past_due' ? {state: 'paused', paused_at: now(), past_due_at: null} : {})});
      row.subscription_id = null; row.session_id = null;
    }
    if (row.session_id && !row.subscription_id) {
      const old = await stripe('GET', '/checkout/sessions/' + row.session_id);
      if (old.status === 'complete') return {page: 'paid'};
      if (old.status === 'open' && old.url) return {redirect: old.url};
    }
    const session = await stripe('POST', '/checkout/sessions', {mode: 'subscription', 'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': row.amount_cents,
      'line_items[0][price_data][recurring][interval]': 'month', 'line_items[0][price_data][product_data][name]': 'Mastan',
      'subscription_data[metadata][mastan_client_id]': row.client_id, billing_address_collection: 'auto',
      ...(cfg().stripeBillingPaymentConfig ? {payment_method_configuration: cfg().stripeBillingPaymentConfig} : {}),
      'consent_collection[terms_of_service]': 'required', 'tax_id_collection[enabled]': true,
      success_url: `${baseUrl}/pay/${token}/done`, cancel_url: `${baseUrl}/pay/${token}/done`});
    update(row.client_id, {session_id: session.id});
    if (!/^https:\/\/checkout\.stripe\.com\//.test(session.url || '')) throw new Error('StripeShape');
    return {redirect: session.url};
  }

  const view = id => {
    const row = get(id); if (!row) return null;
    const at = now();
    const waiting = db.prepare('SELECT kind FROM client_billing_commands WHERE client_id=? AND acked_at IS NULL ORDER BY id').all(id).map(c => c.kind);
    return {server: row.server, connected: Boolean(row.server_hash), amount: row.amount_cents ? row.amount_cents / 100 : null, state: row.state,
      stopped: serviceStopped(row, at), pay_by: row.pay_by, past_due_at: row.past_due_at, paused_at: row.paused_at, free_at: row.free_at, retire_at: row.retire_at,
      hold_until: row.hold_until > at ? row.hold_until : null, period_end: row.period_end, last_seen: row.last_seen, waiting};
  };
  let timer = null;
  const start = () => { if (timer) return; timer = setInterval(() => { void tick(); }, 60_000); timer.unref?.(); };
  return {connect, send, giveDays, stop, tick, sync, payRedirect, view, link: id => { const row = get(id); return row?.pay_token ? payUrl(row) : null; }, start, shutdown: () => { clearInterval(timer); timer = null; }};
}
