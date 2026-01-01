// Providers behind one interface. Roles and models come from config/models.json (data dir copy),
// which only Owner changes. No automatic switching: fallbacks apply only if Owner lists them.
// opts.pick ({provider, model, effort}) is Owner's choice for one chat (/model deepseek): it is the only step, no fallbacks.
import {loadModels} from '../config.js';
import {logCall} from './common.js';
import * as claudeCli from './claude-cli.js';
import * as codexCli from './codex-cli.js';
import * as deepseekCli from './deepseek-cli.js';

export const providers = {'claude-cli': claudeCli, 'codex-cli': codexCli, 'deepseek-cli': deepseekCli};
export const {dropSession, shutdownSessions, residentCount} = claudeCli;

// Boots the role's resident ahead of a turn (providers without residents: no-op). Nothing goes to the model.
export function warmRole(roleName, opts = {}) {
  const r = opts.pick || loadModels().roles[roleName];
  const provider = r && providers[r.provider];
  if (!provider?.warm) return {warmed: false};
  return provider.warm({...opts, model: r.model, effort: opts.effort ?? r.effort});
}

export async function runRole(roleName, opts = {}) {
  const models = loadModels();
  const r = opts.pick || models.roles[roleName];
  if (!r) throw new Error(`Unknown role ${roleName}`);
  const chain = opts.pick ? [r] : [r, ...((models.fallbacks || {})[roleName] || [])];
  let lastError;
  for (const step of chain) {
    const provider = providers[step.provider];
    if (!provider) { lastError = new Error(`Unknown provider ${step.provider}`); continue; }
    const started = Date.now();
    try {
      const result = await provider.run({...opts, model: step.model, effort: opts.effort ?? step.effort});
      logCall({task: opts.task || roleName, role: roleName, provider: step.provider, model: step.model, duration_ms: Date.now() - started, exit_code: result.exitCode ?? 0, ...(result.log || {})});
      return {...result, provider: step.provider, model: step.model};
    } catch (e) {
      logCall({task: opts.task || roleName, role: roleName, provider: step.provider, model: step.model, duration_ms: Date.now() - started, exit_code: e.exitCode ?? -1, error: e.code === 'ABORTED' ? 'aborted' : 'failed'});
      lastError = e;
      if (e.code === 'ABORTED') throw e;
    }
  }
  throw lastError;
}

// Parse the first JSON object in a model reply (tolerates code fences and leading prose).
export function parseJson(text) {
  const s = String(text).replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON in reply');
  return JSON.parse(s.slice(start, end + 1));
}
