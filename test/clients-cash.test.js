import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createClientsStore} from '../src/clients/store.js';
import {parseFeed, buildPeople, kpis, cashPerson} from '../src/clients/people.js';

const NOW = Date.parse('2026-11-24T20:00:00Z'), DAY = 86400_000;
const START = NOW - 2 * 3600_000, END = START + 30 * DAY;
const cashRow = patch => ({user_id: 'u_cash', customer_id: null, plan: 'plus', status: 'active', period_start: START, period_end: END,
  payment_problem: 0, cash: 1, cancelling: 0, cash_since: START, period_micros: 1_500_000, ...patch});
const feedWith = (billing, extra = {}) => parseFeed({version: 1, generated_at: new Date(NOW).toISOString(), private_requests: [], costs: [],
  billing, accounts: [{user_id: 'u_cash', status: 'active', minor: 0, plan: 'plus', source: null, free_forever: 0, language: 'az',
    identities: [{channel: 'whatsapp', kind: 'pn', address_digits: '994770000000'}]}], ...extra}, NOW);
const store = () => createClientsStore(new DatabaseSync(':memory:'));

test('a cash payer with no Stripe customer is listed as a paying Plus customer', () => {
  const feed = feedWith([cashRow()]);
  assert.equal(feed.state, 'ready');
  const people = buildPeople({people: []}, feed, store(), NOW), p = people.find(x => x.canary_user_id === 'u_cash');
  assert.ok(p);
  assert.equal(p.paying, true); assert.equal(p.plan, 'Plus'); assert.equal(p.source, 'Cash'); assert.equal(p.status_label, 'Active');
  assert.deepEqual(p.amount, {usd: 10}); assert.deepEqual(p.lifetime, {usd: 10}); assert.equal(p.next_due, END); assert.equal(p.phone, '+994770000000');
  assert.equal(p.tag_label, 'Customer'); assert.equal(p.cost.period, 1.5); assert.equal(p.margin, 8.5);
  const k = kpis(people, 'live'); assert.equal(k.paying, 1); assert.deepEqual(k.mrr, {usd: 10});
});

test('a saved name on the canary row overrides the empty cash name', () => {
  const s = store(); s.save({name: 'Invented Cash Name', source: 'People'}, {canary_user_id: 'u_cash'});
  const p = buildPeople({people: []}, feedWith([cashRow()]), s, NOW).find(x => x.canary_user_id === 'u_cash');
  assert.equal(p.name, 'Invented Cash Name'); assert.equal(p.paying, true);
});

test('cancelling keeps paying to the end date; past the end it is no longer paying', () => {
  const cancelling = cashPerson({...cashRow(), cancelling: true}, NOW);
  assert.equal(cancelling.paying, true); assert.equal(cancelling.status_label, 'Cancelling'); assert.equal(cancelling.next_due, null);
  const ended = cashPerson({...cashRow(), period_end: NOW - DAY}, NOW);
  assert.equal(ended.paying, false); assert.equal(ended.status_label, 'Ended'); assert.deepEqual(ended.mrr, {});
});

test('lifetime counts each month since the first cash start', () => {
  assert.deepEqual(cashPerson({...cashRow(), cash_since: START - 60 * DAY}, NOW).lifetime, {usd: 30});
  assert.deepEqual(cashPerson({...cashRow(), plan: 'pro'}, NOW).amount, {usd: 30});
});

test('Stripe billing rows and non-cash rows add nobody; unavailable feed adds nobody', () => {
  const stripeRow = cashRow({user_id: 'u_stripe', customer_id: 'cus_invented', cash: 0});
  const empty = cashRow({user_id: 'u_empty', plan: null, status: null, period_start: null, period_end: null, cash: 0, cash_since: null});
  assert.deepEqual(buildPeople({people: []}, feedWith([stripeRow, empty]), store(), NOW), []);
  assert.deepEqual(buildPeople({people: []}, parseFeed(null, NOW), store(), NOW), []);
});

test('an older feed without cash fields still parses', () => {
  const {cash, cancelling, cash_since, ...old} = cashRow();
  const feed = feedWith([old]);
  assert.equal(feed.state, 'ready'); assert.equal(feed.billing[0].cash, false);
});
