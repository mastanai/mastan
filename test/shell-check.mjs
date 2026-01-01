// Keep the preview running, then: node test/shell-check.mjs
// Set JURY_CHROME to use a specific Chromium binary.
// This is deliberately separate from npm test.
import assert from 'node:assert/strict';
import {checkMail} from './mail-browser.mjs';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
const require = createRequire(join(homedir(), '.cache/jury/package.json'));
const {chromium} = require('playwright');
const origin = 'http://127.0.0.1:3197';
const routes = [['atlas', '/'], ['chat', '/chat'], ['questions', '/questions'], ['board', '/board'],
  ['positions', '/positions'], ['dump', '/dump'], ['settings', '/settings'], ['fleet', '/fleet'],
  ['mail', '/mail'], ['stats', '/stats'], ['traffic', '/traffic'], ['people', '/people'], ['clients', '/clients']];
const widths = [1440, 1024, 390, 375];
const light = process.env.SHELL_THEME === 'light', suffix = light ? '-light' : '';
const shots = new URL('../.redesign/shots/', import.meta.url);
try { assert.equal((await fetch(origin)).status, 200); }
catch (cause) { throw new Error('Start node test/redesign-preview.mjs on 127.0.0.1:3197 first.', {cause}); }
const browser = await chromium.launch(process.env.JURY_CHROME ? {executablePath: process.env.JURY_CHROME} : {});
let context;
try {
  context = await browser.newContext({colorScheme: 'dark', reducedMotion: 'reduce'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  if (light) await context.addInitScript(() => { try { localStorage.setItem('mm-theme', 'light'); } catch {} });
  await context.addInitScript(() => {
    window.shellCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.shellCspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  await mkdir(shots, {recursive: true});
  for (const width of widths) {
    let expected;
    for (const [name, path] of routes) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.setViewportSize({width, height: 900});
      const response = await page.goto(origin + path, {waitUntil: 'domcontentloaded'});
      assert.equal(response.status(), 200, path);
      await page.waitForFunction(() => !document.querySelector('#main > .loading') && !document.querySelector('#app.booting'));
      await page.waitForTimeout(500);
      const box = await page.locator('.topbar').boundingBox();
      const geometry = {top: box.y, left: box.x, height: box.height};
      expected ||= geometry;
      assert.deepEqual(geometry, expected, `${path} at ${width}: header geometry`);
      assert.equal(box.height, 44, `${path}: shell height without safe-area inset`);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('#main');
        return {page: document.documentElement.scrollWidth > innerWidth, main: !!main && main.scrollWidth > main.clientWidth + 1};
      });
      assert.deepEqual(overflow, {page: false, main: false}, `${path} at ${width}: sideways overflow`);
      if (width <= 390) {
        await page.locator('.shell-menu').click();
        await page.waitForFunction(() => document.querySelector('.topbar').classList.contains('sheet-open'));
        assert.equal(await page.locator('#shell-sheet').getAttribute('aria-modal'), 'true');
        assert.equal(await page.evaluate(() => document.querySelector('#shell-sheet').contains(document.activeElement)), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.shell-menu').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('.shell-menu').evaluate(el => el === document.activeElement), true);
      }
      const scroller = page.locator(path === '/chat' ? '#timeline' : '#main');
      await scroller.evaluate(el => { el.scrollTop = 160; });
      assert.deepEqual(await page.locator('.topbar').boundingBox().then(b => ({top: b.y, left: b.x, height: b.height})), expected, `${path}: header while scrolling`);
      await scroller.evaluate(el => { el.scrollTop = 0; });
      if (path === '/chat') {
        const checkHeight = () => page.evaluate(() => {
          const shell = document.querySelector('.topbar').getBoundingClientRect(), app = document.querySelector('#app').getBoundingClientRect();
          return Math.abs(app.top - shell.bottom) < 1 && Math.abs(app.bottom - ((visualViewport?.height || innerHeight) + (visualViewport?.offsetTop || 0))) < 1;
        });
        assert.equal(await checkHeight(), true, 'Chat fills the space below the header');
        if (width <= 390) {
          await page.setViewportSize({width, height: 500});
          await page.waitForTimeout(100);
          assert.equal(await checkHeight(), true, 'Chat fits a shorter visual viewport');
          await page.setViewportSize({width, height: 900});
          await page.waitForTimeout(100);
        }
      }
      if (path === '/mail') await checkMail(page, {width, light});
      assert.deepEqual(await page.evaluate(() => window.shellCspViolations), [], `${path}: CSP violations`);
      assert.deepEqual(errors, [], `${path}: console errors`);
      await page.screenshot({path: fileURLToPath(new URL(`${name}-${width}${suffix}.png`, shots)), fullPage: true});
      console.log(`${name} ${width}: passed`);
      await page.close();
    }
  }
  // Public pages share the tokens, but intentionally have no signed-in header.
  for (const [name, path, status] of [['login', '/login', 200], ['404', '/not-a-page', 404]]) {
    const page = await context.newPage();
    await page.route('**/api/stats', route => route.fulfill({status: 401, contentType: 'application/json', body: '{}'}));
    for (const width of widths) {
      await page.setViewportSize({width, height: 900});
      assert.equal((await page.goto(origin + path)).status(), status);
      assert.equal(await page.locator('.topbar').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path: fileURLToPath(new URL(`${name}-${width}${suffix}.png`, shots))});
    }
    await page.close();
  }
} finally {
  await context?.close();
  await browser.close(); // Disconnect only. The owner's browser and tabs stay open.
}
