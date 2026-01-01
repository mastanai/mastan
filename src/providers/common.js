import fs, {appendFileSync, mkdirSync, chmodSync, writeFileSync, readFileSync, renameSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {createRequire} from 'node:module';
import {config} from '../config.js';

const require = createRequire(import.meta.url);
export const PLAYWRIGHT_BROWSERS_PATH = '/opt/mastan-me/runtime/ms-playwright';

// Child processes get a clean environment: no service secrets (session secret, bot or board tokens).
// Update checks, telemetry and plugin sync are off: measured 26 Oct, they cost 2 to 3 s of boot
// and about 15k tokens of context on every Claude call.
export function childEnv(extra = {}) {
  extra = Object.fromEntries(Object.entries(extra).filter(([key]) => !/INTERNAL.*TOKEN/i.test(key)));
  return {
    HOME: config.agentHome,
    USER: 'mastan',
    PATH: '/opt/mastan-me/bin:/opt/mastan-me/runtime/node/bin:/usr/local/bin:/usr/bin:/bin:/opt/dotnet',
    LANG: 'C.UTF-8',
    TZ: config.tz,
    MASTAN_ME_DATA: config.dataDir,
    MASTAN_ME_WORKSPACE: config.workspace,
    PLAYWRIGHT_BROWSERS_PATH,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    // .NET SDK for the warehouse repo (deploy installs it under /opt/dotnet; harmless when absent).
    DOTNET_ROOT: '/opt/dotnet',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    ...extra,
  };
}

// MCP servers for Claude calls. Claude runs without Owner's claude.ai connectors (Gmail, Drive, Canva, plugins):
// they are not part of the harness yet (MASTAN_ME_CONNECTORS=on brings them back). Configs live in
// <data>/run (0600, rewritten at start):
//   mcp-none.json  no servers: jobs, the extractor.
//   mcp-main-<user>.json  the main agent: Smartsheet when its token is loaded, and a stdio Playwright MCP
//                       with that user's persistent profile when the bundled browser is installed.
// Destructive Smartsheet tools are denied outright: --disallowedTools removes them from the model's tool list
// (checked 26 Oct under bypassPermissions). The other writes need Owner's yes (SOUL.md).
export const connectorsOn = () => process.env.MASTAN_ME_CONNECTORS === 'on';
export const SMARTSHEET_URL = 'https://mcp.smartsheet.com';
export const SMARTSHEET_DENIED = ['delete_rows', 'delete_column', 'execute_sharing_write', 'execute_automations_write']
  .map(t => `mcp__smartsheet__${t}`);

function smartsheetToken() {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  for (const f of [dir && join(dir, 'smartsheet'), process.env.SMARTSHEET_TOKEN_FILE].filter(Boolean)) {
    try { const t = readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  }
  return '';
}
export const smartsheetOn = () => Boolean(smartsheetToken());

function playwrightServer(chat, folder = 'browser') {
  if (process.env.MASTAN_ME_BROWSER === 'off' || !['owner', 'operator'].includes(chat?.user)) return null;
  const cli = join(config.codeDir, 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!fs.existsSync(cli)) return null;
  try {
    // Use the installed revision's platform path inside the root-owned cache.
    const {registry, registryDirectory} = require('playwright-core/lib/coreBundle').registry;
    const executable = registry.findExecutable('chromium').executablePath();
    if (!fs.existsSync(join(PLAYWRIGHT_BROWSERS_PATH, relative(registryDirectory, executable)))) return null;
  } catch { return null; }
  const dir = join(config.dataDir, 'users', chat.user, folder);
  const profile = join(dir, 'profile'), out = join(dir, 'out');
  for (const path of [profile, out]) {
    mkdirSync(path, {recursive: true, mode: 0o700});
    chmodSync(path, 0o700);
  }
  return {type: 'stdio', command: process.execPath, args: [cli, '--browser', 'chromium', '--headless',
    '--idle-timeout', '600000', '--user-data-dir', profile, '--output-dir', out], env: {PLAYWRIGHT_BROWSERS_PATH}};
}

const written = new Map(); // file -> content on disk, so the file is rewritten only when it changes
function mcpFile(name, content, dir = join(config.dataDir, 'run')) {
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = join(dir, name);
  if (written.get(file) !== content) {
    writeFileSync(file + '.tmp', content, {mode: 0o600});
    renameSync(file + '.tmp', file);
    written.set(file, content);
  }
  return file;
}

// Command-line arguments that pick the MCP servers for one Claude call. Explicit 'none' stays strict even with connectors on.
// 'main-noorg' is the DeepSeek chat agent: never Smartsheet, its own browser profile, config file in the DeepSeek
// run dir (the normal run dir is hidden inside its sandbox), always strict.
export function mcpArgs(kind, chat) {
  if (kind === 'main-noorg') {
    if (!['owner', 'operator'].includes(chat?.user)) throw new Error('Bad chat context');
    const browser = playwrightServer(chat, 'browser-deepseek');
    const file = mcpFile(`mcp-main-noorg-${chat.user}.json`, JSON.stringify({mcpServers: browser ? {playwright: browser} : {}}) + '\n',
      join(config.dataDir, 'deepseek', 'run'));
    return ['--strict-mcp-config', '--mcp-config', file];
  }
  if (kind === 'main' && !['owner', 'operator'].includes(chat?.user)) throw new Error('Bad chat context');
  const token = kind === 'main' ? smartsheetToken() : '';
  const servers = token ? {smartsheet: {type: 'http', url: SMARTSHEET_URL, headers: {Authorization: `Bearer ${token}`}}} : {};
  const browser = kind === 'main' ? playwrightServer(chat) : null;
  if (browser) servers.playwright = browser;
  if (connectorsOn() && kind !== 'main' && kind !== 'none') return [];
  const file = mcpFile(kind === 'main' ? `mcp-main-${chat.user}.json` : 'mcp-none.json', JSON.stringify({mcpServers: servers}) + '\n');
  const args = connectorsOn() && kind !== 'none' ? ['--mcp-config', file] : ['--strict-mcp-config', '--mcp-config', file];
  if (token) args.push('--disallowedTools', SMARTSHEET_DENIED.join(','));
  return args;
}

export function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
}

// One line per model call: task, role, provider, model, duration, exit code. Never content.
export function logCall(entry) {
  try {
    mkdirSync(dirname(config.callsLog), {recursive: true});
    appendFileSync(config.callsLog, JSON.stringify({ts: new Date().toISOString(), ...entry}) + '\n');
  } catch {}
}
