// DeepSeek per chat: the sandbox around claude (fake bwrap records its arguments), the environment the DeepSeek
// process gets, NO_KEY / NO_SANDBOX before anything starts, the per-chat pick in the runner, Telegram /model, and
// tasks refused from DeepSeek chats. Fake binaries only; nothing talks to a model, DeepSeek or Telegram.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'mm-deepseek-'));
const home = join(dir, 'home');
for (const p of [join(home, '.claude'), join(home, '.codex'), join(dir, 'run'), join(dir, 'workspace', 'projects', 'team-dashboard')]) mkdirSync(p, {recursive: true});
writeFileSync(join(home, '.claude.json'), '{}\n');

// Fake claude that records env NAMES, a few non-secret values and a hash of the token, then behaves like fake-claude.mjs.
const envFake = join(dir, 'fake-claude-env.mjs');
writeFileSync(envFake, `import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const e = process.env;
appendFileSync(e.MASTAN_ME_DATA + '/fake-claude-env.log', JSON.stringify({names: Object.keys(e).sort(), HOME: e.HOME,
  CLAUDE_CONFIG_DIR: e.CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL: e.ANTHROPIC_BASE_URL, ANTHROPIC_MODEL: e.ANTHROPIC_MODEL,
  SCRUB: e.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, token: e.ANTHROPIC_AUTH_TOKEN ? createHash('sha256').update(e.ANTHROPIC_AUTH_TOKEN).digest('hex') : null}) + '\\n');
await import(${JSON.stringify(join(process.cwd(), 'test/fixtures/fake-claude.mjs'))});
`);
const claudeBin = join(dir, 'claude');
writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${envFake}" "$@"\n`);
const bwrap = join(dir, 'bwrap');
writeFileSync(bwrap, `#!/bin/sh\n{ printf '%s\\n' "$@"; echo '=='; } >> "$MASTAN_ME_DATA/fake-bwrap.log"\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
for (const f of [claudeBin, bwrap]) chmodSync(f, 0o755);

const KEY = 'sk-test-deepseek-0123456789abcdef';
const keyFile = join(dir, 'deepseek-key');
writeFileSync(keyFile, KEY + '\n');
writeFileSync(join(dir, 'smartsheet-token'), 'tok-smartsheet-test\n');
Object.assign(process.env, {CLAUDE_BIN: claudeBin, MASTAN_ME_DATA: dir, AGENT_HOME: home, DEEPSEEK_KEY_FILE: keyFile, MASTAN_ME_BWRAP: bwrap,
  SMARTSHEET_TOKEN_FILE: join(dir, 'smartsheet-token'), MASTAN_ME_BROWSER: 'off'});
delete process.env.CREDENTIALS_DIRECTORY;
delete process.env.MASTAN_ME_DEEPSEEK_SANDBOX;

const {config} = await import('../src/config.js');
const {run, shutdownSessions} = await import('../src/providers/claude-cli.js');
const deepseekCli = await import('../src/providers/deepseek-cli.js');
const {deepseekError} = await import('../src/providers/deepseek.js');
const {Agent} = await import('../src/agent/runner.js');
const {chatCredentials, chatForToken} = await import('../src/chat-tokens.js');
const {createInternal} = await import('../src/internal.js');
const {TelegramChannel} = await import('../src/channels/telegram.js');
const {sim} = await import('../src/channels/telegram-api.js');
mkdirSync(config.workspace, {recursive: true});

const systemFile = join(dir, 'system.md');
writeFileSync(systemFile, 'You are a test.\n');
const chat = {user: 'owner', channel: 'telegram', chatId: '1'};
const lines = f => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : [];
const envLog = () => lines('fake-claude-env.log').map(l => JSON.parse(l));
const argvLog = () => lines('fake-claude-argv.log').map(l => JSON.parse(l));
const bwrapRuns = () => readFileSync(join(dir, 'fake-bwrap.log'), 'utf8').split('==\n').filter(Boolean).map(b => b.trim().split('\n'));
const sha = s => createHash('sha256').update(s).digest('hex');

test('a DeepSeek turn runs claude inside the sandbox with DeepSeek env, its own config dir and no Smartsheet', async () => {
  const result = await deepseekCli.run({sessionKey: 'telegram:ds', model: 'deepseek-v4-pro', cwd: dir, systemFile, stream: true, mcp: 'main-noorg', chat, prompt: 'hi'});
  assert.equal(result.text, 'ok: hi');
  const b = bwrapRuns().at(-1);
  for (const flag of ['--unshare-pid', '--die-with-parent']) assert.ok(b.includes(flag), flag);
  const hidden = (kind, p) => b.some((a, i) => a === p && b[i - 1] === kind);
  assert.ok(hidden('--tmpfs', join(home, '.claude')), 'Claude login hidden');
  assert.ok(hidden('--tmpfs', join(home, '.codex')), 'Codex login hidden');
  assert.ok(hidden('/dev/null', join(home, '.claude.json')), '.claude.json hidden');
  assert.ok(hidden('--tmpfs', join(dir, 'run')), 'harness run dir hidden');
  assert.ok(hidden('--tmpfs', join(config.workspace, 'projects', 'team-dashboard')), 'Work project hidden');
  assert.equal(b[b.indexOf('--') + 1], claudeBin);
  const env = envLog().at(-1);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(dir, 'deepseek', 'claude'));
  assert.equal(env.HOME, home);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(env.SCRUB, '0', 'the scrub needs a command sandbox dev-01 lacks and forces permission prompts');
  assert.equal(env.token, sha(KEY));
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!env.names.includes(name), name);
  const argv = argvLog().at(-1);
  assert.equal(argv[argv.indexOf('--model') + 1], 'deepseek-v4-pro[1m]');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  const mcp = argv[argv.indexOf('--mcp-config') + 1];
  assert.match(mcp, /deepseek\/run\/mcp-main-noorg-owner\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(mcp, 'utf8')), {mcpServers: {}}, 'no Smartsheet even with its token loaded');
  assert.ok(!argv.includes('--disallowedTools'));
  for (const f of ['fake-bwrap.log', 'fake-claude-argv.log']) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(KEY), `${f} never carries the key`);
  shutdownSessions();
});

test('Claude turns run in their own sandbox with no DeepSeek env, and switching backend replaces the resident', async () => {
  const before = bwrapRuns().length;
  const first = await run({sessionKey: 'telegram:sw', model: 'claude-opus-5-5', cwd: dir, systemFile, stream: true, mcp: 'main', chat, prompt: 'a'});
  assert.equal(bwrapRuns().length, before + 1, 'Claude runs in the main sandbox');
  const env = envLog().at(-1);
  assert.ok(!env.names.some(n => n.startsWith('ANTHROPIC_') || n === 'CLAUDE_CONFIG_DIR'), 'no DeepSeek variables');
  const second = await deepseekCli.run({sessionKey: 'telegram:sw', model: 'deepseek-flash', cwd: dir, systemFile, stream: true, mcp: 'main-noorg', chat, prompt: 'b'});
  assert.equal(second.log?.cold, 1, 'the DeepSeek turn booted its own resident');
  assert.notEqual(second.sessionId, first.sessionId);
  shutdownSessions();
});

test('no key: NO_KEY before anything starts; no sandbox: NO_SANDBOX; API errors become one plain line', async () => {
  const count = argvLog().length;
  rmSync(keyFile);
  await assert.rejects(deepseekCli.run({sessionKey: 'telegram:nk', model: 'deepseek-flash', cwd: dir, systemFile, stream: true, mcp: 'main-noorg', chat, prompt: 'x'}),
    e => e.code === 'NO_KEY' && /not stored/.test(e.message));
  writeFileSync(keyFile, KEY + '\n');
  const saved = config.bwrapBin;
  config.bwrapBin = join(dir, 'missing-bwrap');
  await assert.rejects(deepseekCli.run({model: 'deepseek-flash', cwd: dir, prompt: 'x'}), e => e.code === 'NO_SANDBOX');
  config.bwrapBin = saved;
  assert.equal(argvLog().length, count, 'no claude process started');
  assert.equal(deepseekError(new Error('API Error: 402 {"error":{"message":"Insufficient Balance"}}')).message, 'The DeepSeek balance is empty.');
  assert.equal(deepseekError(new Error('API Error: 401 authentication failed')).message, 'DeepSeek rejected the API key.');
  assert.equal(deepseekError(new Error('something odd')).message, 'something odd');
});

test('the runner: per-chat pick, new sessions on a switch, Work-carrying notes held back from DeepSeek', async () => {
  const agent = new Agent();
  assert.equal(agent.pickOf('telegram', '7').isDefault, true);
  assert.throws(() => agent.setPick('telegram', '7', 'gpt-6.1-sol'), e => e.code === 'BAD_MODEL');
  const db = agent.db;
  db.prepare("INSERT INTO bg_tasks(id,user,channel,chat_id,title,brief,status,created) VALUES(900,'owner','telegram','7','t','b','done',1)").run();
  db.prepare("INSERT INTO bg_task_notes(task_id,note) VALUES(900,'TASKNOTE from a Claude task')").run();

  const claudeTurn = await agent.turn({channel: 'telegram', chatId: '7', text: 'first'});
  assert.equal(claudeTurn.isDefault, true);
  assert.match(claudeTurn.text, /^ok: TASKNOTE/, 'a Claude turn gets the note');
  db.prepare("INSERT INTO bg_task_notes(task_id,note) VALUES(900,'TASKNOTE again')").run();

  const pick = agent.setPick('telegram', '7', 'deepseek-v4-pro');
  assert.deepEqual([pick.deepseek, pick.label, pick.isDefault], [true, 'DeepSeek V4 Pro', false]);
  assert.equal(db.prepare("SELECT count(*) n FROM chats WHERE chat_id='7'").get().n, 0, 'switching starts a new session');
  const runs = bwrapRuns().length;
  const ds = await agent.turn({channel: 'telegram', chatId: '7', text: 'second'});
  assert.equal(bwrapRuns().length, runs + 1, 'the turn ran in the sandbox');
  assert.equal(ds.label, 'DeepSeek V4 Pro');
  assert.match(ds.text, /^ok: \[/, 'the DeepSeek prompt carries no task note');
  assert.equal(db.prepare('SELECT count(*) n FROM bg_task_notes WHERE task_id=900').get().n, 1, 'the note waits for Claude');
  assert.equal(db.prepare("SELECT model FROM chats WHERE chat_id='7'").get().model, 'deepseek-v4-pro');
  const sys = readFileSync(join(dir, 'deepseek', 'run', 'system-telegram-deepseek-v4-pro.md'), 'utf8');
  assert.match(sys, /running on DeepSeek V4 Pro/);
  assert.match(sys, /cannot see images/);
  assert.doesNotMatch(sys, /mcp__smartsheet|mastan-me-task start/);

  agent.newSession('telegram', '7');
  assert.equal(agent.pickOf('telegram', '7').model, 'deepseek-v4-pro', 'the pick survives /new');
  agent.running.set(agent.key('telegram', '7'), {});
  assert.throws(() => agent.setPick('telegram', '7', null), e => e.code === 'BUSY');
  agent.running.delete(agent.key('telegram', '7'));
  assert.equal(agent.setPick('telegram', '7', null).isDefault, true);
  const back = await agent.turn({channel: 'telegram', chatId: '7', text: 'third'});
  assert.equal(back.isDefault, true);
  assert.match(back.text, /^ok: TASKNOTE again/, 'back on Claude, the held note arrives');
  shutdownSessions();
});

test('chat tokens of DeepSeek chats are refused for tasks and schedules, not for files', async () => {
  const creds = chatCredentials({...chat, deepseek: true});
  const token = creds.env.MASTAN_ME_CHAT_TOKEN;
  assert.equal(chatForToken(token).deepseek, true);
  let asked = 0;
  const internal = createInternal({config: {...config, sessionSecret: 'x'}, tasks: {request: () => { asked++; return {status: 'started'}; }},
    schedules: {request: () => { asked++; return {status: 'added'}; }}});
  const server = http.createServer(internal);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const post = path => fetch(`http://127.0.0.1:${server.address().port}${path}`, {method: 'POST', headers: {'x-chat-token': token}, body: '{}'}).then(r => r.json());
  for (const path of ['/internal/tasks', '/internal/schedules']) assert.equal((await post(path)).status, 'unavailable');
  assert.equal(asked, 0);
  assert.notEqual((await post('/internal/send-file')).status, 'unavailable', 'files still go out');
  server.close();
  creds.revoke();
});

test('Telegram /model switches this chat, shows it, refuses DeepSeek as a role, and /new keeps the pick', async () => {
  const agent = new Agent();
  const tg = new TelegramChannel({agent});
  const said = async text => { const store = {calls: []}; await sim.run(store, () => tg.command(55, text)); return store.calls.map(c => c.text).join('\n'); };
  assert.match(await said('/model'), /This chat: Opus 5\.5 \(default\)/);
  assert.match(await said('/model claude'), /already runs on Opus 5\.5/);
  assert.match(await said('/model deepseek'), /now runs on DeepSeek V4 Pro\. New session.*Work tools, background tasks and schedules are off/);
  assert.equal(agent.pickOf('telegram', 55).model, 'deepseek-v4-pro');
  assert.match(await said('/model flash'), /now runs on DeepSeek Flash/);
  assert.match(await said('/model'), /This chat: DeepSeek Flash \(set by you\)/);
  assert.match(await said('/new'), /Fresh session on DeepSeek Flash/);
  assert.match(await said('/model main deepseek-flash'), /DeepSeek is per chat/);
  assert.match(await said('/model main'), /^main: claude-opus-5-5/);
  assert.match(await said('/model nonsense'), /Unknown model nonsense/);
  assert.match(await said('/model claude'), /now runs on Opus 5\.5/);
  assert.equal(agent.pickOf('telegram', 55).isDefault, true);
});
