// Local, invented-data design fixture. Run: node test/redesign-preview.mjs
// Empty states: PREVIEW_EMPTY=1 node test/redesign-preview.mjs
// No pending approvals: PREVIEW_APPROVALS=0 node test/redesign-preview.mjs
// Chat prompts: fail, slow, show me code, document. WebChat has no paused turn state.
// Nothing here connects to Stripe, SSH, a fleet gate, or an agent provider.
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';

const PORT = Number(process.env.PREVIEW_PORT) || 3197, ORIGIN = `http://127.0.0.1:${PORT}`;
const EMPTY = process.env.PREVIEW_EMPTY === '1';
const APPROVALS = process.env.PREVIEW_APPROVALS !== '0';
const DATA = mkdtempSync(join(tmpdir(), 'mastan-me-redesign-'));
let db;
// Also clean up on a startup error, not just a normal signal-driven shutdown.
process.once('exit', () => {
  try { db?.close(); } finally { rmSync(DATA, {recursive: true, force: true}); }
});
process.env.MASTAN_ME_DATA = DATA;
process.env.MASTAN_ME_HOSTNAME = `127.0.0.1:${PORT}`;
process.env.MASTAN_ME_PORT = String(PORT);
process.env.MASTAN_ME_RP_ID = 'localhost';
// An accidentally added fetch must fail locally instead of reaching a real service.
globalThis.fetch = async () => { throw new Error('Outbound fetch is disabled in the redesign preview.'); };

const {createFakeMail} = await import('./mail-fixture.mjs');
const mail = await createFakeMail({empty: EMPTY});
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb, COOKIE} = await import('../src/web/index.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const {DOMAINS} = await import('../src/atlas/store.js');
const {createClientsStore, TAGS} = await import('../src/clients/store.js');
const {riyadhDay, addDays} = await import('../src/clients/stripe.js');
const A = await import('../src/web/auth.js');
config.origin = ORIGIN;
config.stripeReadKeyFile = join(DATA, 'invented-stripe-key');
config.clientsCanaryKeyFile = join(DATA, 'invented-canary-key');
config.clientsCanaryKnownHosts = join(DATA, 'unused-known-hosts');
config.clientsCanaryHost = 'canary.example.invalid';
mkdirSync(config.workspace, {recursive: true});
// These are invented sentinel strings, never usable credentials.
writeFileSync(config.stripeReadKeyFile, 'rk_test_' + 'InventedRedesignFixtureOnly', {mode: 0o600});
writeFileSync(config.clientsCanaryKeyFile, 'InventedRedesignFixtureOnly', {mode: 0o600});
db = openDb();
const now = Date.now(), DAY = 86400_000, today = riyadhDay(now);
const day = n => addDays(today, n);
const iso = n => new Date(now + n * DAY).toISOString();
const phone = i => '+966555' + String(i).padStart(6, '0');

// In-memory atlas implements the same views and local edits as the real store.
const docs = {positions: [], people: [], questions: [], dumps: []};
const statements = [
  'A quiet first hour helps me make better decisions.',
  'Ship one small, useful improvement before widening the scope.',
  'Keep a six-month reserve before making speculative investments.',
  'Leave room in the week for reflection without a productivity target.',
  'Protect the evening meal as time to listen to the family.',
  'Automate repeatable work only after the manual process is understood.',
  'A good explanation should make a prediction that can be checked.',
  'Walking after lunch is easier to sustain than a complicated routine.',
  'Let a new user experience one useful result before asking for setup.',
  'Delegate reversible decisions with a clear spending limit.',
  'Write down the uncertainty before asking for more information.',
  'Reserve two afternoons for focused work, even in a busy week.',
  'Prefer a simple monthly budget over checking balances every day.',
  'Make time for curiosity even when it has no immediate application.',
  'Family travel works better with one unplanned day.',
];
const names = ['Mira Veylan', 'Sami Orven', 'Lina Tarev', 'Daren Elvi', 'Naya Solven',
  'Rami Velden', 'Elia Noren', 'Tala Mirven', 'Zain Avel', 'Sora Kendal',
  'Milan Veru', 'Hana Pelven', 'Neri Alven', 'Rina Tesven', 'Kian Orel',
  'Amira Vossan', 'Nabil Emer', 'Luma Serin', 'Yara Fenvi', 'Tomas Niven'];
const companies = ['Copper Kite Studio', 'Cloudberry Workshop', 'Paper Lantern Labs', 'Silver Fern Works',
  'Ochre Orbit Design', 'Velvet Acorn Co', 'Cobalt Meadow', 'Saffron Beacon', 'Lumen Pebble', 'Maple Comet'];
if (!EMPTY) {
  docs.positions = statements.map((statement, i) => ({id: `p-preview-${i + 1}`, statement, domain: DOMAINS[i % DOMAINS.length],
    confidence: [.94, .82, .68, .55][i % 4], status: ['active', 'active', 'needs_confirmation', 'needs_confirmation'][i % 4],
    since: day(-70 + i), last_confirmed: i % 4 < 2 ? day(-12 + i % 8) : null,
    sources: [{date: day(-25 + i), file: 'preview/invented-journal.md', quote: `I noticed this again: ${statement}`},
      {date: day(-8), file: 'preview/weekly-review.md', quote: 'Try this for a month, then review the tradeoff.'}],
    tags: ['preview', i % 2 ? 'experiment' : 'principle'], body: 'An invented position for reviewing the atlas detail panel.',
    notes: [{date: day(-2), by: 'you', text: 'Worth revisiting after the next four-week experiment.'}], links: []}));
  docs.people = Array.from({length: 25}, (_, i) => ({id: `person-preview-${i + 1}`,
    name: names[i] || ['Copper Kite Studio', 'Lantern Notes', 'Meadow Reading Circle', 'Orbit Prototype', 'Weekend Walks'][i - 20],
    kind: i < 20 ? 'person' : i === 20 ? 'org' : 'project', relationship: ['collaborator', 'friend', 'mentor', 'partner'][i % 4],
    role: ['Designer', 'Researcher', 'Studio founder', 'Product lead'][i % 4],
    context: 'Invented contact from a small creative community. We exchange ideas and review early prototypes.',
    body: 'Discussed a lightweight way to share weekly progress and make room for focused work.',
    notes: [{date: day(-3), by: 'you', text: 'Send the next prototype when the navigation is ready.'}], links: []}));
  for (const [i, p] of docs.positions.entries()) p.links = [
    {id: docs.positions[(i + 1) % 15].id, type: i % 5 === 0 ? 'tension' : 'supports'},
    {id: docs.people[i].id, type: 'about_person'},
    {id: docs.positions[(i + 7) % 15].id, type: 'depends'},
  ];
  docs.people.forEach((p, i) => { p.links = [{id: docs.positions[i % 15].id, type: 'about_person'},
    {id: docs.people[(i + 1) % 25].id, type: 'related'}]; });
  const questions = [
    'What makes a morning feel calm enough to think clearly?', 'Which weekly commitment could become a written update?',
    'What would justify using part of the reserve?', 'Which reflection practice feels useful after a difficult week?',
    'What does a good shared evening look like?', 'Where should the automation stop and ask for a decision?',
    'Which part of the onboarding should we test first?', 'What can the prototype decide without approval?',
    'Should the reading circle meet monthly?', 'Which walk is easiest to keep doing?', 'How much setup is too much?',
    'Should the prototype support a second workspace?',
  ];
  docs.questions = questions.map((text, i) => ({id: `q-preview-${i + 1}`, text,
    domain: DOMAINS[[0, 0, 2, 3, 4, 5, 8, 9, 3, 7, 8, 8][i]],
    status: i < 8 ? 'open' : i < 10 ? 'answered' : 'later', asked_at: day(-18 + i),
    why: 'This clarifies a tradeoff in the current four-week experiment.',
    ...(i >= 8 && i < 10 ? {answer: 'Keep the experiment small and review it at the end of the month.', answered_at: iso(-2)} : {})}));
  docs.dumps = [
    ['A short review of the prototype session', 'The first screen felt clear, but the setup step arrived too early. Try one useful result before asking for preferences.', 'filed'],
    ['Thoughts after the community workshop', 'We have three different ideas for the weekly review. I want a quieter version with fewer notifications and a shared summary.', 'filed'],
    ['A walking note about next month', 'Keep two afternoons free for focused work. Ask the group which written updates can replace recurring calls.', 'new'],
    ['Notes from a budget experiment', 'One monthly review was easier to maintain than checking balances daily. Keep the reserve rule visible.', 'filed'],
  ].map(([title, text, status], i) => ({id: `${day(-i - 1)}-preview-${i + 1}`, date: day(-i - 1), created: iso(-i - 1),
    source: ['web', 'telegram', 'web', 'voice'][i], status, body: `## Raw\n\n${text}`,
    summary: status === 'filed' ? `${title}. Updated two positions and added one follow-up question.` : ''}));
}
const pairs = () => {
  const seen = new Map();
  for (const p of [...docs.positions, ...docs.people]) for (const l of p.links || []) {
    const key = [p.id, l.id].sort().join('|');
    if (!seen.has(key) || l.type === 'tension') seen.set(key, {source: p.id, target: l.id, type: l.type});
  }
  return [...seen.values()];
};
const atlas = {
  get: (kind, id) => docs[kind]?.find(d => d.id === id),
  positions: () => docs.positions.filter(p => p.status !== 'superseded'),
  questions: () => docs.questions, dumps: () => docs.dumps,
  put(kind, doc) { const i = docs[kind].findIndex(d => d.id === doc.id); if (i < 0) docs[kind].push(doc); else docs[kind][i] = doc; return doc; },
  setQuestionStatus(id, status, answer) { const q = this.get('questions', id); Object.assign(q, {status}, answer === undefined ? {} : {answer, answered_at: iso(0)}); return q; },
  setPositionStatus(id, status) { const p = this.get('positions', id); Object.assign(p, {status, confidence: .95, last_confirmed: today}); return p; },
  rejectPosition(id, reason) { const p = this.setPositionStatus(id, 'superseded'); p.rejected_reason = reason; return p; },
  addNote(kind, id, note) { const p = this.get(kind, id); (p.notes ||= []).push({date: today, ...note}); return p; },
  addDump(text, source) { const d = {id: `${today}-preview-${docs.dumps.length + 1}`, body: text, source, status: 'new', date: today, created: iso(0)}; docs.dumps.unshift(d); return d; },
  renderAtlasMd() {}, commit() {},
  stats() { const links = pairs(); return {positions: this.positions().length, people: docs.people.length, connections: links.length,
    tensions: links.filter(l => l.type === 'tension').length, needs_confirmation: docs.positions.filter(p => p.status === 'needs_confirmation').length,
    open_questions: docs.questions.filter(q => q.status === 'open').length, dumps: docs.dumps.length, last_updated: EMPTY ? null : iso(-.1)}; },
  graph() { const active = this.positions(); const ids = new Set([...active, ...docs.people].map(p => p.id)); return {
    nodes: [...active.map((p, i) => ({id: p.id, kind: 'position', label: p.statement, domain: p.domain, confidence: p.confidence, status: p.status, added: iso(-70 + i)})),
      ...docs.people.map((p, i) => ({id: p.id, kind: p.kind, label: p.name, domain: 'People', relationship: p.relationship, role: p.role, added: iso(-50 + i)}))],
    links: pairs().filter(l => ids.has(l.source) && ids.has(l.target))}; },
};

const board = {
  items: EMPTY ? [] : ['Review the first-run prototype', 'Prepare a studio demo', 'Write the pricing FAQ', 'Check the backup rehearsal',
    'Confirm workshop room layout', 'Review the sample print pack', 'Plan a quiet weekend', 'Send the proposal outline',
    'Simplify the weekly status note', 'Document the onboarding experiment', 'Sketch the next dashboard', 'Archive the completed research'].map((title, i) => ({
    id: `preview-task-${i + 1}`, title, area: ['Mastan', 'Clients', 'Website', 'Mac mini', 'Work', 'Business', 'Personal'][i % 7],
    lane: ['open', 'in_progress', 'later', 'done'][i % 4], priority: ['high', 'medium', 'low'][i % 3], needs_you: i % 3 === 0,
    note: 'Invented task: the first draft is ready for a short review.', next: 'Choose one direction and share a concise update.', updated: iso(-i / 10), updated_by: 'Preview owner'})),
  snapshot() { return {items: this.items, synced_at: iso(0)}; },
  add(fields) { const p = {id: `preview-task-${this.items.length + 1}`, ...fields, updated: iso(0)}; this.items.push(p); return p; },
  update(id, patch) { const p = this.items.find(p => p.id === id); Object.assign(p, patch, {updated: new Date().toISOString()}); return p; },
  done(id) { return this.update(id, {lane: 'done'}); },
};
let modelState = {roles: {main: {provider: 'preview', model: 'preview-reasoner', effort: 'high'},
  coder: {provider: 'preview', model: 'preview-coder', effort: 'medium'}, extractor: {provider: 'preview', model: 'preview-small'}},
choices: {preview: ['preview-reasoner', 'preview-coder', 'preview-small']}, fallbacks: {main: 'preview-small'}, changed_by: 'Preview owner', changed_at: iso(-2)};
if (!EMPTY) for (const [i, job] of ['atlas-review', 'board-sync', 'usage-collector', 'weekly-summary', 'inbox-file'].entries()) {
  db.prepare('INSERT INTO job_runs(job,started,finished,status,detail) VALUES(?,?,?,?,?)').run(job, now - (i + 1) * 3600_000,
    i === 4 ? null : now - (i + 1) * 3600_000 + 3200, ['ok', 'ok', 'error', 'ok', 'running'][i],
    ['Filed three invented notes.', 'Synced 12 invented items.', 'Fixture timeout; retry scheduled.', 'Draft ready for review.', 'Processing a preview note.'][i]);
}

// Five documentation-only server addresses; no socket or SSH transport is created.
const serverNames = ['preview-aurora-01', 'preview-copper-01', 'preview-meadow-01', 'preview-lantern-01', 'preview-orbit-01'];
const servers = EMPTY ? [] : serverNames.map((name, i) => ({name, kind: i === 0 ? 'Public' : 'Client',
  client: i === 0 ? 'Preview community' : companies[i], color: i, ip: `192.0.2.${20 + i}`, spec: ['2 vCPU · 4 GB', '4 vCPU · 8 GB'][i % 2],
  since: day(-100 - i * 4), summary: ['Shared assistant and scheduled deliveries', 'Design team workspace', 'Research notes and daily briefs', 'Workshop scheduling assistant', 'Prototype and review workspace'][i],
  monthly_eur: [8.75, 16.5, 12.25, 19.8, 14.6][i], cost_basis: ['live', 'list', 'recorded', 'estimate', 'live'][i], connected: true,
  last_ok: (now - (i === 4 ? DAY * 2 : 120_000)) / 1000, last_error: i === 4 ? 'Invented collector timeout' : null,
  source_errors: i === 2 ? ['preview-cli'] : [],
  health: {services: {'preview-agent': i === 3 ? 'failed' : 'active', nginx: 'active'}, disk_total: 80e9, disk_used: (i === 2 ? 73 : 20 + i * 6) * 1e9,
    mem_total: 8e9, mem_used: (i === 1 ? 7.4 : 2 + i * .5) * 1e9}}));
const requests = EMPTY ? [] : Array.from({length: 5}, (_, i) => ({id: (i + 1).toString(16).repeat(32), server: serverNames[i],
  command: ['systemctl restart preview-agent', 'systemctl reload nginx', 'journalctl -u preview-agent -n 20', 'nginx -t', 'systemctl restart preview-worker'][i],
  reason: ['Apply the reviewed workspace update', 'Load the revised demo routing', 'Inspect the delayed delivery', 'Validate the local configuration', 'Recover the sample queue worker'][i],
  state: [APPROVALS ? 'pending' : 'done', APPROVALS ? 'pending' : 'done', 'done', 'denied', 'failed'][i], kind: 'command', timeout_s: 120,
  created: now - (i + 1) * 300_000, expires: now + 6 * 3600_000, exit_code: i < 2 || i === 3 ? null : i === 4 ? 1 : 0,
  output: i < 2 ? null : ['Preview delivery completed.', 'Owner declined this invented request.', 'Preview worker: fixture retry limit reached.'][i - 2]}));
let windows = EMPTY || !APPROVALS ? [] : [{server: serverNames[2], expires: now + 30 * 60_000}];
const usage = {generated_at: now / 1000, servers, usage: [], daily: [], invoices: EMPTY ? [] :
  Array.from({length: 6}, (_, i) => ({issued: day(-150 + i * 30), eur: 58.4 + i * 3.7, id: `preview-invoice-${i + 1}`}))};
for (let d = -29; !EMPTY && d <= 0; d++) for (const [i, s] of servers.entries()) {
  const scale = (i + 1) * (1 + ((d + 30) % 7) / 10);
  for (const [j, model] of ['preview-reasoner', 'preview-coder', 'preview-small'].entries()) {
    const input = Math.round(18000 * scale / (j + 1)), output = Math.round(2600 * scale / (j + 1));
    usage.usage.push({server: s.name, day: day(d), source: i === 0 ? 'public' : 'cli', model, requests: 12 + i + j,
      input, cached: Math.round(input * .65), cache_write: Math.round(input * .08), output, reasoning: Math.round(output * .2), cost: +(scale * .035 / (j + 1)).toFixed(4)});
  }
  usage.daily.push({server: s.name, day: day(d), public_users: i === 0 ? 25 + (d + 30) % 12 : null, recorded_cost: i === 0 ? .42 + (d + 30) % 4 * .07 : 0});
}
const fleetFile = join(DATA, 'fleet-usage.json');
writeFileSync(fleetFile, JSON.stringify(usage));
const people = EMPTY ? [] : Array.from({length: 32}, (_, i) => ({id: i % 5 === 0 ? `+966555***${String(i).padStart(3, '0')}` : phone(i),
  name: names[i % names.length], masked: i % 5 === 0, country: ['Saudi Arabia', 'United Arab Emirates', 'United Kingdom', 'Germany', 'Unknown'][i % 5],
  language: ['ar', 'en', 'en', 'de', 'fr'][i % 5], servers: [serverNames[i % 5], ...(i % 7 === 0 ? [serverNames[(i + 1) % 5]] : [])],
  channels: i % 3 === 0 ? ['web', 'whatsapp'] : ['telegram'], plan: ['Free', 'Plus', 'Pro', 'Private', 'Enterprise'][i % 5],
  first: now / 1000 - (90 + i) * 86400, last: now / 1000 - i * 1800, messages_in: 35 + i * 19, messages_out: 40 + i * 21}));
const challenge = {ok: true, challenge: 'invented-preview-challenge', rpId: 'localhost', allowCredentials: [], userVerification: 'required'};
const fleetTransport = async req => {
  if (req.op === 'servers') return {ok: true, servers: servers.map((s, i) => ({name: s.name, client: s.client, reachable: i !== 4,
    health: i === 4 ? 'No response to the last preview check' : i === 3 ? 'One sample unit needs attention' : 'All sample services healthy'}))};
  if (req.op === 'pending') return {ok: true, pending: requests.filter(r => r.state === 'pending')};
  if (req.op === 'requests') return {ok: true, requests};
  if (req.op === 'windows') return {ok: true, windows};
  if (req.op === 'close_window') { windows = windows.filter(w => w.server !== req.server); return {ok: true}; }
  if (req.op === 'challenge') return challenge;
  if (req.op === 'people') return {ok: true, people: {generated_at: now / 1000, people}};
  const row = requests.find(r => r.id === req.id);
  if (!row) return {ok: false, error: 'Unknown invented preview request.'};
  if (req.op === 'approve') Object.assign(row, {state: 'done', exit_code: 0, output: 'Preview only: command simulated successfully.'});
  if (req.op === 'deny') Object.assign(row, {state: 'denied', output: 'Denied in the local preview.'});
  if (['approve', 'deny', 'live'].includes(req.op)) return {ok: true, ...row};
  return {ok: false, error: 'Unsupported preview operation.'};
};

// Build Stripe's test-mode wire shapes from the checked-in, sanitized fixture.
const template = JSON.parse(readFileSync(new URL('./fixtures/stripe-test-mode.json', import.meta.url), 'utf8'));
const stripe = {customers: [], subscriptions: [], charges: []};
const canary = {version: 1, generated_at: iso(0), private_requests: [], billing: [], costs: []};
const clients = createClientsStore(db);
const statuses = ['active', 'active', 'active', 'active', 'past_due', 'trialing', 'paused', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'active'];
if (!EMPTY) {
  for (let i = 0; i < 12; i++) {
    const customer = {...structuredClone(template.customers[0]), id: `cus_preview_${i}`, name: names[i],
      email: `client${i + 1}@example.invalid`, phone: phone(i), created: Math.floor(now / 1000) - (45 + i) * 86400,
      delinquent: ['past_due', 'unpaid'].includes(statuses[i]), address: {country: ['SA', 'AE', 'GB'][i % 3]}};
    const plan = ['plus', 'pro', 'private', 'enterprise'][i % 4];
    const sub = {...structuredClone(template.subscriptions[0]), id: `sub_preview_${i}`, customer: customer.id, status: statuses[i],
      metadata: {mastan_user_id: `user-preview-${i}`}, created: Math.floor(now / 1000) - 3 * 86400,
      current_period_start: Math.floor(now / 1000) - 10 * 86400, current_period_end: Math.floor(now / 1000) + (i + 1) * 86400,
      cancel_at_period_end: i === 11, discount: i === 0 ? {coupon: {duration: 'once', percent_off: 50}} : i === 1 ? {coupon: {duration: 'forever', percent_off: 20}} : null};
    Object.assign(sub.items.data[0].price, {id: `price_preview_${i}`, lookup_key: plan + '_monthly', nickname: `${plan} monthly`, unit_amount: [1000, 3000, 10000, 20000][i % 4]});
    stripe.customers.push(customer); stripe.subscriptions.push(sub);
    if (['active', 'past_due'].includes(sub.status)) stripe.charges.push({...structuredClone(template.charges[0]), id: `ch_preview_${i}`, customer: customer.id,
      amount: sub.items.data[0].price.unit_amount * (i === 0 ? .5 : 1), created: sub.current_period_start + 120});
    const id = clients.save({company: companies[i % 10], tag: TAGS[i % TAGS.length], notes: 'Invented client. Interested in a small pilot before expanding to the team.',
      source: 'Preview workshop', follow_up: day(i % 4 - 3), last_contact: day(-10), llm_covered: i % 3 === 0 ? 0 : 1,
      ...(i === 2 ? {server: serverNames[1]} : i === 3 ? {server: serverNames[2]} : {})}, {stripe_customer_id: customer.id, now});
    clients.log(id, 'Invented call: sent the demo outline and agreed to review a pilot next week.', now - 9 * DAY, day(-9));
    canary.billing.push({user_id: sub.metadata.mastan_user_id, customer_id: customer.id, period_start: sub.current_period_start * 1000,
      period_end: sub.current_period_end * 1000, period_micros: (i + 1) * 750_000, payment_problem: customer.delinquent});
    for (let d = -29; d <= 0; d++) canary.costs.push({user_id: sub.metadata.mastan_user_id, day: day(d), micros: 45000 + i * 2500});
  }
  for (let i = 12; i < 18; i++) clients.save({name: names[i], email: `lead${i}@example.invalid`, phone: phone(i), company: companies[i % 10],
    tag: TAGS[i % 6], source: ['Workshop', 'Referral', 'Website'][i % 3], notes: 'Invented lead: asked for a proposal for a four-person team.',
    follow_up: day(i % 5 - 3), last_contact: day(-12)}, {now: now - i * 3600_000});
  for (let i = 0; i < 2; i++) canary.private_requests.push({user_id: `preview-private-${i}`, plan: 'private', business: companies[8 + i], people: 4 + i * 3,
    identity: 'work', language: i ? 'ar' : 'en', requested_at: now - (i + 1) * DAY, ready_at: null,
    contact: {channel: 'whatsapp', address_digits: phone(18 + i).slice(1)}});
}
const stripeTransport = async url => {
  const path = new URL(url).pathname, rows = stripe[path.split('/').at(-1)];
  if (!rows) throw new Error('Unsupported preview Stripe path.');
  return {ok: true, json: async () => ({data: rows, has_more: false})};
};

// 120 Riyadh days populate every Stats range, metric, cumulative and server switch.
function statsSlice(scale) {
  const daily = Array.from({length: 120}, (_, i) => ({date: day(i - 119), messages_in: (32 + i % 17) * scale,
    messages_out: (41 + i % 19) * scale, people_active: (12 + i % 9) * scale, new_people: (1 + i % 3) * scale,
    conversations: (8 + i % 11) * scale, scheduled_deliveries: (2 + i % 5) * scale}));
  let messages = 0, totalPeople = 0;
  const cumulative = daily.map(d => ({date: d.date, messages: messages += d.messages_in + d.messages_out, people: totalPeople += d.new_people}));
  const sum = key => daily.reduce((n, d) => n + d[key], 0);
  return {daily, cumulative, totals: {messages, messages_in: sum('messages_in'), messages_out: sum('messages_out'), people: totalPeople,
    conversations: sum('conversations'), scheduled_deliveries: sum('scheduled_deliveries'), countries: 4, languages: 4},
  weekly_people: Array.from({length: 18}, (_, i) => ({week_start: day(-119 + i * 7), people_active: (32 + i * 2) * scale, new_people: (9 + i % 4) * scale})),
  hour_of_day: Array.from({length: 24}, (_, hour) => ({hour, messages: (hour >= 8 && hour <= 21 ? 420 + hour * 20 : 65 + hour * 3) * scale})),
  countries: [{country: 'SA', name: 'Saudi Arabia', people: 145 * scale}, {country: 'AE', name: 'United Arab Emirates', people: 70 * scale},
    {country: 'GB', name: 'United Kingdom', people: 49 * scale}, {country: 'unknown', name: 'Unknown', people: 8 * scale}],
  channels: [{channel: 'whatsapp', messages: Math.round(messages * .6), people: 145 * scale}, {channel: 'telegram', messages: Math.round(messages * .25), people: 90 * scale},
    {channel: 'web', messages: messages - Math.round(messages * .6) - Math.round(messages * .25), people: 62 * scale}]};
}
const statsFile = join(DATA, 'stats.json');
writeFileSync(statsFile, JSON.stringify(EMPTY ? {available: false} : {...statsSlice(15), generated_at: iso(0), checked_at: iso(0),
  period: {start: day(-119), end: today}, servers: Object.fromEntries(serverNames.map((s, i) => [s, statsSlice(i + 1)])),
  languages: [{name: 'Arabic', share: 52}, {name: 'English', share: 35}, {name: 'German', share: 9}, {name: 'French', share: 4}],
  languages_note: 'Invented language shares for the preview period.', coverage: [{from: day(-119), to: today, note: 'Synthetic counts only; all five preview servers included.'}],
  definitions: {messages: 'Incoming and outgoing messages in the invented fixture.', people: 'Distinct invented identities.', conversations: 'Groups of messages separated by a quiet period.', scheduled_deliveries: 'Invented scheduled summaries.'}}));

const trafficFile = join(DATA, 'traffic.json');
const trafficPages = ['/', '/pricing/', '/exclusive/', '/notes/', '/notes/179-people/', '/use/', '/about/'];
const trafficFrom = [['Direct', '(direct)'], ['Search', 'google.com'], ['Social', 'linkedin.com'], ['Social', 'instagram.com'], ['Messaging', 'whatsapp.com'], ['AI', 'chatgpt.com'], ['Referral', 'labai.online'], ['Campaign', 'newsletter']];
const trafficPlaces = [['SA', 'Riyadh'], ['AZ', 'Baku'], ['US', 'Ashburn'], ['DE', 'Berlin'], ['SA', 'Jeddah'], ['GB', 'London']];
writeFileSync(trafficFile, JSON.stringify(EMPTY ? {available: false} : {available: true, generated_at: Math.round(now / 1000) - 120, gaps: [[day(-60), day(-50)]], tracked_since: Math.round(now / 1000) - 45 * 86400, visits: Array.from({length: 900}, (_, i) => {
  const t = Math.round(now / 1000) - Math.round((900 - i) * 9600 + (i * 7919) % 5000), depth = i % 4 === 0 ? 1 : 1 + i % 3, [channel, source] = trafficFrom[i % 8], [country, city] = trafficPlaces[i % 6];
  const pages = Array.from({length: depth}, (_, n) => ({p: trafficPages[(i + n * 2) % 7], title: 'Invented page', s: i % 5 === 0 && n === depth - 1 ? null : 8 + (i * (n + 3)) % 140, d: i % 5 === 0 ? null : 20 + (i * 13) % 81}));
  const clicks = i % 3 ? [] : [{p: pages[0].p, k: ['whatsapp', 'telegram', 'chat', 'link', 'outbound'][i % 5], l: ['Start on WhatsApp', 'Start on Telegram', 'Try it now', 'See pricing', 'Trustpilot <b>reviews</b>'][i % 5], to: ['wa.me', 't.me', 'my.example.com', '/pricing/', 'trustpilot.com'][i % 5]}];
  return {visitor: 1 + i % 620, t, country, region: '', city, device: ['mobile', 'desktop', 'laptop', 'tablet'][i % 4], browser: ['chrome', 'ios', 'safari', 'edge'][i % 4], os: ['iOS', 'Windows 10', 'Mac OS', 'Android OS'][i % 4], language: ['en-US', 'ar-SA', 'az-AZ', 'de-DE'][i % 4], screen: ['390x844', '1920x1080'][i % 2], channel, source, campaign: i % 8 === 7 ? 'launch' : '', seconds: pages.some(p => p.s !== null) ? pages.reduce((a, p) => a + (p.s || 0), 0) : null, forms: 0, clicks, pages};
})}));
// Real export instead of the invented visits: PREVIEW_TRAFFIC=/path/traffic.json node test/redesign-preview.mjs
if (process.env.PREVIEW_TRAFFIC) writeFileSync(trafficFile, readFileSync(process.env.PREVIEW_TRAFFIC));

const running = new Map();
const agent = {
  async turn({chatId, text, onDelta, onTool}) {
    const state = {stopped: false}; running.set(chatId, state);
    const slow = /slow/i.test(text), document = /document/i.test(text);
    const reply = /show me code/i.test(text)
      ? 'Here is a small, invented pilot record:\n\n```js\nconst pilot = {\n  studio: "Copper Kite",\n  participants: 4,\n  weeks: 4,\n  ready: true\n};\nconsole.log(pilot);\n```\n\n| Checkpoint | Owner | Evidence |\n| --- | --- | --- |\n| First useful result | Mira | Four observed tasks |\n| Handoff | Sami | One clear next action |\n| Review | Lina | A short weekly note |'
      : document ? 'I prepared the **pilot brief** with a scope, review date, and a short checklist.\n\nEverything in the attached PDF is invented for this design review.'
        : '**The preview workspace is ready.**\n\nAll of these results are invented for design review.\n\n1. Review the prototype with Copper Kite Studio.\n2. Keep the pilot to one useful workflow.\n3. Revisit the open questions at the weekly review.\n\n```js\nconst nextStep = { scope: "small pilot", review: "Friday" };\n```\n\nFleet approvals are simulated. Approving them only updates this temporary fixture.';
    const started = Date.now();
    try {
      onTool('Bash', {command: 'preview inspect workspace'});
      if (/fail/i.test(text)) {
        await new Promise(r => setTimeout(r, 200));
        throw new Error('Invented preview failure');
      }
      const chunks = slow ? 30 : Math.ceil(reply.length / 18);
      for (let i = 1; i <= chunks; i++) {
        await new Promise(r => setTimeout(r, slow ? 200 : 35));
        if (state.stopped) throw Object.assign(new Error('Stopped'), {code: 'ABORTED'});
        onDelta(reply.slice(0, Math.ceil(reply.length * i / chunks)));
      }
      if (document) chat.attachArtifact(chatId.split('#')[0], chatId, storePreviewPdf(chatId));
      return {text: reply, durationMs: Date.now() - started, sessionId: 'invented-preview-session', model: 'preview-reasoner'};
    } finally { running.delete(chatId); }
  },
  stop(channel, chatId) { const state = running.get(chatId); if (state) state.stopped = true; return !!state; },
  newSession() {}, warm: () => false,
};
const chat = new WebChat({agent, runBusy: async () => ({text: JSON.stringify({reply: 'Queued for the preview agent.', queue: true})})});

// Generate a visible PNG attachment with built-in zlib (no image dependency).
function previewPng() {
  const crc32 = bytes => { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, bytes) => { const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes]))); return Buffer.concat([length, name, bytes, crc]); };
  const w = 480, h = 270, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const card = y > 55 && y < 215 && x > 35 && x < 445, bar = card && y > 92 && y < 110 && x < 300;
    const color = bar ? [102, 190, 171] : card ? [50, 65, 89] : [22 + Math.floor(x / 40), 28 + Math.floor(y / 30), 48];
    raw.set(color, y * (w * 3 + 1) + 1 + x * 3);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A small valid, one-page PDF artifact, including its cross-reference table.
function previewPdf() {
  const content = 'BT /F1 22 Tf 50 750 Td (Preview pilot brief) Tj 0 -40 Td /F1 12 Tf (Invented: Copper Kite Studio - one workflow, four weeks.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
let artifactSerial = 0;
function storePreviewPdf(chatId) {
  const pdf = previewPdf(), id = `preview-pilot-brief-${++artifactSerial}`, path = join(DATA, `${id}.pdf`);
  const artifact = {id, name: 'Preview pilot brief.pdf', mime: 'application/pdf', size: pdf.length, caption: 'A four-week pilot brief using invented data.'};
  writeFileSync(path, pdf);
  db.prepare('INSERT INTO artifacts(id,user,channel,chat_id,name,mime,size,sha256,stored_path,caption,created,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, chatId.split('#')[0], 'web', chatId, artifact.name, artifact.mime, pdf.length, createHash('sha256').update(pdf).digest('hex'), path, artifact.caption, Date.now(), 'done');
  return artifact;
}
if (!EMPTY) {
  const threads = ['General', 'A little space', 'Copper Kite pilot', 'Product notebook', 'Weekly review', 'Workshop planning', 'Archived research'].map(title => chat.createThread('owner', title));
  const insert = db.prepare("INSERT INTO web_messages(who,thread,role,text,files,status,created,finished) VALUES('owner',?,?,?,?, 'done',?,?)");
  const message = (thread, role, text, files = [], age = 0) => insert.run(thread, role, text, JSON.stringify(files), now - age, now - age);
  const general = threads[0].id;
  for (let i = 0; i < 34; i++) {
    message(general, 'user', ['What should we learn from this week’s prototype?', 'Can you make the next step smaller?', 'Which assumptions should the pilot test?', 'How do we keep the review useful?'][i % 4], [], (80 - i * 2) * 60_000);
    message(general, 'assistant', [
      '**Start with the handoff.** The studio needs to know who owns the next action.\n\n- Name the owner.\n- Set one review date.\n- Keep a short record of what changed.',
      '### A smaller experiment\n\nAsk four invented participants to finish one task. Record where they hesitate, then change just that step.\n\n> A useful result should arrive before a long setup form.',
      'Use a small record for each decision:\n\n```js\nconst decision = {\n  owner: "Mira Veylan",\n  next: "Review the first useful result",\n  reversible: true\n};\n```\n\nThe fixture agent can stream another reply when you send a message.',
      'The pilot has **three checkpoints**:\n\n1. First useful result\n2. A clear handoff\n3. A review after four weeks\n\n| Question | Evidence |\n| --- | --- |\n| Is it understandable? | Observe the first task |\n| Is it useful? | Ask what they would repeat |',
    ][i % 4], [], (79 - i * 2) * 60_000);
  }
  message(general, 'system', 'New session. The invented atlas and preview memory are still here.', [], 8 * 60_000);
  const [image] = chat.saveFiles('owner', [{name: 'pilot-sketch.png', type: 'image/png', data: previewPng()}]);
  message(general, 'user', 'Here is the first sketch for the Copper Kite pilot. Does the hierarchy make sense?', [{name: image.name, mime: image.mime, size: image.size, rel: image.rel}], 7 * 60_000);
  message(general, 'assistant', '**Yes: lead with the useful result.** Keep the summary visible and put the supporting detail one step deeper. The image is an invented attachment.', [], 6 * 60_000);
  const {id: artifact, name, mime, size} = storePreviewPdf(`owner#${general}`);
  message(general, 'assistant', 'I prepared the **pilot brief** with a scope, review date, and a short checklist.\n\nEverything in the attached PDF is invented for this design review.',
    [{artifact, name, mime, size}], 5 * 60_000);
  const space = threads[1].id;
  const prompts = ['A small note from the workshop.', 'What would make this handoff clearer?', 'Keep one quiet hour for the prototype review.',
    'Can we turn this into a checklist?', 'The sample pack arrived. The paper feels warmer than the first batch.', 'Let us leave an afternoon open for reading and a walk.'];
  const replies = ['Yes. Pick one useful next step and give it an owner.',
    'The invented studio notes suggest three checks:\n\n- Read the first instruction aloud\n- Watch someone try the task\n- Record the moment they hesitate',
    '**A little space helps.**\n\nLeave enough room between decisions to notice what changed. The goal for this review is a clear next step, with time to revise it after the first observation.',
    '### Review note\n\nThe team tried a smaller handoff and finished the draft before lunch.\n\n> Keep the evidence close to the decision.\n\nNext week, compare the two approaches and ask which one people would repeat.'];
  const wideTable = '| Studio | Research question | First observation | Prototype direction | Review owner | Participants | Next checkpoint | Notes |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| Copper Kite | Can a visitor find the first useful action? | Four readers paused at the setup instructions | A shorter introduction with a visible example | Mira Veylan | Four invented participants | Friday afternoon | Keep room for a second attempt |\n| Cloudberry | Is the handoff clear after the first task? | Two readers asked who should reply | A named owner and a single review date | Sami Orven | Six invented participants | Monday morning | Review the full sequence together |';
  for (let i = 0; i < 2000; i++) {
    const role = i % 2 ? 'assistant' : 'user', n = Math.floor(i / 2);
    let text = role === 'user' ? prompts[n % prompts.length] : replies[n % replies.length];
    text += `\n\n${role === 'user' ? 'Notebook' : 'Review'} ${n + 1}. ${['A first draft is enough for today.', 'We can check this after the next workshop.', 'Keep the result small and easy to revisit.'][n % 3]}`;
    if (i % 37 === 0) text += '\n\n' + statements.slice(0, 2 + n % 8).join('\n\n');
    if (i === 1992) text = 'لنترك مساحة صغيرة للتفكير اليوم. يمكننا مراجعة الخطوة التالية بهدوء بعد الغداء.';
    if (i === 1995) text = 'Here is the full invented workshop comparison:\n\n' + wideTable;
    const files = i === 1996 ? [{name: image.name, mime: image.mime, size: image.size, rel: image.rel}] : [];
    if (files.length) text = 'A sketch from the invented workshop notebook.';
    message(space, role, text, files, (2200 - i) * 60_000);
  }
  db.prepare('UPDATE web_threads SET updated=? WHERE id=?').run(now - 200 * 60_000, space);
  for (const [i, t] of threads.slice(2).entries()) {
    message(t.id, 'user', `What is next for ${t.title.toLowerCase()}?`, [], (i + 2) * 3600_000);
    message(t.id, 'assistant', `The invented ${t.title.toLowerCase()} notes are ready.\n\n- Review the draft\n- Confirm a small next step\n- Share an update with the group`, [], (i + 2) * 3600_000 - 10_000);
    db.prepare('UPDATE web_threads SET updated=? WHERE id=?').run(now - (i + 2) * 3600_000, t.id);
  }
  chat.archiveThread('owner', threads.at(-1).id, true);
  // General is the initial session, with older history available through pagination.
  db.prepare('UPDATE web_threads SET updated=?,pinned=1 WHERE id=?').run(now, general);
}

A.addCredential(db, {id: 'invented-redesign-owner', publicKey: new Uint8Array(32).fill(7), origin: 'local'});
let session = A.createSession(db, 'invented-redesign-owner');
const web = createWeb({mail, config, db, atlas, board, chat, fleetUsageFile: fleetFile, statsFile, trafficFile,
  models: {load: () => structuredClone(modelState), save: (value, by) => { modelState = {...value, changed_by: by, changed_at: new Date().toISOString()}; }}},
{fleetTransport, stripeTransport, canaryFetch: async () => JSON.stringify({...canary, generated_at: new Date().toISOString()})});

// Keep the production pages/APIs intact. Only the local wrapper substitutes the
// browser passkey helper for the fake gate.
const passkeyShim = 'window.PublicKeyCredential ||= class {}; window.SimpleWebAuthnBrowser = {startAuthentication: async () => ({id: "invented-preview-assertion"})};';
const server = createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname !== '/login' && url.searchParams.get('signedout') !== '1') {
    if (!A.findSession(db, session.value)) session = A.createSession(db, 'invented-redesign-owner');
    req.headers.cookie = `${COOKIE}=${session.value}`;
  } else delete req.headers.cookie;
  req.headers['x-real-ip'] = '127.0.0.1';
  // The shared chat client links artifacts at /api/artifacts; this app's real
  // artifact handler lives under /api/chat/out. Bridge that URL only in preview.
  if (url.pathname.startsWith('/api/artifacts/')) req.url = req.url.replace('/api/artifacts/', '/api/chat/out/');
  // This asset is fixture-only; all data still comes through real /api/*.
  if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/static/webauthn.js') {
    const body = passkeyShim;
    res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  void web(req, res);
});
server.on('error', error => { console.error(`Preview failed: ${error.code || error.name}`); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', () => console.log(`${ORIGIN} (${EMPTY ? 'empty' : 'invented data'} preview; Ctrl-C cleans up)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  for (const state of running.values()) state.stopped = true;
  server.close(() => process.exit(0));
  server.closeAllConnections(); // Close SSE streams too, so cleanup never waits for an open tab.
});
