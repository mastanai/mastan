// Resident Claude processes: warm boots one ahead, a turn reuses it (not cold), a spec change replaces it,
// drop kills it. The binary is test/fixtures/fake-claude.mjs behind a shell wrapper; no model is involved.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, chmodSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'mm-provider-'));
const bin = join(dir, 'claude');
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(process.cwd(), 'test/fixtures/fake-claude.mjs')}" "$@"\n`);
chmodSync(bin, 0o755);
const systemFile = join(dir, 'system.md');
writeFileSync(systemFile, 'You are a test.\n');
process.env.CLAUDE_BIN = bin;
process.env.MASTAN_ME_DATA = dir;
process.env.AGENT_HOME = dir;
process.env.SMARTSHEET_TOKEN_FILE = join(dir, 'smartsheet-token'); // absent until the last test
delete process.env.CREDENTIALS_DIRECTORY;
const {run, warm, dropSession, shutdownSessions, residentCount} = await import('../src/providers/claude-cli.js');
const {SMARTSHEET_DENIED} = await import('../src/providers/common.js');

const base = {sessionKey: 'telegram:1', model: 'fake-model', effort: 'high', cwd: dir, systemFile, stream: true,
  chat: {user: 'owner', channel: 'telegram', chatId: '1'}};
const turn = async (extra = {}) => {
  const events = [];
  const result = await run({...base, prompt: 'hello there', onEvent: ev => events.push(ev), ...extra});
  return {result, events};
};

test('warm boots the resident ahead and the first turn is not cold', async () => {
  assert.equal(residentCount(), 0);
  assert.deepEqual(warm(base), {warmed: true});
  assert.equal(residentCount(), 1);
  assert.deepEqual(warm(base), {warmed: false}, 'a second warm is a no-op');
  const {result, events} = await turn();
  assert.equal(result.text, 'ok: hello there');
  assert.equal(result.log, undefined, 'the warmed resident was reused, so the turn is not logged cold');
  assert.ok(events.some(e => e.kind === 'delta' && e.text.startsWith('ok: ')), 'text streamed');
  assert.match(result.sessionId, /^fake-\d+$/);
  assert.equal(residentCount(), 1);
});

test('a turn resumed with the same session reuses the resident; a model change replaces it', async () => {
  const first = await turn();
  const second = await turn({resume: first.result.sessionId});
  assert.equal(second.result.log, undefined, 'same session id: reused');
  assert.equal(second.result.sessionId, first.result.sessionId);
  const third = await turn({model: 'other-model'});
  assert.equal(third.result.log?.cold, 1, 'a different model boots a new resident');
  assert.equal(residentCount(), 1, 'the old one was replaced, not kept');
});

test('warm never replaces a resident mid-turn, and drop kills it', async () => {
  const pending = turn({model: 'other-model'});
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(warm({...base, model: 'yet-another'}), {warmed: false});
  await pending;
  dropSession(base.sessionKey);
  assert.equal(residentCount(), 0);
  shutdownSessions();
});

test('mcp: main is part of the spec; with a Smartsheet token it adds the server and the deny list to the command line', async () => {
  writeFileSync(join(dir, 'smartsheet-token'), 'tok-provider-test\n');
  const first = await turn({mcp: 'main'});
  assert.equal(first.result.log?.cold, 1, 'a different mcp kind boots a new resident');
  const lines = readFileSync(join(dir, 'fake-claude-argv.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const argv = lines.at(-1), before = lines.at(-2);
  assert.match(argv[argv.indexOf('--mcp-config') + 1], /mcp-main-owner\.json$/);
  assert.equal(argv[argv.indexOf('--disallowedTools') + 1], SMARTSHEET_DENIED.join(','));
  assert.match(before[before.indexOf('--mcp-config') + 1], /mcp-none\.json$/, 'earlier residents ran without servers');
  assert.equal(before.includes('--disallowedTools'), false);
  const again = await turn({mcp: 'main', resume: first.result.sessionId});
  assert.equal(again.result.log, undefined, 'same spec: reused');
  shutdownSessions();
});

test('changing only the user replaces the resident and selects that user\'s MCP config', async () => {
  const chat = {...base.chat};
  const first = await turn({mcp: 'main', chat});
  chat.user = 'operator';
  const second = await turn({mcp: 'main', resume: first.result.sessionId, chat});
  assert.equal(second.result.log?.cold, 1, 'a different user boots a new resident');
  assert.equal(residentCount(), 1);
  const lines = readFileSync(join(dir, 'fake-claude-argv.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const argv = lines.at(-1);
  assert.match(argv[argv.indexOf('--mcp-config') + 1], /mcp-main-operator\.json$/);
  const again = await turn({mcp: 'main', resume: second.result.sessionId, chat: {...base.chat, user: 'operator'}});
  assert.equal(again.result.log, undefined, 'same user and spec reuse the resident');
  shutdownSessions();
});

test('main agent sandbox hides the service secrets and has its own pid namespace', async () => {
  const {mainLaunch, mainHidden} = await import('../src/providers/main-sandbox.js');
  const {config} = await import('../src/config.js');
  assert.ok(mainHidden().includes('/etc/mastan-me/env'));
  assert.ok(mainHidden().includes('/run/credentials'));
  assert.ok(!mainHidden().includes('/run/mastan-fleet.sock'), 'the agent still reaches the gate');
  const previous = config.bwrapBin;
  config.bwrapBin = process.execPath; // any file that exists
  const out = mainLaunch(['-p'], {A: '1'});
  config.bwrapBin = previous;
  assert.equal(out.cmd, process.execPath);
  assert.ok(out.args.includes('--unshare-pid'));
  assert.deepEqual(out.args.slice(-3), ['--', config.claudeBin, '-p']);
  process.env.MASTAN_ME_MAIN_SANDBOX = 'off';
  assert.equal(mainLaunch(['-p'], {}).cmd, config.claudeBin);
  delete process.env.MASTAN_ME_MAIN_SANDBOX;
});

test('a one-shot call with tools: [] runs with no tools at all, and a plain call keeps the default set', async () => {
  const log = join(dir, 'fake-claude-argv.log');
  const before = readFileSync(log, 'utf8').trim().split('\n').length;
  // The fake only speaks stream-json, so a one-shot call fails after it logs its arguments. The arguments are what count.
  await assert.rejects(run({model: 'fake-model', prompt: 'untrusted', cwd: dir, mcp: 'none', tools: [], timeoutMs: 5000}));
  await assert.rejects(run({model: 'fake-model', prompt: 'trusted', cwd: dir, mcp: 'none', timeoutMs: 5000}));
  const [noTools, plain] = readFileSync(log, 'utf8').trim().split('\n').slice(before).map(l => JSON.parse(l));
  const at = noTools.indexOf('--tools');
  assert.ok(at > 0, 'tools flag present');
  assert.equal(noTools[at + 1], '', 'an empty list: no tools');
  assert.ok(noTools.includes('--strict-mcp-config'));
  assert.ok(!plain.includes('--tools'));
});
