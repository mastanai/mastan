// The real sign-in, sign-out, operator and approval code in a real browser, with a virtual passkey and invented data.
// Nothing is faked on the page: real webauthn.js, real CSP, real cookies. Only the gate and the agent are stand-ins,
// and the stand-in gate still verifies each assertion. Run: JURY_CHROME=<chromium> node test/auth-flows.mjs
// This is deliberately separate from npm test. Screenshots go to .jury/auth-flows.
import {mkdtempSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateAuthenticationOptions, verifyAuthenticationResponse} from '@simplewebauthn/server';

const PORT = 3199, ORIGIN = `http://localhost:${PORT}`;
process.env.MASTAN_ME_DATA = mkdtempSync(join(tmpdir(), 'mastan-me-auth-flows-'));
process.env.MASTAN_ME_HOSTNAME = `localhost:${PORT}`;
process.env.MASTAN_ME_RP_ID = 'localhost';
const {config} = await import('../src/config.js');
config.origin = ORIGIN; // WebAuthn and Secure cookies both accept http only on localhost.
const {openDb} = await import('../src/db.js');
const {createWeb} = await import('../src/web/index.js');
const {WebChat} = await import('../src/channels/web-chat.js');
const A = await import('../src/web/auth.js');
const require = createRequire(join(homedir(), '.cache/jury/package.json'));
const {chromium} = require('playwright');
const out = fileURLToPath(new URL('../.jury/auth-flows/', import.meta.url));
mkdirSync(out, {recursive: true});
mkdirSync(config.workspace, {recursive: true});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const db = openDb();

// A stand-in gate that does what the real one does: it signs nothing off without a good assertion.
let rows = [], gateChallenge = null;
const request = (server, command, reason) => ({id: A.token().replace(/[^a-f0-9]/g, '0').padEnd(32, '0').slice(0, 32), server, command, reason, state: 'pending',
  exit_code: null, output: null, kind: 'command', timeout_s: 120, created: Date.now(), expires: Date.now() + 1800000});
async function checkAssertion(response) {
  const row = db.prepare('SELECT * FROM credentials WHERE id=?').get(response?.id || '');
  if (!row) return false;
  try {
    const checked = await verifyAuthenticationResponse({response, expectedChallenge: gateChallenge, expectedOrigin: ORIGIN, expectedRPID: 'localhost', requireUserVerification: true,
      credential: {id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports)}});
    if (checked.verified) db.prepare('UPDATE credentials SET counter=? WHERE id=?').run(checked.authenticationInfo.newCounter, row.id);
    return checked.verified;
  } catch { return false; } finally { gateChallenge = null; }
}
const leases = new Set(), leaseChallenges = new Set();
let autoOn = true;
const fleetTransport = async req => {
  if (req.op === 'lease_challenge') {
    const options = await generateAuthenticationOptions({rpID: 'localhost', userVerification: 'required'});
    leaseChallenges.add(options.challenge);
    return {ok: true, ...options};
  }
  if (req.op === 'lease_open') {
    if (!leaseChallenges.delete(req.challenge) || !Buffer.from(req.assertion?.response?.clientDataJSON || '', 'base64url').toString().includes(req.challenge)) return {ok: false, error: 'Passkey refused.'};
    const lease = A.token(); leases.add(lease);
    return {ok: true, lease, expires: Date.now() + 86400_000};
  }
  if (req.op === 'lease_state') return {ok: true, on: autoOn, lease: leases.has(req.lease)};
  if (req.op === 'lease_set') {
    if (req.on && !leases.has(req.lease)) return {ok: false, error: 'passkey needed'};
    autoOn = req.on; return {ok: true, on: autoOn, lease: leases.has(req.lease)};
  }
  if (req.op === 'lease_close') { leases.delete(req.lease); return {ok: true, closed: true}; }
  if (req.op === 'auto_recent') return {ok: true, auto: rows.filter(r => r.auto)};
  if (req.op === 'people' && req.lease) {
    if (!autoOn || !leases.has(req.lease)) return {ok: false, error: 'passkey needed'};
    return {ok: true, people: {generated_at: Date.now() / 1000, people: [{id: '+10000000001', name: 'Invented Person', masked: false, country: 'Unknown', language: 'en',
      servers: ['invented-01'], channels: ['web'], plan: 'Free', first: Date.now() / 1000 - 86400, last: Date.now() / 1000, messages_in: 3, messages_out: 4}]}};
  }
  if (req.op === 'servers') return {ok: true, servers: []};
  if (req.op === 'requests') return {ok: true, requests: rows};
  if (req.op === 'pending') return {ok: true, pending: rows.filter(r => r.state === 'pending')};
  if (req.op === 'windows') return {ok: true, windows: []};
  if (req.op === 'challenge') {
    const options = await generateAuthenticationOptions({rpID: 'localhost', userVerification: 'required'});
    gateChallenge = options.challenge;
    return {ok: true, ...options};
  }
  if (req.op === 'people') {
    return {ok: true, people: {generated_at: Date.now() / 1000, people: [{id: '+10000000001', name: 'Invented Person', masked: false, country: 'Unknown', language: 'en',
      servers: ['invented-01'], channels: ['web'], plan: 'Free', first: Date.now() / 1000 - 86400, last: Date.now() / 1000, messages_in: 3, messages_out: 4}]}};
  }
  const row = rows.find(r => r.id === req.id);
  if (!row) return {ok: false, error: 'Unknown request.'};
  if (req.op === 'approve') {
    if (!await checkAssertion(req.assertion)) return {ok: false, error: 'Passkey refused.'};
    Object.assign(row, {state: 'done', exit_code: 0, output: 'invented output'});
  }
  if (req.op === 'deny') row.state = 'denied';
  return {ok: true, ...row};
};
const agent = {
  async turn({text, onDelta}) { const reply = `Answer to: ${text}`; onDelta(reply); return {text: reply, durationMs: 5, sessionId: 's', model: 'fake'}; },
  stop: () => false, newSession() {}, warm: () => false,
};
const chat = new WebChat({agent, runBusy: async () => ({text: JSON.stringify({reply: 'Queued.', queue: true})})});
const atlas = {stats: () => ({open_questions: 0, tensions: 0, positions: 0, connections: 0, dumps: 0, last_updated: null})};
const models = {load: () => ({roles: {}, options: []}), save() {}};
const web = createWeb({config, db, atlas, board: null, chat, models}, {fleetTransport});
const server = createServer((req, res) => { req.headers['x-real-ip'] = '127.0.0.1'; void web(req, res); });
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// Every check runs; a failure is reported and the next one still goes.
const results = [];
async function check(name, fn) {
  try { const note = await fn(); results.push([true, name, note]); console.log('PASS', name, note ?? ''); }
  catch (e) { results.push([false, name, e.message.split('\n')[0]]); console.log('FAIL', name, '-', e.message.split('\n').slice(0, 2).join(' ')); }
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const pathOf = page => new URL(page.url()).pathname + new URL(page.url()).search;
const loginStatus = page => page.locator('#status').textContent();

async function open(browser, options) {
  const context = await browser.newContext({colorScheme: 'dark', ...options});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === ORIGIN || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', event => window.__csp.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`${page.url()} ${e.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}});
  const verified = value => cdp.send('WebAuthn.setUserVerified', {authenticatorId, isUserVerified: value});
  return {context, page, errors, verified};
}
const cleanPage = async (page, errors, label) => {
  const csp = await page.evaluate(() => window.__csp);
  assert(!csp.length, `${label} CSP: ${csp.join(', ')}`);
  assert(!errors.length, `${label} page error: ${errors.join(', ')}`);
};
// Taps where a finger would, and fails if something else sits on top of the target.
async function tapReal(page, selector) {
  await page.waitForFunction(s => { const el = document.querySelector(s), r = el?.getBoundingClientRect(); if (!r?.width) return false;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && (top === el || el.contains(top)); }, selector, {timeout: 5000}).catch(async error => {
    const state = await page.evaluate(s => { const el = document.querySelector(s), r = el?.getBoundingClientRect(), top = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {app: document.getElementById('app').className, rect: r && [r.x, r.y, r.width, r.height], top: top && (top.id || top.className || top.tagName), url: location.pathname}; }, selector);
    throw new Error(`${selector} not tappable: ${JSON.stringify(state)} ${error.message.split('\n')[0]}`);
  });
  await sleep(400); // Let the screen slide finish.
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
}
async function signIn(page, path = '/login') {
  await page.goto('about:blank'); await page.goto(ORIGIN + path);
  await page.locator('#passkey').click();
}
async function signOutFromSettings(page) {
  await page.goto(ORIGIN + '/settings');
  await page.getByRole('button', {name: 'Sign out'}).click();
  await page.waitForURL('**/login');
}

const browser = await chromium.launch(process.env.JURY_CHROME ? {executablePath: process.env.JURY_CHROME} : {});
const phoneOptions = {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2};
try {
  await check('signed out: every page goes to /login, every API is refused', async () => {
    for (const p of ['/', '/chat', '/settings', '/fleet', '/stats', '/people', '/clients', '/questions', '/board']) {
      const r = await fetch(ORIGIN + p, {redirect: 'manual'});
      assert(r.status === 303 && r.headers.get('location') === '/login', `${p} gave ${r.status} ${r.headers.get('location')}`);
    }
    for (const p of ['/api/stats', '/api/fleet/pending', '/api/clients', '/api/chat/boot']) {
      const r = await fetch(ORIGIN + p);
      assert(r.status === 401 || r.status === 404, `${p} gave ${r.status}`); // Owner APIs answer 404 on purpose.
    }
  });

  for (const [label, options] of [['desktop', {viewport: {width: 1440, height: 900}}], ['phone', phoneOptions]]) {
    const {context, page, errors, verified} = await open(browser, options);
    const shot = name => page.screenshot({path: join(out, `${label}-${name}.png`)});
    rows = [request('prod-01', 'systemctl reload nginx', 'Pick up the new vhost'), request('invented-02', 'systemctl restart invented', 'Unit failed 12 minutes ago')];
    let token;

    await check(`${label}: login page renders with the real library and no errors`, async () => {
      await page.goto(ORIGIN + '/chat');
      assert(pathOf(page) === '/login', `landed on ${pathOf(page)}`);
      await page.locator('#passkey').waitFor();
      assert(await page.locator('#passkey').textContent() === 'Sign in with passkey', 'wrong button text');
      assert(await page.evaluate(() => !!window.SimpleWebAuthnBrowser?.startAuthentication), 'real webauthn library missing');
      await shot('01-login');
      await cleanPage(page, errors, 'login');
    });
    await check(`${label}: enrol link registers a passkey and signs in`, async () => {
      token = A.enrol(db);
      await page.goto('about:blank'); await page.goto(`${ORIGIN}/login#enrol=${token}`);
      assert(await page.locator('#passkey').textContent() === 'Set up a passkey', 'button did not switch');
      assert(!page.url().includes(token), 'token stayed in the address bar');
      await shot('02-enrol');
      await page.locator('#passkey').click();
      await page.waitForURL(ORIGIN + '/', {timeout: 8000});
      await page.locator('header.topbar').waitFor();
      const cookie = (await context.cookies()).find(c => c.name === '__Host-mastan_me');
      assert(cookie?.httpOnly && cookie.secure, 'session cookie not HttpOnly and Secure');
    });
    await check(`${label}: a used enrol link is refused`, async () => {
      await page.goto('about:blank'); await page.goto(`${ORIGIN}/login#enrol=${token}`);
      await page.locator('#passkey').click();
      await page.waitForFunction(() => document.getElementById('status').textContent);
      const status = await loginStatus(page);
      assert(/failed/i.test(status), `status: ${status}`);
      assert(!await page.locator('#passkey').isDisabled(), 'button stayed disabled');
    });
    await check(`${label}: Settings sign out ends the session`, async () => {
      await signOutFromSettings(page);
      await page.goto(ORIGIN + '/chat');
      assert(pathOf(page) === '/login', `signed-out /chat landed on ${pathOf(page)}`);
    });
    await check(`${label}: passkey sign-in works`, async () => {
      await signIn(page);
      await page.waitForURL(ORIGIN + '/', {timeout: 8000});
      await page.locator('header.topbar').waitFor();
      await signOutFromSettings(page);
    });
    await check(`${label}: passkey refused on the device shows a message and can retry`, async () => {
      await verified(false);
      await signIn(page);
      await page.waitForFunction(() => document.getElementById('status').textContent, null, {timeout: 8000});
      const status = await loginStatus(page);
      assert(/cancelled|failed/i.test(status), `status: ${status}`);
      assert(pathOf(page) === '/login', 'signed in without verification');
      assert(!await page.locator('#passkey').isDisabled(), 'button stayed disabled');
      await shot('03-refused');
      await verified(true);
    });
    await check(`${label}: email alert link returns to that email after sign-in`, async () => {
      const mail = '/chat/mail/' + 'a'.repeat(24);
      await signIn(page, `/login?next=${mail}`);
      await page.waitForURL(ORIGIN + mail, {timeout: 8000});
      await signOutFromSettings(page);
    });
    await check(`${label}: outside next target is ignored`, async () => {
      await signIn(page, '/login?next=https://example.com/');
      await page.waitForURL(ORIGIN + '/', {timeout: 8000});
    });
    await check(`${label}: chat opens signed in and a message gets a reply`, async () => {
      await page.goto(ORIGIN + '/chat');
      await page.locator('#message').waitFor({state: 'attached'});
      await page.waitForFunction(() => !document.getElementById('app').classList.contains('booting'));
      await sleep(800); // The phone can show the list for a moment while it restores the last chat.
      if (await page.evaluate(() => document.getElementById('app').classList.contains('list-screen'))) await tapReal(page, '#new-session'); // The phone can open on the session list.
      await page.waitForFunction(() => !document.getElementById('composer').inert);
      await page.locator('#message').fill('invented check message');
      await page.locator('#send').click(); // Enter makes a new line on a phone.
      await page.getByText('Answer to: invented check message').locator('visible=true').first().waitFor({timeout: 8000});
      await page.locator('header.topbar').waitFor();
      await shot('04-chat');
      await cleanPage(page, errors, 'chat');
    });
    if (label === 'desktop') {
      await check('desktop: a message sent right after load always gets a reply (15 loads)', async () => {
        for (let i = 0; i < 15; i++) {
          await page.goto(ORIGIN + '/chat');
          await page.waitForFunction(() => !document.getElementById('composer').inert);
          const text = `race check ${i}`;
          await page.locator('#message').fill(text);
          await page.keyboard.press('Enter');
          try { await page.getByText(`Answer to: ${text}`).locator('visible=true').first().waitFor({timeout: 6000}); }
          catch { await shot(`race-${i}`); throw new Error(`no reply on load ${i}, composer holds "${await page.locator('#message').inputValue()}"`); }
          await page.waitForFunction(() => document.getElementById('send') && !document.getElementById('stop')?.offsetParent, null, {timeout: 6000}).catch(() => {});
        }
      });
      await check('desktop: header links walk every page', async () => {
        await page.goto(ORIGIN + '/settings');
        const before = errors.length;
        const hrefs = await page.locator('header nav a').evaluateAll(links => links.map(a => a.getAttribute('href')));
        for (const href of hrefs) {
          await page.locator(`header nav a[href="${href}"]`).click();
          await page.waitForURL(ORIGIN + href, {timeout: 5000});
          await page.locator('header.topbar').waitFor();
        }
        assert(errors.length === before, errors.slice(before).join(', '));
        await page.goto(ORIGIN + '/chat');
        await page.waitForFunction(() => !document.getElementById('composer').inert);
      });
    }
    await check(`${label}: two approvals collapse, and the summary opens them`, async () => {
      const summary = page.locator('.approval-summary');
      await summary.waitFor({timeout: 6000});
      assert(/2 approvals waiting/.test(await summary.textContent()), await summary.textContent());
      assert(!await page.getByRole('button', {name: 'Approve with passkey'}).first().isVisible(), 'cards visible while collapsed');
      await shot('05-approvals-collapsed');
      await summary.click();
      await page.getByRole('button', {name: 'Approve with passkey'}).first().waitFor();
      assert(await page.getByRole('button', {name: 'Approve with passkey'}).count() === 2, 'expected two Approve buttons');
      await shot('06-approvals-open');
    });
    await check(`${label}: Approve refused on the device changes nothing`, async () => {
      await page.getByRole('button', {name: 'Approve with passkey'}).first().waitFor({timeout: 5000});
      await verified(false);
      await page.getByRole('button', {name: 'Approve with passkey'}).first().click();
      await sleep(1500);
      assert(rows[0].state === 'pending', `request went ${rows[0].state}`);
      await page.getByText('Passkey cancelled.').first().waitFor({timeout: 2000});
      assert(await page.getByText('w3.org').count() === 0, 'raw browser error shown');
      assert(!await page.getByRole('button', {name: 'Approve with passkey'}).first().isDisabled(), 'Approve stayed disabled');
      await verified(true);
    });
    await check(`${label}: Approve with passkey reaches the gate and shows the result`, async () => {
      await page.getByRole('button', {name: 'Approve with passkey'}).first().click();
      await page.locator('.approval[data-state="done"]').waitFor({timeout: 8000});
      assert(rows[0].state === 'done', `gate state ${rows[0].state}`);
      assert(/Done, exit 0/.test(await page.locator('.approval[data-state="done"] .approval-state').textContent()), 'no Done, exit 0');
      await shot('07-approved');
    });
    await check(`${label}: Deny reaches the gate, Close clears the card`, async () => {
      await page.locator('.approval[data-state="pending"]').getByRole('button', {name: 'Deny'}).click({timeout: 5000});
      await page.locator('.approval[data-state="denied"]').waitFor({timeout: 5000});
      assert(rows[1].state === 'denied', `gate state ${rows[1].state}`);
      await page.locator('.approval[data-state="denied"]').getByRole('button', {name: 'Close'}).click();
      assert(await page.locator('.approval[data-state="denied"]').count() === 0, 'card stayed');
      await cleanPage(page, errors, 'approvals');
    });
    await check(`${label}: sign-in opened auto-approve, the switch shows it and turns it off and on with no passkey`, async () => {
      autoOn = true;
      await page.goto(ORIGIN + '/chat');
      const toggle = page.locator('.auto-approve');
      await toggle.waitFor({timeout: 8000});
      assert(/Auto-approve: on/.test(await toggle.textContent()), await toggle.textContent());
      const cookie = (await context.cookies()).find(c => c.name === '__Host-mm_fleet_lease');
      assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict', 'lease cookie not HttpOnly, Secure and Strict');
      assert(!await page.evaluate(() => document.cookie.includes('fleet_lease')), 'lease visible to page script');
      await shot('08a-auto-on');
      await toggle.click();
      await page.getByRole('button', {name: 'Auto-approve: off'}).waitFor({timeout: 5000});
      assert(autoOn === false, 'gate still on');
      await shot('08b-auto-off');
      await toggle.click();
      await page.getByRole('button', {name: 'Auto-approve: on'}).waitFor({timeout: 5000});
      assert(autoOn === true, 'gate still off');
      autoOn = false;
    });
    await check(`${label}: an auto-approved command shows in the chat with no Approve button`, async () => {
      autoOn = true;
      const row = {...request('invented-01', 'systemctl restart invented', 'Invented auto run'), state: 'done', exit_code: 0, output: 'invented output', auto: 1};
      rows.push(row);
      await page.locator(`.approval.auto[data-state="done"]`).waitFor({timeout: 8000});
      const card = page.locator('.approval.auto');
      assert(/auto-approved/.test(await card.textContent()), 'no auto-approved tag');
      assert(/systemctl restart invented/.test(await card.textContent()), 'no command');
      assert(await card.getByRole('button', {name: 'Approve with passkey'}).count() === 0, 'auto card has Approve');
      await shot('08c-auto-card');
      await card.getByRole('button', {name: 'Close'}).click();
      rows.splice(rows.indexOf(row), 1);
      autoOn = false;
    });
    await check(`${label}: People opens with no passkey, with auto-approve on or off`, async () => {
      for (const on of [false, true]) {
        autoOn = on;
        await page.goto(ORIGIN + '/people');
        await page.getByText('Invented Person').locator('visible=true').first().waitFor({timeout: 8000});
        assert(await page.getByRole('button', {name: 'Unlock with passkey'}).count() === 0, 'still asks');
        await cleanPage(page, errors, 'people');
      }
      await shot('09-people-open');
      autoOn = false;
    });
    await check(`${label}: chat menu Log out can be reached and signs out`, async () => {
      await page.goto(ORIGIN + '/chat');
      await page.locator('#message').waitFor({state: 'attached'});
      await page.waitForFunction(() => !document.getElementById('app').classList.contains('booting'));
      await sleep(800);
      if (label === 'phone' && !await page.evaluate(() => document.getElementById('app').classList.contains('list-screen'))) await tapReal(page, '#back');
      await tapReal(page, '#settings');
      const item = page.getByText('Log out', {exact: true}).first();
      await item.waitFor({timeout: 3000});
      await shot('10-chat-menu');
      await item.click(); // Playwright refuses if the header or anything else covers it.
      await page.waitForURL('**/login', {timeout: 5000});
      await page.goto(ORIGIN + '/settings');
      assert(pathOf(page) === '/login', `signed-out /settings landed on ${pathOf(page)}`);
    });
    if (label === 'phone') await check('phone: the Menu sheet reaches Settings', async () => {
      await signIn(page);
      await page.waitForURL(ORIGIN + '/', {timeout: 8000});
      await page.locator('.shell-menu').click();
      const link = page.locator('#shell-sheet nav a[href="/settings"]');
      await link.waitFor();
      await shot('11-menu-sheet');
      await link.click();
      await page.waitForURL('**/settings');
      await page.getByRole('button', {name: 'Sign out'}).waitFor();
    });
    await context.close();
  }

  const op = await open(browser, {viewport: {width: 1440, height: 900}});
  await check('operator: one-time link signs in with the banner and no owner pages', async () => {
    const value = A.operatorLink(db);
    await op.page.goto(`${ORIGIN}/login#operator=${value}`);
    await op.page.waitForURL(ORIGIN + '/', {timeout: 8000});
    await op.page.locator('.operator-banner').waitFor();
    for (const href of ['/fleet', '/stats', '/people', '/clients']) assert(await op.page.locator(`header nav a[href="${href}"]`).count() === 0, `nav shows ${href}`);
    await op.page.screenshot({path: join(out, 'operator-01.png')});
    const cookie = (await op.context.cookies()).find(c => c.name === '__Host-mastan_me');
    for (const p of ['/fleet', '/people', '/clients', '/stats']) {
      const r = await fetch(ORIGIN + p, {redirect: 'manual', headers: {cookie: `__Host-mastan_me=${cookie.value}`}});
      assert(r.status !== 200, `operator got ${p} with ${r.status}`);
    }
    const api = await fetch(ORIGIN + '/api/fleet/pending', {headers: {cookie: `__Host-mastan_me=${cookie.value}`}});
    assert(api.status !== 200, `operator got /api/fleet/pending with ${api.status}`);
    const used = await browser.newContext();
    const again = await used.newPage();
    await again.goto(`${ORIGIN}/login#operator=${value}`);
    await again.getByText('This link is used or expired.').waitFor({timeout: 5000});
    await used.close();
  });
  await op.context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
for (const [, name, note] of failed) console.log('FAILED:', name, '-', note);
process.exit(failed.length ? 1 : 0);
