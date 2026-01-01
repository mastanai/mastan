// Theme behaviour without a listening server or browser process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {renderShell, renderChat, renderLogin, renderNotFound} from '../src/web/pages.js';

const boot = readFileSync(new URL('../src/web/public/theme-boot.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/web/public/shell.js', import.meta.url), 'utf8');
function fixture(value, {blocked = false, page = 'chat', meta = true} = {}) {
  const listeners = new Map(), controls = new Map();
  const element = () => ({dataset: {}, style: {}, content: '#111514', textContent: '',
    classList: {toggle() {}, add() {}, remove() {}},
    setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
    addEventListener(k, fn) { this[k] = fn; }, focus() { document.activeElement = this; }});
  for (const name of ['.shell-theme', '.shell-sheet', '.shell-menu', '.shell-close', '.shell-scrim', '.shell-clock', '.scanline', '.topbar']) controls.set(name, element());
  const nav = element(), stat = element();
  controls.get('.topbar').querySelector = name => controls.get(name);
  controls.get('.topbar').querySelectorAll = () => [nav];
  const sheet = controls.get('.shell-sheet');
  sheet.querySelector = () => nav;
  sheet.querySelectorAll = () => [controls.get('.shell-close'), nav, stat, controls.get('.shell-theme')];
  const themeMeta = meta ? element() : null;
  const document = {documentElement: element(), body: {dataset: {page}, children: []},
    querySelector: name => name === 'meta[name="theme-color"]' ? themeMeta : controls.get(name),
    getElementById: () => null, addEventListener: (k, fn) => listeners.set(`document:${k}`, fn)};
  const storage = {getItem() { if (blocked) throw Error('blocked'); return value; },
    setItem(k, v) { if (blocked) throw Error('blocked'); assert.equal(k, 'mm-theme'); value = v; }};
  let reloads = 0, events = 0;
  const context = vm.createContext({document, localStorage: storage, Event, Intl, Date,
    location: {reload() { reloads++; }},
    matchMedia: () => ({matches: true, addEventListener() {}}),
    ResizeObserver: class { observe() {} }, setTimeout() {}, clearTimeout() {}, cancelAnimationFrame() {},
    window: {dispatchEvent(event) { assert.equal(event.type, 'mastan-theme'); events++; },
      addEventListener(k, fn) { listeners.set(k, fn); }}});
  vm.runInContext(boot, context);
  return {document, themeMeta, controls, listeners, storage, context,
    get value() { return value; }, get reloads() { return reloads; }, get events() { return events; }};
}

test('boot validates storage, ignores system preference and tolerates unavailable storage or meta', () => {
  for (const [value, expected] of [[null, 'dark'], ['auto', 'dark'], ['LIGHT', 'dark'], ['dark', 'dark'], ['light', 'light']]) {
    const f = fixture(value);
    assert.equal(f.document.documentElement.dataset.theme, expected);
    assert.equal(f.themeMeta.content, expected === 'light' ? '#eef0ec' : '#111514');
  }
  assert.equal(fixture('light', {blocked: true, meta: false}).document.documentElement.dataset.theme, 'dark');
});

test('toggle persists, updates metadata and label, dispatches the chat event and includes sheet links in focus handling', () => {
  const f = fixture('light'); vm.runInContext(shell, f.context);
  const button = f.controls.get('.shell-theme');
  assert.equal(button.textContent, 'dark');
  button.click();
  assert.equal(f.value, 'dark'); assert.equal(f.document.documentElement.dataset.theme, 'dark');
  assert.equal(button['aria-label'], 'Switch to light mode'); assert.equal(f.themeMeta.content, '#111514');
  assert.equal(f.events, 2); assert.equal(f.reloads, 0);
  f.controls.get('.shell-menu').click();
  f.document.activeElement = f.controls.get('.shell-theme');
  f.listeners.get('document:keydown')({key: 'Tab', preventDefault() {}});
  assert.equal(f.document.activeElement, f.controls.get('.shell-close'));
});

test('storage follows other tabs, removal resets dark and Atlas reloads only when the theme changes', () => {
  const f = fixture('dark', {page: 'atlas'}); vm.runInContext(shell, f.context);
  const sync = newValue => f.listeners.get('storage')({key: 'mm-theme', newValue, storageArea: f.storage});
  sync('light'); assert.equal(f.reloads, 1); assert.equal(f.controls.get('.shell-theme').textContent, 'dark');
  sync('light'); assert.equal(f.reloads, 1);
  sync(null); assert.equal(f.reloads, 2); assert.equal(f.document.documentElement.dataset.theme, 'dark');
  f.listeners.get('storage')({key: 'other', newValue: 'light', storageArea: f.storage});
  assert.equal(f.reloads, 2);
  f.listeners.get('storage')({key: 'mm-theme', newValue: 'light', storageArea: {}});
  assert.equal(f.reloads, 2);
});

test('toggle still applies with blocked storage', () => {
  const f = fixture(null, {blocked: true}); vm.runInContext(shell, f.context);
  f.controls.get('.shell-theme').click();
  assert.equal(f.document.documentElement.dataset.theme, 'light');
});

test('all page shells boot synchronously before CSS with a nonce, including operator chat and public pages', () => {
  const args = {nonce: 'fixture-nonce', csrf: 'fixture-csrf', asset: name => `/static/${name}`, path: '/questions'};
  for (const html of [renderShell(args), renderShell({...args, operator: true}), renderChat(args), renderChat({...args, operator: true}), renderLogin(args), renderNotFound(args)]) {
    const tag = '<script nonce="fixture-nonce" src="/static/theme-boot.js"></script>';
    assert.ok(html.includes(tag)); assert.ok(html.indexOf(tag) < html.indexOf('<link rel="stylesheet"'));
    assert.doesNotMatch(html, /__[A-Z0-9]+__/);
    for (const script of html.match(/<script[^>]*>/g) || []) assert.match(script, /nonce="fixture-nonce"/);
    if (html.includes('class="topbar"')) assert.match(html, /class="shell-theme"/);
  }
});

test('light text and chart tokens keep contrast on their UI surfaces', () => {
  const css = readFileSync(new URL('../src/web/public/shell.css', import.meta.url), 'utf8').split(':root[data-theme="light"]')[1].split('}')[0];
  const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/g)].map(m => [m[1], m[2]]));
  const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = hex => channels(hex).reduce((sum, channel, i) => {
    const c = channel / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const fg of ['ink', 'ink-2', 'ink-3', 'accent', 'warn', 'bad', 'info']) {
    for (const bg of ['bg', 'bg-1', 'bg-2']) assert.ok(ratio(tokens[fg], tokens[bg]) >= 4.5, `${fg}/${bg}`);
  }
  for (const state of ['accent', 'warn', 'bad', 'info']) assert.ok(ratio(tokens[state], tokens[`${state}-dim`]) >= 4.5, state);
  for (const fg of ['ink', 'ink-2', 'ink-3']) assert.ok(ratio(tokens[fg], tokens['accent-dim']) >= 4.5, `${fg}/own bubble`);
  for (const state of ['accent', 'bad']) assert.ok(ratio(tokens.bg, tokens[state]) >= 4.5, `hover ${state}`);
  const common = readFileSync(new URL('../src/web/public/common.js', import.meta.url), 'utf8');
  const palette = common.split('const LIGHT_DOMAIN_COLORS')[1].split('const domains')[0].match(/#[\da-f]{6}/g);
  for (const domain of palette) for (const bg of ['bg', 'bg-1', 'bg-2']) assert.ok(ratio(domain, tokens[bg]) >= 4.5, domain);
  for (const series of ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 'sx']) {
    const backdrop = channels(tokens['bg-1']);
    const rendered = '#' + channels(tokens[series]).map((channel, i) => Math.round(channel * 0.78 + backdrop[i] * 0.22).toString(16).padStart(2, '0')).join('');
    assert.ok(ratio(rendered, tokens['bg-1']) >= 3, `chart ${series} after opacity`);
  }
});
