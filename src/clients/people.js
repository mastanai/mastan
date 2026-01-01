import {OVERLAY, normalizePersonId} from './store.js';
import {riyadhDay, addDays, totals} from './stripe.js';
import {serverCosts} from './fleet.js';

const DAY = 86400_000, STALE = 48 * 3600_000;
const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k] ?? null]));
const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const validTime = value => value == null || Number.isFinite(time(value)) && Math.abs(time(value)) <= 8.64e15;
const strings = (row, keys) => keys.every(k => row[k] == null || typeof row[k] === 'string');
export function parseFeed(value, now) {
  try {
    const feed = typeof value === 'string' ? JSON.parse(value) : value, generated = time(feed.generated_at);
    if (feed.version !== 1 || !Number.isFinite(generated) || generated <= 0 || !validTime(feed.generated_at) || generated > now + 300_000 ||
      !['private_requests', 'billing', 'costs'].every(k => Array.isArray(feed[k]))) throw new Error('FeedShape');
    if ([...feed.private_requests, ...feed.billing, ...feed.costs].some(r => !r || typeof r.user_id !== 'string' || !r.user_id)) throw new Error('FeedShape');
    if (feed.private_requests.some(r => !strings(r, ['plan', 'business', 'identity', 'language']) || !validTime(r.requested_at) || !validTime(r.ready_at) ||
      r.people != null && !['string', 'number'].includes(typeof r.people) || r.contact != null && (typeof r.contact !== 'object' || !strings(r.contact, ['channel', 'address_digits'])))) throw new Error('FeedRequests');
    if (feed.billing.some(r => !strings(r, ['customer_id', 'plan', 'status']) || !validTime(r.period_start) || !validTime(r.period_end) || !validTime(r.cash_since) ||
      r.period_micros != null && (!Number.isSafeInteger(r.period_micros) || r.period_micros < 0))) throw new Error('FeedBilling');
    if (feed.costs.some(r => typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(Date.parse(r.day)) || new Date(r.day).toISOString().slice(0, 10) !== r.day || !Number.isSafeInteger(r.micros) || r.micros < 0)) throw new Error('FeedCosts');
    if (feed.accounts !== undefined && (!Array.isArray(feed.accounts) || feed.accounts.some(r => !r || typeof r.user_id !== 'string' || !strings(r, ['status', 'plan', 'source', 'language']) || ![true, false, 0, 1].includes(r.minor) || ![true, false, 0, 1].includes(r.free_forever) || !Array.isArray(r.identities) || r.identities.some(i => !i || !strings(i, ['channel', 'kind', 'address_digits']) || typeof i.address_digits !== 'string')))) throw new Error('FeedAccounts');
    return {state: now - generated > STALE ? 'stale' : 'ready', generated_at: generated,
      private_requests: feed.private_requests.map(r => ({...pick(r, ['user_id', 'plan', 'business', 'people', 'identity', 'language', 'requested_at', 'ready_at']),
        contact: r.contact && typeof r.contact === 'object' ? pick(r.contact, ['channel', 'address_digits']) : null})),
      billing: feed.billing.map(r => ({...pick(r, ['user_id', 'customer_id', 'plan', 'status', 'period_start', 'period_end', 'period_micros', 'payment_problem', 'cash_since']),
        cash: Boolean(r.cash), cancelling: Boolean(r.cancelling)})),
      ...(feed.accounts !== undefined ? {accounts: feed.accounts.map(r => ({...pick(r, ['user_id', 'status', 'minor', 'plan', 'source', 'free_forever', 'language']), identities: r.identities.map(i => pick(i, ['channel', 'kind', 'address_digits']))}))} : {}),
      costs: feed.costs.map(r => pick(r, ['user_id', 'day', 'micros']))};
  } catch { return {state: 'unavailable', generated_at: null, private_requests: [], billing: [], costs: []}; }
}

function costsFor(person, feed, fleet, now) {
  if (person.server) return serverCosts(person, fleet, now);
  const cost = {period: null, all_time: null, last_30: null, source: null, monthly_eur: null, reason: null};
  // Private and Enterprise have their own servers; public account costs omit their server's LLM spend.
  if (!['Plus', 'Pro'].includes(person.plan)) return {...cost, reason: 'Link a server'};
  cost.source = 'Public costs';
  if (feed.state !== 'ready') return cost;
  const rows = feed.costs.filter(r => r.user_id === person.canary_user_id);
  // public/first-month-50:src/public/costs.js uses integer micro-dollars: 1 USD = 1,000,000 micros.
  const billing = feed.billing.find(b => person.canary_user_id && b.user_id === person.canary_user_id &&
    (person.stripe_customer_id ? b.customer_id === person.stripe_customer_id : b.cash && !b.customer_id) &&
    person.period_start && person.period_end && b.period_start != null && b.period_end != null &&
    Math.abs(time(b.period_start) - person.period_start) <= DAY && Math.abs(time(b.period_end) - person.period_end) <= DAY &&
    Number.isSafeInteger(b.period_micros));
  return {...cost, all_time: rows.length ? rows.reduce((n, r) => n + r.micros, 0) / 1e6 : null,
    period: billing ? billing.period_micros / 1e6 : null};
}

export function matchAccount(person, feed) {
  if (feed.state !== 'ready' || !feed.accounts) return {account: 'unknown', _account: null};
  const identity = normalizePersonId(person.person_id || person.phone);
  const matches = feed.accounts.filter(a => person.canary_user_id ? a.user_id === person.canary_user_id : identity && a.identities.some(i => {
    if (!/^\d+$/.test(i.address_digits)) return false;
    const digits = i.address_digits;
    return identity === (i.channel === 'telegram' ? 'Telegram ' + digits : i.channel === 'whatsapp' && i.kind === 'lid' ? 'WhatsApp hidden ' + digits : i.channel === 'whatsapp' && i.kind === 'pn' ? '+' + digits : null);
  }));
  return {account: matches.length === 1 ? 'found' : 'none', _account: matches.length === 1 ? matches[0] : null};
}

// Monthly list prices in USD for plans paid in cash to Owner (no Stripe customer).
const CASH_PRICES = {plus: 10, pro: 30};
const CASH_LABELS = {active: 'Active', past_due: 'Past due', canceled: 'Cancelled', ended: 'Ended'};

export function cashPerson(b, now) {
  const plan = String(b.plan || '').toLowerCase(), price = CASH_PRICES[plan] ?? null;
  const start = b.period_start == null ? null : time(b.period_start), end = b.period_end == null ? null : time(b.period_end);
  const open = ['active', 'past_due'].includes(b.status) && (!end || end > now);
  const cancelling = open && b.cancelling, status = open ? b.status : b.status === 'active' ? 'ended' : b.status || 'ended';
  const since = b.cash_since == null ? start : time(b.cash_since);
  // Each started month counts as paid, from the first cash start up to the current period.
  const months = since && start ? Math.max(1, Math.round((start - since) / (30 * DAY)) + 1) : 1;
  const money = price === null ? {} : {usd: price};
  return {_subscription: null, id: 'canary:' + b.user_id, canary_user_id: b.user_id, stripe_customer_id: null,
    name: '', email: '', phone: '', country: null, created_at: since, delinquent: false,
    plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null, plan_detail: 'Cash', amount: money, mrr: open ? money : {},
    status, paying: open, customer: true, cancelling, discount: null, period_paid: null,
    status_label: cancelling ? 'Cancelling' : CASH_LABELS[status] || 'Ended',
    period_start: start, period_end: end, checkout_failed_at: null,
    next_due: open && !cancelling ? end : null, overdue_since: status === 'past_due' ? start : null,
    lifetime: price === null ? {} : {usd: price * months}, last_paid: start, source: 'Cash'};
}

export function buildPeople(stripe, feed, store, now, fleet = {state: 'unavailable', servers: [], usage: []}) {
  const rows = store.rows(), used = new Set(), people = stripe.people.map(p => ({...p}));
  if (feed.state !== 'unavailable') for (const b of feed.billing) {
    if (!b.cash || b.customer_id || people.some(p => !p.sample && p.canary_user_id === b.user_id && p.paying)) continue;
    const cash = cashPerson(b, now), wa = feed.accounts?.find(a => a.user_id === b.user_id)?.identities.find(i => i.channel === 'whatsapp' && i.kind === 'pn' && /^\d+$/.test(i.address_digits));
    if (wa) cash.phone = '+' + wa.address_digits;
    const old = people.findIndex(p => !p.sample && p.canary_user_id === b.user_id);
    if (old >= 0) people[old] = {...people[old], ...cash, id: people[old].id, name: people[old].name, email: people[old].email, phone: people[old].phone};
    else people.push(cash);
  }
  for (const request of feed.private_requests) {
    const sameUser = p => p.canary_user_id === request.user_id || feed.billing.some(b => b.user_id === request.user_id && b.customer_id && b.customer_id === p.stripe_customer_id);
    let person = people.find(p => !p.sample && p.paying && sameUser(p));
    if (!person) person = people.find(p => !p.sample && p.canary_user_id === request.user_id);
    if (!person) {
      person = {id: 'canary:' + request.user_id, canary_user_id: request.user_id, stripe_customer_id: null,
        name: request.business || 'Private request', email: '', phone: '', plan: request.plan ? String(request.plan).replace(/^./, c => c.toUpperCase()) : 'Private',
        created_at: time(request.requested_at), status: 'lead', status_label: 'Lead', source: 'Private request', amount: {}, mrr: {}, lifetime: {}};
      people.push(person);
    }
    person.private_request = request;
    if (request.contact?.channel === 'whatsapp' && !person.phone) person.phone = request.contact.address_digits || '';
  }
  // Match only people already in Clients, keeping the full account index in memory.
  for (const row of rows) {
    const matched = matchAccount(row, feed);
    if (!row.canary_user_id && matched._account && !rows.some(r => r.id !== row.id && r.canary_user_id === matched._account.user_id)) {
      row.canary_user_id = matched._account.user_id;
      store.match?.(row.id, row.canary_user_id);
    }
  }
  // Billing helps join a previously edited canary lead, but costs still require subscription metadata.
  for (const person of people) {
    const billing = feed.billing.find(b => b.customer_id === person.stripe_customer_id && b.customer_id);
    person._billing_user = billing?.user_id;
    if (billing) person.payment_problem = Boolean(billing.payment_problem);
    const matches = rows.filter(r => !used.has(r.id) && (
      person.stripe_customer_id && r.stripe_customer_id === person.stripe_customer_id ||
      person.canary_user_id && r.canary_user_id === person.canary_user_id ||
      billing && r.canary_user_id === billing.user_id ||
      person.stripe_customer_id && !r.stripe_customer_id && !r.canary_user_id && r.email && person.email && r.email.toLowerCase() === person.email.toLowerCase()));
    for (const r of matches) used.add(r.id);
    person._rows = matches;
  }
  for (const row of rows.filter(r => !used.has(r.id))) people.push({id: row.stripe_customer_id ? 'stripe:' + row.stripe_customer_id : row.canary_user_id ? 'canary:' + row.canary_user_id : row.id,
    stripe_customer_id: row.stripe_customer_id, canary_user_id: row.canary_user_id, name: row.name || 'Unnamed lead', email: row.email || '', phone: row.phone || '',
    created_at: row.created_at, status: 'lead', status_label: row.stripe_customer_id ? 'Stripe unavailable' : 'Lead', source: 'Manual', amount: {}, mrr: {}, lifetime: {}, _rows: [row]});
  const today = riyadhDay(now), soon = addDays(today, 7);
  for (const p of people) {
    const matches = p._rows || [];
    for (const row of matches) for (const k of p.stripe_customer_id || p.canary_user_id && !matches.some(r => r.name !== null) ? OVERLAY : [...OVERLAY, 'name', 'email', 'phone']) if (row[k] !== null) p[k] = row[k];
    const notes = [...new Set(matches.map(r => r.notes).filter(Boolean))];
    if (notes.length) p.notes = notes.join('\n\n');
    Object.assign(p, matchAccount(p, feed));
    if (p._account && !p.canary_user_id) p.canary_user_id = p._account.user_id;
    if (!p.plan && p._account?.plan) p.plan = p._account.plan.replace(/^./, c => c.toUpperCase());
    p.tag = p.tag || null;
    p.tag_default = !p.tag;
    p.tag_label = p.tag ? ({not_sure: 'Not sure'}[p.tag] || p.tag[0].toUpperCase() + p.tag.slice(1)) : p.paying ? 'Customer' : p.status === 'canceled' ? 'Lost' : 'No tag';
    p.manual = !p.sample && !p.stripe_customer_id && (!p.canary_user_id || matches.some(r => r.name !== null));
    p.llm_default = !matches.some(r => r.llm_covered !== null);
    p.llm_covered = p.llm_covered ?? (['Plus', 'Pro'].includes(p.plan) ? 1 : null);
    p.cost = costsFor(p, feed, fleet, now);
    if (p.llm_covered === null && (p.cost.period !== null || p.cost.last_30 !== null)) p.cost.reason = 'Set LLM coverage to see margin';
    p.margin = null; p.margin_percent = null;
    p.margin_label = p.llm_covered === 0 ? 'LLM not on us' : 'Before Stripe fees and server rent';
    if (Object.keys(p.amount).length === 1 && Number.isFinite(p.amount.usd) && p.llm_covered !== null && (p.llm_covered === 0 || p.cost.period !== null)) {
      const base = p.period_paid ?? p.amount.usd;
      p.margin = base - (p.llm_covered === 0 ? 0 : p.cost.period);
      p.margin_percent = base > 0 ? p.margin / base * 100 : null;
    }
    if (!p.server && p._account?.free_forever && p.canary_user_id && feed.state === 'ready') {
      const end = new Date(now).toISOString().slice(0, 10), start = addDays(end, -29);
      const costs = feed.costs.filter(r => r.user_id === p.canary_user_id && r.day >= start && r.day <= end);
      p.cost.last_30 = costs.reduce((n, r) => n + r.micros, 0) / 1e6;
      if (!p.paying) { p.margin = p.cost.last_30 ? -p.cost.last_30 : 0; p.margin_percent = null; p.margin_label = 'Cost with no revenue'; }
    }
    p.events = store.events(matches.map(r => r.id));
    p.follow_up_due = Boolean(p.follow_up && p.follow_up <= today);
    p.due_soon = Boolean(p.next_due && riyadhDay(p.next_due) >= today && riyadhDay(p.next_due) <= soon);
    p.at_risk = Boolean(p.overdue_since || p.cancelling);
    const hot = p.tag === 'hot' && (!p.last_contact || p.last_contact <= addDays(today, -7));
    const checkout = !p.tag && p.checkout_failed_at && p.checkout_failed_at >= now - 14 * DAY && p.checkout_failed_at <= now;
    p.action_rank = p.overdue_since ? 0 : p.follow_up_due ? 1 : hot ? 2 : checkout ? 3 : p.cancelling ? 4 : p.private_request && !p.tag ? 5 : 6;
    const followDate = p.follow_up ? new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Riyadh', month: 'short', day: 'numeric'}).format(new Date(p.follow_up + 'T12:00:00+03:00')) : '';
    p.action_reason = ['Overdue payment', followDate ? 'Follow up ' + followDate : 'Follow up', 'Hot lead, no contact in 7 days', 'Checkout failed', 'Cancelling soon', 'New private request'][p.action_rank] || '';
  }
  return people;
}

export function kpis(people, mode) {
  const real = people.filter(p => mode === 'sample' || !p.sample), money = filter => real.filter(filter).reduce((out, p) => totals(out, p.mrr), {});
  return {paying: real.filter(p => p.paying).length,
    mrr: money(p => p.status === 'active' || p.cancelling && !p.overdue_since), at_risk: {count: real.filter(p => p.at_risk).length, amount: money(p => p.at_risk)},
    due: {count: real.filter(p => p.due_soon).length, amount: money(p => p.due_soon)},
    overdue: {count: real.filter(p => p.overdue_since).length, amount: money(p => p.overdue_since)},
    given_up: real.reduce((n, p) => n + (p.deal?.state === 'active' ? p.deal.given_up || 0 : 0), 0),
    follow_ups: real.filter(p => p.follow_up_due || p.deal_ending).length};
}

export function publicPerson({_rows, _billing_user, _account, _subscription, ...person}) { return person; }
