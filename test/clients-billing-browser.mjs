// Clicks a connected client in a real browser, in every billing state, then sends a plan. Invented data only.
// Run: node test/clients-billing-browser.mjs
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const port = 3198, origin = 'http://127.0.0.1:' + port, NAME = 'Sample client: Abdul';
const browser = await chromium.launch({executablePath: process.env.CHROME || undefined});
const server = spawn(process.execPath, [fileURLToPath(new URL('./clients-dev-server.mjs', import.meta.url))], {env: {...process.env, CLIENTS_DEV_SCENARIO: 'test', CLIENTS_DEV_PORT: String(port)}, stdio: ['ignore', 'pipe', 'ignore']});
await new Promise((resolve, reject) => { server.stdout.on('data', d => String(d).includes('Clients test') && resolve()); server.once('exit', reject); });
try {
  const page = await (await browser.newContext({viewport: {width: 1400, height: 1000}})).newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(origin + '/__dev_login');
  const row = page.getByRole('button', {name: NAME, exact: true});
  const tableRow = () => page.locator('tr', {has: row});
  await row.waitFor();
  let state = null;
  await page.route('**/api/clients*', async route => {
    if (!state || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(), body = await response.json();
    for (const p of body.people) if (p.name === NAME) Object.assign(p.billing, {state, amount: 30, pay_by: Date.now() + 3600e3, period_end: Date.now() + 86400e3, retire_at: Date.now() + 86400e3, hold_until: Date.now() + 3600e3, waiting: ['payment_request']});
    return route.fulfill({response, json: body});
  });
  for (state of ['none', 'requested', 'awaiting', 'active', 'past_due', 'paused', 'free', 'retired', 'stopped']) {
    await page.getByRole('button', {name: 'Refresh'}).click();
    await page.waitForTimeout(300);
    await row.click();
    const dialog = page.getByRole('dialog', {name: NAME});
    await dialog.getByRole('heading', {name: 'Monthly plan'}).waitFor({timeout: 3000});
    assert.match(await dialog.locator('.cl-billing').innerText(), /seen 2 min ago/, state);
    assert.equal(await dialog.getByRole('heading', {name: 'Deal'}).count(), 0, 'no public deal form on a server client');
    assert.equal(await dialog.getByRole('button', {name: 'Apply'}).count(), 0);
    const y = async l => (await l.boundingBox()).y;
    assert.ok(await y(dialog.getByRole('heading', {name: 'Monthly plan'})) < await y(dialog.getByText('LLM coverage')), 'Monthly plan comes first');
    assert.equal(await tableRow().locator('.cl-plan .cl-desktop').innerText(), 'Private', state);
    if (state === 'active') assert.match(await tableRow().locator('.cl-amount').innerText(), /\$30\s*\/ month/);
    if (state === 'awaiting') assert.match(await tableRow().locator('.cl-status').innerText(), /Asked to pay/i);
    if (state === 'stopped') assert.doesNotMatch(await tableRow().locator('.cl-amount').innerText(), /\$30/);
    await dialog.getByRole('button', {name: 'Close'}).first().click();
    console.log('opens:', state);
  }
  state = null;
  await page.getByRole('button', {name: 'Refresh'}).click();
  await page.waitForTimeout(300);
  await row.click();
  const dialog = page.getByRole('dialog', {name: NAME});
  await dialog.getByLabel('Monthly amount in US dollars').fill('30');
  if (process.env.SHOT) await page.screenshot({path: process.env.SHOT});
  await dialog.locator('.cl-billing').getByRole('button', {name: 'Send', exact: true}).click();
  await page.getByText('Request sent to the server').waitFor({timeout: 3000});
  await page.waitForTimeout(300);
  await row.click();
  const after = await page.getByRole('dialog', {name: NAME}).locator('.cl-billing').innerText();
  assert.match(after, /\$30 \/ month/);
  assert.match(after, /payment_request/);
  console.log('send: request queued for $30');
  await page.getByRole('dialog', {name: NAME}).getByRole('button', {name: 'Close'}).first().click();
  assert.match(await tableRow().locator('.cl-amount').innerText(), /\$30/);
  assert.match(await tableRow().locator('.cl-status').innerText(), /Request sent/i);
  await page.getByRole('combobox', {name: 'Plan', exact: true}).selectOption('Private');
  await row.waitFor({timeout: 3000});
  await page.getByRole('combobox', {name: 'Plan', exact: true}).selectOption('');
  // Public clients keep their Deal form and get no Monthly plan.
  const lead = 'Sample lead: Ali';
  await page.getByRole('button', {name: lead, exact: true}).click();
  const leadDialog = page.getByRole('dialog', {name: lead});
  await leadDialog.getByRole('heading', {name: 'Deal'}).waitFor({timeout: 3000});
  assert.equal(await leadDialog.getByRole('heading', {name: 'Monthly plan'}).count(), 0);
  await leadDialog.getByRole('button', {name: 'Close'}).first().click();
  console.log('public client: unchanged');
  assert.deepEqual(errors, []);
  console.log('ok');
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1;
} finally { await browser.close(); server.kill('SIGKILL'); process.exit(); }
