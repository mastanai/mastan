// Local browser fixture only. No login bypass exists in src/.
import {createServer} from 'node:http';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'clients-dev-'));
process.env.MASTAN_ME_DATA = data;
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const A = await import('../src/web/auth.js');
const {createClientsStore} = await import('../src/clients/store.js');
const {riyadhDay, addDays} = await import('../src/clients/stripe.js');
const scenario = process.env.CLIENTS_DEV_SCENARIO || 'sample';
if (!['sample', 'test'].includes(scenario)) throw new Error('Use CLIENTS_DEV_SCENARIO=sample or test');
const devPort = Number(process.env.CLIENTS_DEV_PORT || 3199);
config.host = '127.0.0.1:' + devPort; config.origin = 'http://' + config.host; config.port = devPort;
config.stripeReadKeyFile = join(data, 'stripe-key');
config.stripeBillingKeyFile = join(data, 'stripe-billing-key');
writeFileSync(config.stripeBillingKeyFile, 'rk_test_' + 'inventedDealsFixture', {mode: 0o600});
const db = openDb(), store = createClientsStore(db), now = Date.now();
A.addCredential(db, {id: 'invented-local-owner', publicKey: new Uint8Array(32).fill(1)});
const session = A.createSession(db, 'invented-local-owner');
store.save({name: 'Sample lead: Noura', email: 'noura@example.invalid', company: 'Invented Studio', tag: 'hot', notes: 'Asked for a demo', follow_up: riyadhDay(now)}, {now});
store.save({name: 'Sample lead: Ali', phone: '+966555000000', tag: 'warm', follow_up: addDays(riyadhDay(now), 3)}, {now});
config.clientsCanaryKeyFile = join(data, 'canary-key');
writeFileSync(config.clientsCanaryKeyFile, 'inventedLocalFixtureOnly', {mode: 0o600});
let canaryData = null;
const fleetFile = join(data, 'fleet.json');
let stripeTransport = async () => { throw new Error('Fixture only, no Stripe connection'); };
if (scenario === 'test') {
  writeFileSync(config.stripeReadKeyFile, 'rk_test_' + 'inventedLocalFixtureOnly', {mode: 0o600});
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/stripe-test-mode.json', import.meta.url)));
  const privateSub = fixture.subscriptions.find(s => s.items.data[0].price.lookup_key === 'private_monthly');
  privateSub.current_period_start = Math.floor(now / 1000) - 10 * 86400;
  privateSub.current_period_end = Math.floor(now / 1000) + 20 * 86400;
  store.save({server: 'invented-studio-01', llm_covered: 1}, {stripe_customer_id: privateSub.customer, now});
  writeFileSync(fleetFile, JSON.stringify({generated_at: now / 1000,
    servers: [{name: 'invented-studio-01', kind: 'Client', client: 'Invented Studio', monthly_eur: 12.5, connected: true, last_ok: now / 1000}],
    usage: [{server: 'invented-studio-01', day: riyadhDay(now), input: 10000, output: 2000, cost: 4.5}]}));
  const statuses = ['past_due', 'trialing', 'paused', 'canceled', 'unpaid', 'incomplete', 'active'];
  for (const [i, status] of statuses.entries()) {
    const c = {...fixture.customers[0], id: 'cus_invented_' + i, name: 'Sample test: ' + ['Maha', 'Hadi', 'Salma', 'Walid', 'Lama', 'Zaid', 'Amal'][i], email: `invented${i}@example.invalid`, phone: '+966555000000'};
    fixture.customers.push(c);
    fixture.subscriptions.push({...structuredClone(fixture.subscriptions[0]), id: 'sub_invented_' + i, customer: c.id, status, cancel_at_period_end: i === 6,
      created: Math.floor(now / 1000), current_period_start: Math.floor(now / 86400_000) * 86400 - 10 * 86400, current_period_end: Math.floor(now / 1000) + (i + 1) * 86400,
      discount: i === 1 ? {coupon: {duration: 'once', percent_off: 50}} : i === 6 ? {coupon: {duration: 'forever', percent_off: 20}} : null});
  }
  stripeTransport = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/v1/prices') { const plan = u.searchParams.get('lookup_keys[]').split('_')[0]; return {ok: true, json: async () => ({data: [{id: 'price_invented_' + plan, product: 'prod_invented_' + plan, active: true, currency: 'usd', unit_amount: plan === 'pro' ? 3000 : 1000, lookup_key: plan + '_monthly', recurring: {interval: 'month'}}]})}; }
    if (u.pathname === '/v1/coupons') return {ok: true, json: async () => ({id: 'coupon_invented'})};
    if (init.method !== 'GET') throw new Error('This fixture does not open real payment pages.');
    return {ok: true, json: async () => ({data: fixture[u.pathname.split('/').at(-1)], has_more: false})};
  };
  canaryData = JSON.stringify({version: 1, generated_at: new Date(now).toISOString(),
    private_requests: [{user_id: 'invented-request', plan: 'private', business: 'Sample: Cedar Design', people: 4, identity: 'work', language: 'en', requested_at: now, ready_at: null, contact: {channel: 'whatsapp', address_digits: '966555000000'}}],
    billing: fixture.subscriptions.map(s => ({user_id: s.metadata.mastan_user_id, customer_id: s.customer,
      period_start: s.current_period_start * 1000, period_end: s.current_period_end * 1000, period_micros: 2_500_000})), costs: [{user_id: 'user-fixture-1', day: riyadhDay(now), micros: 2_500_000}]});
}
// Three invented deals, including a usable public preview. Every request remains on the fake transport.
const {createDeals} = await import('../src/clients/deals.js');
const demoDeals = createDeals({db, config}, {transport: stripeTransport || (async () => { throw new Error('Fixture only'); }), now: () => now});
const demoToken = demoDeals.connect();
const publicId = store.save({name: 'Sample deal: Leyla', phone: '+994555000123', person_id: '+994555000123', country: 'AZ', language: 'az', source: 'People'});
const waitingId = store.save({name: 'Sample deal: Waiting', phone: 'Telegram 123450001', person_id: 'Telegram 123450001', source: 'People'});
const recordId = store.save({name: 'Sample deal: Client A', source: 'Client A'});
const demoTerms = {kind: 'free', plan: 'pro', duration: 'months', months: 3, reason: 'Invented fixture only'};
if (scenario === 'sample') rmSync(config.stripeBillingKeyFile);
await demoDeals.apply(publicId, {id: publicId, person_id: '+994555000123', canary_user_id: 'u_invented_deal', account: 'found', _account: {status: 'active', minor: false}}, {...demoTerms, ...(scenario === 'test' ? {kind: 'discount_percent', value: 20} : {})});
if (scenario === 'sample') { const pending = await demoDeals.sync('Bearer ' + demoToken, {acks: []}); await demoDeals.sync('Bearer ' + demoToken, {acks: pending.commands.map(c => ({id:c.id,status:'done'}))}); }
await demoDeals.apply(waitingId, {id: waitingId, person_id: 'Telegram 123450001', account: 'none'}, demoTerms);
await demoDeals.apply(recordId, {id: recordId, source: 'Client A'}, demoTerms);
const demoFeed = canaryData ? JSON.parse(canaryData) : {version: 1, generated_at: now, private_requests: [], billing: [], costs: []};
demoFeed.accounts = [{user_id:'u_invented_deal',status:'active',minor:false,plan:'pro',source:'free',free_forever:scenario === 'sample',language:'az',identities:[{channel:'whatsapp',kind:'pn',address_digits:'994555000123'}]}];
canaryData = JSON.stringify(demoFeed);
const web = createWeb({config, db, atlas: {stats: () => ({})}, fleetUsageFile: fleetFile}, {stripeTransport, canaryFetch: async () => canaryData});
// One connected client, so the Monthly plan section shows.
const {createBilling} = await import('../src/clients/billing.js');
createBilling({db, config}).connect(store.save({name: 'Sample client: Abdul', phone: '+966555000001', tag: 'customer'}), 'sample-server-01');
db.prepare('UPDATE client_billing SET last_seen=?').run(now - 120_000);
if (process.argv.includes('--check')) {
  const records = db.prepare('SELECT state,details FROM client_deals').all().map(r => ({...JSON.parse(r.details), state:r.state}));
  if (records.length !== 3 || !records.some(d => d.target === 'public' && d.state !== 'waiting') || !records.some(d => d.state === 'waiting') || !records.some(d => d.target === 'record')) throw new Error('Incomplete deal fixtures');
  db.close(); rmSync(data, {recursive:true,force:true});
  console.log('Invented deal fixtures ready. No server started.'); process.exit(0);
}
// Stand-ins for the People gate and Canary. Invented data only.
const devPeople = [
  {id: '+966555000111', masked: false, name: 'Invented: Layla', channels: ['whatsapp'], country: 'Saudi Arabia', language: 'ar', servers: ['prod-01'], plan: 'free', first: now / 1000 - 9e6, last: now / 1000 - 8e4, messages_in: 212, messages_out: 240},
  {id: '+994550000222', masked: false, name: 'Invented: Kamran', channels: ['whatsapp'], country: 'Azerbaijan', language: 'az', servers: ['mac'], plan: '', first: now / 1000 - 2e7, last: now / 1000 - 5e6, messages_in: 88, messages_out: 91},
  {id: 'Telegram 700000333', masked: false, name: 'Invented: Mira', channels: ['telegram'], country: 'Turkey', language: 'tr', servers: ['prod-01'], plan: 'plus', first: now / 1000 - 4e6, last: now / 1000 - 3e5, messages_in: 34, messages_out: 40},
  {id: '+99455 •••44', masked: true, name: '', channels: ['whatsapp'], country: 'Azerbaijan', language: 'az', servers: ['client-a-01'], plan: '', first: now / 1000 - 3e6, last: now / 1000 - 1e5, messages_in: 12, messages_out: 15},
  {id: 'You', masked: false, name: '', channels: ['telegram'], country: 'Saudi Arabia', language: 'en', servers: ['mac'], plan: '', first: now / 1000 - 3e7, last: now / 1000, messages_in: 900, messages_out: 950},
];
const devToken = createDeals({db, config}).connect();
let devAcks = [];
setInterval(async () => {
  const response = await fetch(`http://127.0.0.1:${devPort}/api/client-deals/sync`, {method: 'POST', headers: {Authorization: 'Bearer ' + devToken, 'Content-Type': 'application/json'}, body: JSON.stringify({acks: devAcks})}).catch(() => null);
  const body = response?.ok ? await response.json() : null;
  devAcks = (body?.commands || []).map(c => ({id: c.id, status: 'done'}));
}, 1000).unref();
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/api/fleet/people') { res.writeHead(200, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({people: {people: devPeople}})); }
  if (req.url === '/__dev_login') {
    // A local-only cookie name works on plain HTTP; translate it before createWeb checks it.
    res.writeHead(303, {'Set-Cookie': `clients_dev=${session.value}; HttpOnly; SameSite=Strict; Path=/`, Location: '/clients'}); return res.end();
  }
  req.headers.cookie = String(req.headers.cookie || '').split(';').map(c => c.trim().startsWith('clients_dev=') ? c.trim().replace(/^clients_dev=/, COOKIE + '=') : c).join('; ');
  web(req, res);
});
server.listen(devPort, '127.0.0.1', () => console.log(`Clients ${scenario}: http://127.0.0.1:${devPort}/__dev_login`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); rmSync(data, {recursive: true, force: true}); process.exit(); }));
