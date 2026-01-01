// Runtime configuration. Secrets come from /etc/mastan-me/env (systemd EnvironmentFile);
// paths default to the server layout and can be overridden for local tests.
import {readFileSync, writeFileSync, mkdirSync, existsSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const config = {
  codeDir: CODE_DIR,
  dataDir: env.MASTAN_ME_DATA || '/var/lib/mastan-me',
  port: Number(env.MASTAN_ME_PORT || 3100),
  host: env.MASTAN_ME_HOSTNAME || 'me.example.com',
  rpId: env.MASTAN_ME_RP_ID || 'mastan.ai',
  tz: 'Asia/Riyadh',
  sessionSecret: env.SESSION_SECRET || '',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  ownerTelegramId: Number(env.OWNER_TELEGRAM_ID || 0),
  boardUrl: env.BOARD_URL || 'https://mastan.ai/board/',
  boardToken: env.BOARD_WRITER_TOKEN || '',
  claudeBin: env.CLAUDE_BIN || '/usr/local/bin/claude',
  codexBin: env.CODEX_BIN || '/opt/mastan-me/runtime/codex-vendor/bin/codex',
  codexHome: env.CODEX_HOME_FOR_CODER || '/var/lib/mastan/home/.codex',
  agentHome: env.AGENT_HOME || '/var/lib/mastan/home',
  credentialsDir: env.CREDENTIALS_DIRECTORY || '/run/credentials',
  // DeepSeek (per chat, see src/providers/deepseek.js): key file root:mastan 0640, and the bubblewrap that sandboxes its processes.
  deepseekKeyFile: env.DEEPSEEK_KEY_FILE || '/etc/mastan-me/deepseek-key',
  stripeReadKeyFile: env.MASTAN_ME_STRIPE_READ_KEY_FILE || '/etc/mastan-me/stripe-read-key',
  stripeBillingKeyFile: env.MASTAN_ME_STRIPE_BILLING_KEY_FILE || '/etc/mastan-me/stripe-billing-key',
  stripeBillingPaymentConfig: env.MASTAN_ME_STRIPE_BILLING_PAYMENT_CONFIG || '',
  clientsCanaryKeyFile: env.MASTAN_ME_CLIENTS_CANARY_KEY_FILE || '/etc/mastan-me/clients-canary-key',
  clientsCanaryKnownHosts: env.MASTAN_ME_CLIENTS_CANARY_KNOWN_HOSTS || '/etc/mastan-me/clients-canary-known-hosts',
  clientsCanaryHost: env.MASTAN_ME_CLIENTS_CANARY_HOST || '203.0.113.10',
  // Mail alerts go to canary's notice queue (WhatsApp) with their own restricted key; host and known_hosts follow the clients export.
  ownerNoticeKey: env.MASTAN_ME_OWNER_NOTICE_KEY_FILE || '/etc/mastan-me/owner-notice-key',
  ownerNoticeKnownHosts: env.MASTAN_ME_OWNER_NOTICE_KNOWN_HOSTS || env.MASTAN_ME_CLIENTS_CANARY_KNOWN_HOSTS || '/etc/mastan-me/clients-canary-known-hosts',
  ownerNoticeHost: env.MASTAN_ME_OWNER_NOTICE_HOST || env.MASTAN_ME_CLIENTS_CANARY_HOST || '203.0.113.10',
  bwrapBin: env.MASTAN_ME_BWRAP || '/opt/mastan-me/runtime/codex-vendor/codex-resources/bwrap',
};
config.workspace = join(config.dataDir, 'workspace');
config.atlasDir = join(config.workspace, 'atlas');
config.dbPath = join(config.dataDir, 'me.sqlite');
config.callsLog = join(config.dataDir, 'logs', 'calls.jsonl');
config.modelsPath = join(config.dataDir, 'config', 'models.json');
config.origin = `https://${config.host}`;

// models.json lives in the data dir so /model can change it; the repo copy is the default.
// Providers and labels added to the repo copy later show up on load; Owner's roles and lists are never overwritten.
export function loadModels() {
  const repo = JSON.parse(readFileSync(join(CODE_DIR, 'config', 'models.json'), 'utf8'));
  if (!existsSync(config.modelsPath)) {
    mkdirSync(dirname(config.modelsPath), {recursive: true, mode: 0o700});
    writeFileSync(config.modelsPath, JSON.stringify(repo, null, 2) + '\n');
  }
  const models = JSON.parse(readFileSync(config.modelsPath, 'utf8'));
  models.choices = {...repo.choices, ...models.choices};
  models.labels = {...repo.labels, ...models.labels};
  return models;
}

// Short display name of a model ("Opus 5.5"), the id itself when none is known.
export const modelLabel = (model, models = loadModels()) => models.labels?.[model] || model;

// DeepSeek settings: the repo file, read at use (MASTAN_ME_DEEPSEEK_CONFIG overrides for tests).
export function deepseekSettings() {
  return JSON.parse(readFileSync(env.MASTAN_ME_DEEPSEEK_CONFIG || join(CODE_DIR, 'config', 'deepseek.json'), 'utf8'));
}

export function saveModels(models, by = 'owner') {
  models.changed_by = by;
  models.changed_at = new Date().toISOString();
  const tmp = config.modelsPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(models, null, 2) + '\n', {mode: 0o600});
  renameSync(tmp, config.modelsPath);
  return models;
}

export function role(name) {
  const r = loadModels().roles[name];
  if (!r) throw new Error(`Unknown role ${name}`);
  return r;
}

export function today(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}
