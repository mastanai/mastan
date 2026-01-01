import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const PATHS = new Set(['/v1/subscriptions', '/v1/customers', '/v1/charges']);
const ORDER = ['active', 'past_due', 'unpaid', 'trialing', 'paused', 'canceled', 'incomplete', 'incomplete_expired'];
const PLANS = {plus_monthly: 'Plus', pro_monthly: 'Pro', private_monthly: 'Private', enterprise_monthly: 'Enterprise'};
const DAY = 86400_000;
export const riyadhDay = (at = Date.now()) => new Date(at + 3 * 3600_000).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const totals = (into, amounts) => { for (const [currency, amount] of Object.entries(amounts)) into[currency] = (into[currency] || 0) + amount; return into; };
const idOf = value => typeof value === 'string' ? value : value?.id;
const seconds = value => Number.isFinite(value) && value > 0 ? value * 1000 : null;
const currencyOf = value => typeof value === 'string' && /^[a-z]{3}$/.test(value) ? value : null;
const monthly = r => r ? ({month: 1, year: 1 / 12, week: 365.25 / 7 / 12, day: 365.25 / 12}[r.interval] || 0) / (r.interval_count || 1) : 0;
// ISK and UGX keep Stripe's two-decimal API representation despite their zero-decimal display.
const major = (amount, currency) => amount / 10 ** (['isk', 'ugx'].includes(currency) ? 2 : new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits);

export async function readKey(file) {
  let key;
  try { key = (await readFile(file, 'utf8')).trim(); }
  catch (error) { return {mode: error.code === 'ENOENT' ? 'sample' : 'error', error: error.code === 'ENOENT' ? null : 'Stripe key file is unreadable.'}; }
  if (!/^rk_(live|test)_[A-Za-z0-9]+$/.test(key)) return {mode: 'error', error: 'key is not restricted'};
  return {mode: key.startsWith('rk_live_') ? 'live' : 'test', key, fingerprint: createHash('sha256').update(key).digest('hex')};
}

export async function stripeList(path, key, mode, transport = globalThis.fetch) {
  if (!PATHS.has(path)) throw new Error('StripePath');
  const rows = []; let after;
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.stripe.com' + path);
    url.searchParams.set('limit', '100');
    if (path === '/v1/subscriptions') url.searchParams.set('status', 'all');
    if (after) url.searchParams.set('starting_after', after);
    const response = await transport(url.href, {method: 'GET', redirect: 'error',
      headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20'}, signal: AbortSignal.timeout(12_000)});
    if (!response.ok) throw Object.assign(new Error('StripeHttp'), {status: response.status});
    const body = await response.json();
    if (!Array.isArray(body.data) || typeof body.has_more !== 'boolean') throw new Error('StripeShape');
    for (const row of body.data) if (row.livemode !== (mode === 'live')) throw new Error('StripeMode');
    rows.push(...body.data);
    if (!body.has_more) return {rows, truncated: false};
    after = body.data.at(-1)?.id;
    if (!after || typeof after !== 'string') throw new Error('StripePage');
  }
  return {rows, truncated: true};
}

export function normalize({customers, subscriptions, charges}) {
  const best = new Map(), paid = new Map();
  const rank = s => ORDER.indexOf(s.status) < 0 ? ORDER.length : ORDER.indexOf(s.status);
  for (const s of subscriptions) {
    const id = idOf(s.customer), old = best.get(id);
    if (!old || rank(s) < rank(old) || rank(s) === rank(old) && s.created > old.created) best.set(id, s);
  }
  for (const c of charges) {
    if (c.status !== 'succeeded') continue;
    const currency = currencyOf(c.currency); if (!currency) continue;
    const id = idOf(c.customer), old = paid.get(id) || {lifetime: {}, last_paid: null, charges: []};
    const net = major(Math.max(0, c.amount - (c.amount_refunded || 0)), currency);
    old.charges.push({currency, amount: net, created_at: seconds(c.created)});
    totals(old.lifetime, {[currency]: net});
    old.last_paid = Math.max(old.last_paid || 0, seconds(c.created) || 0) || null;
    paid.set(id, old);
  }
  return customers.filter(c => !c.deleted).map(c => {
    const s = best.get(c.id), items = s?.items?.data || [], price = items[0]?.price;
    const lookup = price?.lookup_key, amount = {};
    for (const item of items) {
      const p = item.price, currency = currencyOf(p?.currency), r = p?.recurring;
      if (!currency || !r || !Number.isFinite(p.unit_amount)) continue;
      const factor = monthly(r);
      if (factor) totals(amount, {[currency]: major(p.unit_amount, currency) * (item.quantity ?? 1) * factor});
    }
    const coupon = s?.discount?.coupon, once = coupon?.duration === 'once';
    let discount = coupon?.percent_off ? `${coupon.percent_off}% off${once ? ' first month' : ''}`
      : coupon?.amount_off && currencyOf(coupon.currency) ? `${coupon.currency.toUpperCase()} ${major(coupon.amount_off, coupon.currency)} off${once ? ' first month' : ''}` : null;
    const history = paid.get(c.id), charge = history?.charges.length === 1 ? history.charges[0] : null;
    const start = seconds(s?.current_period_start);
    let period_paid = null;
    if ((!coupon || once) && charge?.currency === 'usd' && Object.keys(amount).length === 1 && amount.usd > 0 &&
      start && charge.created_at >= start - DAY && charge.amount < amount.usd) {
      if (!discount) discount = `${Math.round((1 - charge.amount / amount.usd) * 100)}% off first month`;
      period_paid = charge.amount;
    }
    const mrr = {...amount};
    if (coupon && !once) for (const currency of Object.keys(mrr)) {
      if (coupon.percent_off) mrr[currency] *= 1 - coupon.percent_off / 100;
      else if (coupon.currency === currency) mrr[currency] = Math.max(0, mrr[currency] - major(coupon.amount_off || 0, currency) * (monthly(price?.recurring) || 1));
    }
    const status = s?.status || 'lead', cancelling = Boolean(s?.cancel_at_period_end && ['active', 'past_due', 'trialing'].includes(status));
    const paying = ['active', 'past_due'].includes(status) || cancelling;
    const customer = Boolean(s && !['incomplete', 'incomplete_expired'].includes(status));
    return {_subscription: s?.id ? {id: s.id, status: s.status, plan: PLANS[lookup] || 'Other'} : null, id: 'stripe:' + c.id, stripe_customer_id: c.id, canary_user_id: s?.metadata?.mastan_user_id || null,
      name: c.name || '', email: c.email || '', phone: c.phone || '', country: c.address?.country || null,
      created_at: seconds(c.created), delinquent: Boolean(c.delinquent), plan: PLANS[lookup] || (price ? 'Other' : null),
      plan_detail: !PLANS[lookup] ? price?.nickname || lookup || '' : '', amount, mrr, status, paying, customer, cancelling,
      status_label: cancelling ? 'Cancelling' : ({active: 'Active', past_due: 'Past due', unpaid: 'Past due', trialing: 'Trial', paused: 'Paused', canceled: 'Cancelled', incomplete: 'Checkout failed', incomplete_expired: 'Checkout failed'}[status] || 'Lead'),
      discount, period_paid, period_start: start, period_end: seconds(s?.current_period_end),
      checkout_failed_at: ['incomplete', 'incomplete_expired'].includes(status) ? seconds(s.created) : null,
      next_due: !cancelling && ['active', 'trialing'].includes(status) ? seconds(s.current_period_end) : null,
      overdue_since: ['past_due', 'unpaid'].includes(status) ? seconds(s.current_period_start) : null,
      lifetime: paid.get(c.id)?.lifetime || {}, last_paid: paid.get(c.id)?.last_paid || null, source: 'Stripe'};
  });
}

export function samples(now) {
  const names = ['Rana Haddad', 'Omar Nasser', 'Lina Saleh', 'Sami Faris', 'Dalia Amin'];
  const plans = ['plus', 'pro', 'private', 'enterprise', 'plus'];
  const customers = names.map((name, i) => ({id: `sample_${i}`, name: 'Sample: ' + name, email: `sample${i}@example.invalid`, created: now / 1000 - 20 * 86400}));
  const subscriptions = customers.map((c, i) => ({customer: c.id, status: i === 1 ? 'past_due' : 'active', created: now / 1000,
    cancel_at_period_end: i === 2, current_period_start: now / 1000 - 10 * 86400, current_period_end: now / 1000 + (i + 1) * 86400,
    discount: i === 4 ? {coupon: {duration: 'once', percent_off: 50}} : null,
    items: {data: [{quantity: 1, price: {currency: 'usd', lookup_key: plans[i] + '_monthly', unit_amount: [1000, 3000, 10000, 20000, 1000][i], recurring: {interval: 'month'}}}]}}));
  return normalize({customers, subscriptions, charges: []}).map((p, i) => ({...p, id: 'sample:' + i, stripe_customer_id: null, sample: true, source: 'Sample'}));
}

export function createStripe(config, {stripeTransport, now = Date.now} = {}) {
  let last, recent, inflight, lastAttempt = -Infinity, fingerprint;
  return async refresh => {
    const state = await readKey(config.stripeReadKeyFile || '/etc/mastan-me/stripe-read-key');
    if (state.mode === 'sample') return {mode: 'sample', people: samples(now()), updated_at: now(), warning: null, truncated: false};
    if (state.error) return {mode: 'error', people: [], updated_at: null, warning: state.error, truncated: false};
    if (fingerprint !== state.fingerprint) { last = null; recent = null; inflight = null; lastAttempt = -Infinity; fingerprint = state.fingerprint; }
    if (inflight) return inflight;
    if (last && now() - last.updated_at < 60_000 && (!refresh || now() - lastAttempt < 10_000)) return recent || last;
    if (now() - lastAttempt < 10_000 && recent) return recent;
    lastAttempt = now();
    const currentFingerprint = fingerprint;
    inflight = (async () => {
      try {
        const settled = await Promise.allSettled(['/v1/customers', '/v1/subscriptions', '/v1/charges'].map(path => stripeList(path, state.key, state.mode, stripeTransport)));
        const failed = settled.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
        const lists = settled.map(r => r.value);
        const result = {mode: state.mode, updated_at: now(), people: normalize({customers: lists[0].rows, subscriptions: lists[1].rows, charges: lists[2].rows}),
          truncated: lists.some(l => l.truncated) || lists[1].rows.some(s => s.items?.has_more), warning: null, stale: false};
        if (fingerprint === currentFingerprint) { last = result; recent = result; }
        return result;
      } catch (error) {
        // Never log Stripe bodies or exception messages: they can contain private data.
        console.error(`[clients] Stripe ${Number(error.status) || 0} ${['StripeHttp', 'StripeShape', 'StripeMode', 'StripePage', 'StripePath'].includes(error.message) ? error.message : 'TransportError'}`);
        const warning = error.message === 'StripeMode' ? 'Stripe mode mismatch.' : 'Stripe unavailable.';
        const result = last ? {...last, stale: true, warning: warning + ' Showing saved data.'} : {mode: state.mode, people: [], updated_at: null, warning, stale: true, truncated: false};
        if (fingerprint === currentFingerprint) recent = result;
        return result;
      } finally { if (fingerprint === currentFingerprint) inflight = null; }
    })();
    return inflight;
  };
}
