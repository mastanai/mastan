// Invented tokens and mocked binary availability. No browser starts, network or downloads.
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs, {mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'mm-mcp-'));
process.env.MASTAN_ME_DATA = dir;
process.env.SMARTSHEET_TOKEN_FILE = join(dir, 'token');
delete process.env.CREDENTIALS_DIRECTORY;
delete process.env.MASTAN_ME_CONNECTORS;
delete process.env.MASTAN_ME_BROWSER;
const {mcpArgs, childEnv, smartsheetOn, SMARTSHEET_DENIED, SMARTSHEET_URL, PLAYWRIGHT_BROWSERS_PATH} = await import('../src/providers/common.js');
const chat = {user: 'owner', channel: 'telegram', chatId: '999'};
const exists = fs.existsSync;
let browserInstalled = true, packageInstalled = true;
mock.method(fs, 'existsSync', path => {
  if (String(path).startsWith(PLAYWRIGHT_BROWSERS_PATH + '/')) return browserInstalled;
  if (String(path).endsWith('/@playwright/mcp/cli.js')) return packageInstalled;
  return exists(path);
});
test.beforeEach(() => {
  rmSync(join(dir, 'token'), {force: true});
  delete process.env.MASTAN_ME_BROWSER;
  delete process.env.MASTAN_ME_CONNECTORS;
  browserInstalled = true; packageInstalled = true;
});
test.after(() => { mock.restoreAll(); rmSync(dir, {recursive: true, force: true}); });
const readConfig = args => JSON.parse(readFileSync(args[2], 'utf8')).mcpServers;

test('main chats get separate private configs, profiles and output dirs, with Playwright and no Smartsheet without a token', () => {
  assert.equal(smartsheetOn(), false);
  const files = [];
  for (const user of ['owner', 'operator']) {
    const args = mcpArgs('main', {...chat, user});
    assert.deepEqual(args.slice(0, 2), ['--strict-mcp-config', '--mcp-config']);
    assert.equal(args[2], join(dir, 'run', `mcp-main-${user}.json`)); files.push(args[2]);
    assert.equal(statSync(args[2]).mode & 0o777, 0o600);
    assert.equal(args.length, 3, 'no Smartsheet deny list without its server');
    const servers = readConfig(args);
    assert.deepEqual(Object.keys(servers), ['playwright']);
    const p = servers.playwright;
    assert.equal(p.type, 'stdio'); assert.equal(p.command, process.execPath);
    assert.match(p.args[0], /node_modules\/@playwright\/mcp\/cli\.js$/);
    assert.equal(p.args[p.args.indexOf('--browser') + 1], 'chromium');
    assert.ok(p.args.includes('--headless'));
    assert.equal(p.args[p.args.indexOf('--idle-timeout') + 1], '600000');
    for (const [flag, leaf] of [['--user-data-dir', 'profile'], ['--output-dir', 'out']]) {
      const path = join(dir, 'users', user, 'browser', leaf);
      assert.equal(p.args[p.args.indexOf(flag) + 1], path);
      assert.equal(statSync(path).mode & 0o777, 0o700);
    }
    for (const flag of ['chrome', '--executable-path', '--port', '--isolated', '--sandbox', '--no-sandbox', '--allow-unrestricted-file-access']) assert.ok(!p.args.includes(flag), flag);
    assert.deepEqual(p.env, {PLAYWRIGHT_BROWSERS_PATH});
  }
  assert.notEqual(files[0], files[1]);
  const sameUser = mcpArgs('main', {...chat, channel: 'web', chatId: 'owner#invented'});
  assert.equal(sameUser[2], files[0], 'two chats of one user share the profile');
  const profile = join(dir, 'users', 'owner', 'browser', 'profile');
  chmodSync(profile, 0o755); mcpArgs('main', chat);
  assert.equal(statSync(profile).mode & 0o777, 0o700, 'existing profile permissions are private too');
});

test('a loaded token adds Smartsheet beside Playwright with the unchanged destructive-tool deny list', () => {
  writeFileSync(join(dir, 'token'), 'tok-test-123\n');
  assert.equal(smartsheetOn(), true);
  const denied = ['delete_rows', 'delete_column', 'execute_sharing_write', 'execute_automations_write'].map(t => `mcp__smartsheet__${t}`);
  assert.deepEqual(SMARTSHEET_DENIED, denied);
  for (const user of ['owner', 'operator']) {
    const args = mcpArgs('main', {...chat, user});
    assert.deepEqual(args.slice(0, 2), ['--strict-mcp-config', '--mcp-config']);
    assert.deepEqual(args.slice(3), ['--disallowedTools', denied.join(',')]);
    const servers = readConfig(args);
    assert.deepEqual(servers.smartsheet, {type: 'http', url: SMARTSHEET_URL, headers: {Authorization: 'Bearer tok-test-123'}});
    assert.ok(servers.playwright);
  }
  writeFileSync(join(dir, 'token'), 'tok-rotated\n');
  assert.equal(readConfig(mcpArgs('main', chat)).smartsheet.headers.Authorization, 'Bearer tok-rotated');
});

test('jobs, extractor and unspecified kinds get no MCP servers, even with a token and chat', () => {
  writeFileSync(join(dir, 'token'), 'tok-test-123\n');
  for (const kind of ['job', 'extractor', 'none', undefined]) {
    const args = mcpArgs(kind, chat);
    assert.deepEqual(args, ['--strict-mcp-config', '--mcp-config', join(dir, 'run', 'mcp-none.json')]);
    assert.deepEqual(readConfig(args), {});
  }
});

test('browser off rewrites main configs without Playwright and preserves Smartsheet and its deny list', () => {
  mcpArgs('main', chat);
  process.env.MASTAN_ME_BROWSER = 'off';
  assert.deepEqual(readConfig(mcpArgs('main', chat)), {});
  writeFileSync(join(dir, 'token'), 'tok-test-123\n');
  const args = mcpArgs('main', chat);
  assert.deepEqual(Object.keys(readConfig(args)), ['smartsheet']);
  assert.deepEqual(args.slice(3), ['--disallowedTools', SMARTSHEET_DENIED.join(',')]);
});

test('missing package or bundled browser omits Playwright without losing Smartsheet', () => {
  for (const missing of ['package', 'browser']) {
    packageInstalled = missing !== 'package'; browserInstalled = missing !== 'browser';
    assert.deepEqual(readConfig(mcpArgs('main', chat)), {});
    writeFileSync(join(dir, 'token'), 'tok-test-123\n');
    assert.deepEqual(Object.keys(readConfig(mcpArgs('main', chat))), ['smartsheet']);
    rmSync(join(dir, 'token'));
  }
});

test('child environment carries the root-owned browser path; main requires a known user', () => {
  assert.equal(childEnv().PLAYWRIGHT_BROWSERS_PATH, '/opt/mastan-me/runtime/ms-playwright');
  for (const c of [undefined, {user: '../owner'}, {user: 'unknown'}]) assert.throws(() => mcpArgs('main', c), /Bad chat context/);
});

test('the existing connectors switch still removes strict mode and keeps the main MCP servers', () => {
  process.env.MASTAN_ME_CONNECTORS = 'on';
  const args = mcpArgs('main', chat);
  assert.equal(args[0], '--mcp-config'); assert.equal(args.includes('--strict-mcp-config'), false);
  assert.ok(JSON.parse(readFileSync(args[1], 'utf8')).mcpServers.playwright);
});

test('explicit none keeps busy calls free of MCP servers even when connectors are enabled', () => {
  process.env.MASTAN_ME_CONNECTORS = 'on';
  writeFileSync(join(dir, 'token'), 'tok-test-123\n');
  const args = mcpArgs('none');
  assert.deepEqual(args, ['--strict-mcp-config', '--mcp-config', join(dir, 'run', 'mcp-none.json')]);
  assert.deepEqual(readConfig(args), {});
});
