// Public deals use a pull queue. Account identities belong to the feed, never to a deal or its browser view.
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {readKey} from './stripe.js';
import {normalizePersonId} from './store.js';

const DAY = 86400_000;
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
export const FAILURE = Object.freeze({no_account: 'Account not found.', not_active: 'Their account is not active.', minor: 'Deals are not available for minors.',
  window: 'Mastan cannot message them right now, they have to write first. Copy it and send it yourself.',
  guard: 'Mastan refused this message. Copy it and send it yourself.', daily_cap: 'The daily limit was reached. Copy it and send it yourself.', error: 'Something went wrong. Try again.'});
export const COPY = Object.freeze({
  en: {pay: 'Here is your personal Mastan link. The payment page shows your plan and price.', free: 'Your {plan} plan is on, {duration}.', invite: 'Write to Mastan to set up your account.', forever: 'free forever', months: 'free for {n} months'},
  az: {pay: 'Bu sizin şəxsi Mastan keçidinizdir. Plan və qiymət ödəniş səhifəsində göstərilir.', free: '{plan} planınız aktivdir, {duration}.', invite: 'Hesab açmaq üçün Mastana yazın.', forever: 'həmişə pulsuz', months: '{n} ay pulsuz'},
  ru: {pay: 'Ваша личная ссылка Mastan. Тариф и цена указаны на странице оплаты.', free: 'Ваш тариф {plan} включён, {duration}.', invite: 'Напишите Mastan, чтобы создать аккаунт.', forever: 'бесплатно навсегда', months: 'бесплатно на {n} мес.'},
  ar: {pay: 'هذا رابط Mastan الخاص بك. تعرض صفحة الدفع خطتك والسعر.', free: 'خطة {plan} مفعلة، {duration}.', invite: 'راسل Mastan لإنشاء حسابك.', forever: 'مجاناً مدى الحياة', months: 'مجاناً لمدة {n} أشهر'},
  tr: {pay: 'Kişisel Mastan bağlantınız. Ödeme sayfasında planınız ve fiyatınız gösterilir.', free: '{plan} planınız açık, {duration}.', invite: 'Hesabınızı açmak için Mastan’a yazın.', forever: 'ömür boyu ücretsiz', months: '{n} ay ücretsiz'},
});
const hash = token => createHash('sha256').update(token).digest();
const tokenFor = () => randomBytes(32).toString('base64url');
const refuse = message => Object.assign(new Error(message), {status: 400, expose: true});
const idOf = value => typeof value === 'string' ? value : value?.id;
export function addMonths(at, n) {
  const d = new Date(at), day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.getTime();
}
export function dealTerms(input) {
  const {kind, plan, duration, months = null, value = null, reason, note = ''} = input;
  if (!['free', 'discount_percent', 'discount_amount', 'custom'].includes(kind) || !['plus', 'pro'].includes(plan)) throw refuse('Choose a deal and Plus or Pro.');
  if (!['forever', 'months', 'once'].includes(duration) || duration === 'once' && kind === 'free') throw refuse('Choose how long the deal lasts.');
  if (duration === 'months' && (!Number.isInteger(months) || months < 1 || months > 120)) throw refuse('Use from 1 to 120 months.');
  if (kind !== 'free' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > (kind === 'discount_percent' ? 100 : 10000) || Math.round(value * 100) !== value * 100 && Math.abs(Math.round(value * 100) - value * 100) > 1e-7)) throw refuse('Enter a valid discount or monthly price.');
  if (kind === 'custom' && duration === 'once') throw refuse('Choose months or forever for a custom price.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 200 || typeof note !== 'string' || note.length > 1000) throw refuse('Add a short reason. Notes can be up to 1,000 characters.');
  return {kind, plan, duration, months: duration === 'months' ? months : null, value: kind === 'free' ? null : value, reason: reason.trim(), note: note.trim()};
}
export function dealLabel(d) {
  const kind = d.kind === 'free' ? 'Free' : d.kind === 'discount_percent' ? `${d.value}% off` : d.kind === 'discount_amount' ? `$${d.value} off` : `$${d.value} a month`;
  return `${kind}, ${d.plan === 'pro' ? 'Pro' : 'Plus'}, ${d.duration === 'once' ? 'first month' : d.duration === 'forever' ? 'forever' : d.months + ' months'}`;
}
export function dealsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS client_deals(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, state TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS client_deals_one_open ON client_deals(client_id) WHERE state != 'ended';
    CREATE TABLE IF NOT EXISTS client_deal_commands(id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER, status TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS client_deals_connection(id INTEGER PRIMARY KEY CHECK(id=1), token_hash BLOB NOT NULL);`);
}
export function createDeals(ctx, {transport = globalThis.fetch, now = Date.now, onEvent = () => {}, baseUrl = 'https://me.example.com'} = {}) {
  const db = ctx.db; dealsSchema(db);
  const locks = new Map();
  const locked = (id, fn) => {
    const result = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn); locks.set(id, result);
    return result.finally(() => { if (locks.get(id) === result) locks.delete(id); });
  };
  const decode = row => row ? {...JSON.parse(row.details), id: row.id, client_id: row.client_id, state: row.state, created_at: row.created_at} : null;
  const get = id => decode(db.prepare('SELECT * FROM client_deals WHERE id=?').get(id));
  const current = id => decode(db.prepare("SELECT * FROM client_deals WHERE client_id=? AND state != 'ended'").get(id));
  const update = (d, patch) => { const next = {...get(d.id), ...patch}; db.prepare('UPDATE client_deals SET state=?,details=?,updated_at=? WHERE id=?').run(next.state, JSON.stringify(next), now(), d.id); return next; };
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const queue = (d, kind, params) => db.prepare('INSERT INTO client_deal_commands(deal_id,kind,params,created_at) VALUES(?,?,?,?)').run(d.id, kind, JSON.stringify(params), now());
  const connected = () => Boolean(db.prepare('SELECT id FROM client_deals_connection WHERE id=1').get());
  function connect() { const token = tokenFor(); db.prepare('INSERT INTO client_deals_connection VALUES(1,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash').run(hash(token)); return token; }
  const event = (d, text) => onEvent(d.client_id, text);
  const billing = () => ctx.billing;
  const target = p => p.billing?.connected ? 'server' : p.server ? 'record' : p.canary_user_id || p.person_id || p.account === 'found' || normalizePersonId(p.phone) ? 'public' : 'record';
  const keyState = () => readKey(ctx.config.stripeBillingKeyFile || '/etc/mastan-me/stripe-billing-key');
  async function stripe(method, path, fields, operation) {
    const key = await keyState();
    if (!key.key) throw refuse('The Stripe billing key is not installed.');
    try {
      const body = fields ? new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString() : undefined;
      const r = await transport('https://api.stripe.com/v1' + path, {method, redirect: 'error', body,
        headers: {Authorization: 'Bearer ' + key.key, 'Stripe-Version': '2024-06-20', ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {}), ...(operation && method === 'POST' ? {'Idempotency-Key': operation} : {})}, signal: AbortSignal.timeout(15_000)});
      if (!r.ok) throw Object.assign(new Error('StripeHttp'), {stripeStatus: r.status});
      return await r.json();
    } catch (error) { throw Object.assign(refuse(error.stripeStatus === 403 ? path === '/coupons' ? 'The Stripe key needs Coupons set to Write.' : 'The Stripe key is missing a permission. Nothing changed.' : 'Stripe did not answer. Nothing changed.'), {stripeStatus: error.stripeStatus}); }
  }
  // A first-month or finished coupon is already gone from the subscription, which Stripe answers with a 404.
  const removeDiscount = subscriptionId => stripe('DELETE', '/subscriptions/' + encodeURIComponent(subscriptionId) + '/discount').catch(error => { if (error.stripeStatus !== 404) throw error; });
  async function price(plan) {
    const result = await stripe('GET', '/prices?lookup_keys[]=' + plan + '_monthly&active=true');
    const prices = result?.data?.filter(p => p.active !== false && p.currency === 'usd' && p.recurring?.interval === 'month' && (p.recurring.interval_count || 1) === 1 && p.lookup_key === plan + '_monthly' && Number.isSafeInteger(p.unit_amount) && p.unit_amount > 0 && idOf(p.product));
    if (prices?.length !== 1) throw refuse('The monthly plan price is unavailable.');
    return prices[0];
  }
  async function subscription(p) {
    if (!p._subscription?.id || !LIVE.has(p._subscription.status)) return null;
    const s = await stripe('GET', '/subscriptions/' + encodeURIComponent(p._subscription.id));
    if (!LIVE.has(s.status)) return null;
    const lookup = s.items?.data?.[0]?.price?.lookup_key;
    const plan = lookup ? lookup.replace(/_monthly$/, '') : p._subscription.plan.toLowerCase();
    return {id: s.id, plan: ['plus','pro','private','enterprise'].includes(plan) ? plan : 'other'};
  }
  function checkAccount(p) {
    if (p._account?.minor) throw refuse(FAILURE.minor);
    if (p._account && p._account.status !== 'active') throw refuse(FAILURE.not_active);
  }
  async function preview(p, input) {
    if (p.sample || p.id?.startsWith('sample:')) throw refuse('Sample people cannot have deals applied or messages sent.');
    const terms = dealTerms(input), where = target(p);
    if (where === 'server' && !['free', 'custom'].includes(terms.kind)) throw refuse('Choose Free or Custom price for their own server.');
    let list = null, priceId = null, productId = null;
    if (where === 'public') {
      if (p.account === 'found') {
        checkAccount(p);
        if (terms.kind !== 'free' && p._account?.free_forever) throw refuse('They already have a free plan. End it first.');
      }
      const k = await keyState();
      if (k.key) {
        // Someone waiting for an account only needs the price for display, so Stripe trouble must not block saving.
        const pr = await price(terms.plan).catch(error => { if (p.account === 'found') throw error; return null; });
        if (pr) { list = pr.unit_amount; priceId = pr.id; productId = idOf(pr.product); }
      }
      else if (terms.kind !== 'free' && p.account === 'found') throw refuse('The Stripe billing key is not installed.');
    }
    const cents = terms.kind === 'free' ? 0 : terms.kind === 'custom' ? Math.round(terms.value * 100) : list === null ? null : terms.kind === 'discount_percent' ? Math.round(list * (1 - terms.value / 100)) : list - Math.round(terms.value * 100);
    if (list !== null && terms.kind === 'custom' && cents >= list) throw refuse('The custom price must be below the normal price.');
    if (cents !== null && cents < 0) throw refuse('The discount must not exceed the normal price.');
    const state = where === 'public' && p.account !== 'found' ? 'waiting' : 'draft';
    const notice = where === 'record' ? 'Saved as a note. Nothing enforces this.' : state === 'waiting' ? (p.account === 'unknown' ? 'Account unknown. ' : '') + 'They need to write to Mastan first. Apply when their account is found.' : where === 'server' && terms.duration === 'months' ? 'The end date is a follow-up. Nothing ends automatically.' : '';
    return {...terms, target: where, state, user_id: p.canary_user_id || p._account?.user_id || null, list_cents: list, price_id: priceId, product_id: productId,
      pay_cents: cents, given_up: list === null ? null : (list - cents) / 100, label: dealLabel(terms), notice,
      ends_at: terms.duration === 'months' ? addMonths(now(), terms.months) : terms.duration === 'once' ? addMonths(now(), 1) : null,
      llm_cost: p.cost?.all_time ?? p.cost?.last_30 ?? p.cost?.period ?? null, connected: connected(),
      cancel_paid: where === 'public' && terms.kind === 'free' && Boolean(p._subscription && LIVE.has(p._subscription.status))};
  }
  function insert(id, details) {
    const d = {...details, id: randomUUID(), client_id: id};
    db.prepare('INSERT INTO client_deals VALUES(?,?,?,?,?,?)').run(d.id, id, d.state, JSON.stringify(d), now(), now()); return d;
  }
  async function apply(id, p, input) { return locked(id, async () => {
    const old = current(id);
    if (old && !['waiting', 'draft', 'failed'].includes(old.state)) throw refuse('End the current deal before adding another.');
    const details = await preview(p, input);
    if (details.user_id && db.prepare("SELECT id FROM client_deals WHERE state!='ended' AND client_id!=? AND json_extract(details,'$.user_id')=?").get(id, details.user_id)) throw refuse('This public account already has a deal in Clients. Open the existing person.');
    if (old?.coupon_id && ['kind','plan','duration','months','value'].some(k => old[k] !== details[k])) throw refuse('End the current deal before changing its terms.');
    if (old && old.state !== 'waiting' && old.kind !== details.kind) throw refuse('End the current deal before changing its kind.');
    if (details.target === 'public' && details.state !== 'waiting' && !connected()) throw refuse('Public Mastan is not connected yet');
    let sub = null;
    if (details.target === 'public' && details.state !== 'waiting') {
      sub = await subscription(p);
      if (sub && details.kind !== 'free' && sub.plan !== details.plan) throw refuse(`They are on ${sub.plan.replace(/^./, c => c.toUpperCase())}. Change the plan first.`);
    }
    if (sub && details.kind === 'free' && input.cancel_paid !== true) throw refuse('Their paid plan changed. Review the deal again before applying.');
    const d = old ? update(old, {...details, state: details.state, failure: null}) : insert(id, details);
    try {
      if (d.target === 'record' || d.state === 'waiting') { const saved = update(d, {state: d.target === 'record' ? 'active' : 'waiting', starts_at: now()}); event(saved, d.target === 'record' ? 'Deal saved as a note. Nothing enforces this.' : 'Deal waiting for an account.'); return view(id); }
      if (d.target === 'server') {
        if (d.kind === 'free') { if (!['none', 'stopped'].includes(p.billing.state)) await billing().stop(id); }
        else await billing().send(id, d.value);
        update(d, {state: 'active', starts_at: now(), server_link: d.kind === 'custom' ? billing().link(id) : null});
        if (d.ends_at) ctx.store?.save({follow_up: new Date(d.ends_at).toISOString().slice(0, 10)}, {ids: [id], canary_user_id: p.canary_user_id || null, stripe_customer_id: p.stripe_customer_id || null, now: now()});
      } else if (d.kind === 'free') {
        transaction(() => {
          update(d, {state: 'queued', cancel_subscription_id: sub?.id || null, ends_at: null});
          queue(d, 'grant', {user: d.user_id, plan: d.plan});
        });
      } else {
        const couponFields = {duration: d.duration === 'months' ? 'repeating' : d.duration, max_redemptions: 1, 'applies_to[products][0]': d.product_id,
          ...(d.duration === 'months' ? {duration_in_months: d.months} : {}),
          ...(d.kind === 'discount_percent' ? {percent_off: d.value} : {amount_off: d.kind === 'custom' ? d.list_cents - d.pay_cents : Math.round(d.value * 100), currency: 'usd'})};
        // Persist the coupon so retrying a failed subscription update reuses it.
        const coupon = d.coupon_id ? {id: d.coupon_id} : await stripe('POST', '/coupons', couponFields, d.id + '-coupon-' + hash(JSON.stringify(couponFields)).toString('hex'));
        update(d, {coupon_id: coupon.id});
        if (sub) {
          await stripe('POST', '/subscriptions/' + encodeURIComponent(sub.id), {coupon: coupon.id}, d.id + '-attach');
          update(d, {state: 'active', subscription_id: sub.id, starts_at: now()});
        } else update(d, {state: 'link', pay_token: d.pay_token || tokenFor(), customer_id: p.stripe_customer_id || null, ends_at: null});
      }
      event(d, 'Applied deal: ' + d.label); return view(id);
    } catch (error) { update(d, {state: 'draft'}); event(d, 'Deal failed. ' + (error.expose ? error.message : 'Please try again.')); throw error; }
  }); }
  function expireSays() {
    const rows = db.prepare("SELECT * FROM client_deal_commands WHERE kind='say' AND acked_at IS NULL AND created_at<=?").all(now() - DAY);
    for (const c of rows) { db.prepare("UPDATE client_deal_commands SET acked_at=?,status='failed',reason='window' WHERE id=?").run(now(), c.id); const d = get(c.deal_id); if (d) event(d, 'Message failed. ' + FAILURE.window); }
  }
  async function finishGrant(d) {
    if (d.cancel_subscription_id && !d.cancel_done) {
      await stripe('DELETE', '/subscriptions/' + encodeURIComponent(d.cancel_subscription_id));
      update(d, {cancel_done: true}); event(d, 'Paid plan cancelled after the free plan was confirmed. No refund.');
    }
  }
  async function sync(authorization, input) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,64})$/.exec(authorization || ''), saved = db.prepare('SELECT token_hash FROM client_deals_connection WHERE id=1').get();
    if (!match || !saved || !timingSafeEqual(saved.token_hash, hash(match[1]))) return null;
    if (!input || Object.keys(input).some(k => k !== 'acks') || !Array.isArray(input.acks) || input.acks.length > 50 || input.acks.some(a => !a || Object.keys(a).some(k => !['id', 'status', 'reason'].includes(k)) || !Number.isSafeInteger(a.id) || !['done', 'failed'].includes(a.status) || a.status === 'failed' && typeof a.reason !== 'string' || a.reason !== undefined && typeof a.reason !== 'string')) throw refuse('Use valid command results.');
    expireSays();
    for (const ack of input.acks) {
      const reason = Object.hasOwn(FAILURE, ack.reason) ? ack.reason : 'error';
      const c = db.prepare('SELECT * FROM client_deal_commands WHERE id=? AND acked_at IS NULL').get(ack.id); if (!c) continue;
      const d = get(c.deal_id); if (!d) continue;
      await locked(d.client_id, async () => {
        let active = null;
        transaction(() => {
          if (!db.prepare('UPDATE client_deal_commands SET acked_at=?,status=?,reason=? WHERE id=? AND acked_at IS NULL').run(now(), ack.status, ack.status === 'failed' ? reason : null, c.id).changes) return;
          if (c.kind === 'grant' && ack.status === 'done') {
            active = update(d, {state: 'active', starts_at: now(), ends_at: d.duration === 'months' ? addMonths(now(), d.months) : null});
            event(active, 'Free deal is active.');
          } else if (c.kind === 'end_grant' && ack.status === 'done') { update(d, {state: 'ended'}); event(d, 'Deal ended.'); }
          else if (c.kind !== 'say' && ack.status === 'failed') update(d, {state: c.kind === 'end_grant' ? 'end_failed' : 'failed', failure: reason});
          event(d, c.kind === 'say' ? ack.status === 'done' ? 'Message sent.' : 'Message failed. ' + FAILURE[reason] : ack.status === 'failed' ? 'Deal failed. ' + FAILURE[reason] : 'Deal confirmed.');
        });
        if (active) { try { await finishGrant(active); } catch { event(active, 'Free deal is active. Cancelling the paid plan failed; it will be retried.'); } }
      });
    }
    return {commands: db.prepare('SELECT id,kind,params FROM client_deal_commands WHERE acked_at IS NULL ORDER BY id LIMIT 10').all().map(c => ({id: c.id, kind: c.kind, params: JSON.parse(c.params)}))};
  }
  async function end(id) { return locked(id, async () => {
    const d = current(id); if (!d) throw refuse('There is no open deal.');
    if (d.state === 'queued' || d.state === 'ending') throw refuse('Wait for Mastan to confirm this change.');
    try {
      if (d.target === 'public' && d.kind === 'free' && ['active', 'end_failed'].includes(d.state)) {
        if (!connected()) throw refuse('Public Mastan is not connected yet');
        await finishGrant(d); transaction(() => { queue(d, 'end_grant', {user: d.user_id}); update(d, {state: 'ending', failure: null}); });
      } else {
        // Only remove a discount. Ending a deal must never cancel a paying subscription.
        if (d.target === 'public' && d.subscription_id) await removeDiscount(d.subscription_id);
        if (d.session_id && d.state === 'link') {
          await checkSession(d); const fresh = get(d.id);
          if (fresh.subscription_id) await removeDiscount(fresh.subscription_id);
          else { const session = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(d.session_id)); if (session.status === 'open') await stripe('POST', '/checkout/sessions/' + encodeURIComponent(d.session_id) + '/expire', {}, d.id + '-expire'); }
        }
        update(d, {state: 'ended'});
      }
      db.prepare("UPDATE client_deal_commands SET acked_at=?,status='failed',reason='window' WHERE deal_id=? AND kind='say' AND acked_at IS NULL").run(now(), d.id);
      event(d, 'Ended deal. Paying plans keep running.'); return view(id);
    } catch (error) { event(d, 'Ending the deal failed.'); throw error; }
  }); }
  const link = d => d.server_link || (d.pay_token ? `${baseUrl}/pay/d_${d.pay_token}` : null);
  function message(d, language) {
    const lang = Object.hasOwn(COPY, language) ? language : 'en', copy = COPY[lang];
    const text = d.state === 'waiting' ? copy.invite : d.kind === 'free' ? copy.free.replace('{plan}', d.plan === 'pro' ? 'Pro' : 'Plus').replace('{duration}', d.duration === 'forever' ? copy.forever : copy.months.replace('{n}', d.months)) : copy.pay;
    return {text, language: lang, link: d.state === 'waiting' ? 'https://mastan.ai' : link(d)};
  }
  function copy(id, language) { const d = current(id); if (!d) throw refuse('There is no open deal.'); return message(d, language); }
  async function send(id, p, text, language) { return locked(id, () => {
    const d = current(id);
    if (p.sample || !connected()) throw refuse(p.sample ? 'Sample people cannot be messaged.' : 'Public Mastan is not connected yet');
    if (!d || d.target !== 'public' || p.account !== 'found' || !['active', 'link'].includes(d.state) || d.kind === 'free' && d.state !== 'active') throw refuse('Apply the deal to a public account first.');
    checkAccount(p);
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || !Object.hasOwn(COPY, language)) throw refuse('Add a message and choose its language.');
    queue(d, 'say', {user: d.user_id, text, link: d.kind === 'free' ? null : link(d)}); event(d, 'Message waiting to be sent.'); return view(id);
  }); }
  async function checkSession(d) {
    if (!d.session_id || d.state !== 'link') return null;
    const s = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(d.session_id));
    if (s.status === 'complete' && s.subscription) { update(d, {state: 'active', subscription_id: idOf(s.subscription), starts_at: now(), ends_at: d.duration === 'forever' ? null : addMonths(now(), d.duration === 'once' ? 1 : d.months)}); event(d, 'Deal is active. Payment completed.'); }
    return s;
  }
  async function payRedirect(token) {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token || '')) return {page: 'closed'};
    const found = db.prepare("SELECT * FROM client_deals WHERE state IN ('link','active')").all().map(decode).find(d => d.pay_token === token);
    if (!found) return {page: 'closed'};
    return locked(found.client_id, async () => {
      const d = get(found.id); if (!['link', 'active'].includes(d.state)) return {page: 'closed'};
      if (d.state === 'active') return {page: 'paid'};
      const old = await checkSession(d);
      if (old?.status === 'complete') return {page: 'paid'};
      if (old?.status === 'open' && old.url && /^https:\/\/checkout\.stripe\.com\//.test(old.url)) return {redirect: old.url};
      const pr = await price(d.plan);
      if (idOf(pr.product) !== d.product_id || pr.unit_amount !== d.list_cents) throw refuse('The plan price changed. End this deal and make a new link.');
      const s = await stripe('POST', '/checkout/sessions', {mode: 'subscription', 'line_items[0][quantity]': 1, 'line_items[0][price]': pr.id,
        'discounts[0][coupon]': d.coupon_id, client_reference_id: d.user_id, 'subscription_data[metadata][mastan_user_id]': d.user_id,
        ...(d.customer_id ? {customer: d.customer_id} : {}), ...(ctx.config.stripeBillingPaymentConfig ? {payment_method_configuration: ctx.config.stripeBillingPaymentConfig} : {}),
        'consent_collection[terms_of_service]': 'required', 'tax_id_collection[enabled]': true, billing_address_collection: 'auto',
        success_url: `${baseUrl}/pay/d_${token}/done`, cancel_url: `${baseUrl}/pay/d_${token}/done`}, d.id + '-checkout-' + (d.session_id || 'first'));
      if (!s.id || !/^https:\/\/checkout\.stripe\.com\//.test(s.url || '')) throw refuse('Stripe did not answer. Nothing changed.');
      update(d, {session_id: s.id}); return {redirect: s.url};
    });
  }
  async function refresh(id) { return locked(id, async () => { const d = current(id); if (d) { try { await checkSession(d); } catch {} } }); }
  async function tick() {
    expireSays();
    for (const row of db.prepare("SELECT * FROM client_deals WHERE state IN ('active','link')").all()) await locked(row.client_id, async () => {
      const d = get(row.id);
      try {
        await checkSession(d);
        if (d.state === 'active' && d.kind === 'free' && d.target === 'public') await finishGrant(d);
        if (d.state === 'active' && d.target !== 'server' && d.ends_at && d.ends_at <= now()) {
          if (d.kind === 'free' && d.target === 'public') { transaction(() => { queue(d, 'end_grant', {user: d.user_id}); update(d, {state: 'ending', failure: null}); }); }
          else update(d, {state: 'ended'});
          event(d, 'Deal reached its end date.');
        }
      } catch { /* Retry next tick, without logging private exception data. */ }
    });
  }
  function view(id) {
    expireSays();
    const rows = db.prepare('SELECT * FROM client_deals WHERE client_id=? ORDER BY created_at DESC,rowid DESC').all(id).map(decode);
    const clean = d => ({id: d.id, ...Object.fromEntries(['kind','plan','duration','months','value','reason','note','state','label','notice','given_up','ends_at','starts_at','target','failure'].map(k => [k, d[k] ?? null])),
      normal_price: d.list_cents == null ? null : d.list_cents / 100, pay: d.pay_cents == null ? null : d.pay_cents / 100, link: d.state === 'ended' ? null : link(d),
      failure_text: FAILURE[d.failure] || null,
      delivery: (() => { const c = db.prepare("SELECT status,reason FROM client_deal_commands WHERE deal_id=? AND kind='say' ORDER BY id DESC LIMIT 1").get(d.id); return c ? {state: c.status === 'done' ? 'Sent' : c.status === 'failed' ? 'Failed' : 'Waiting', reason: c.status === 'failed' ? FAILURE[c.reason] : null} : null; })()});
    return {current: rows.find(d => d.state !== 'ended') ? clean(rows.find(d => d.state !== 'ended')) : null, history: rows.filter(d => d.state === 'ended').map(clean)};
  }
  let timer;
  const start = () => { if (!timer) { timer = setInterval(() => void tick(), 60_000); timer.unref?.(); } };
  return {connect, connected, preview, apply, end, send, copy, sync, tick, refresh, payRedirect, view, keyState, start, shutdown: () => { clearInterval(timer); timer = null; }};
}
