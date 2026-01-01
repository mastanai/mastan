// DeepSeek provider: the Claude Code CLI provider with backend 'deepseek' (see deepseek.js). Same residents,
// --resume, tools and streaming; effort comes from config/deepseek.json.
import {deepseekSettings} from '../config.js';
import * as claude from './claude-cli.js';
import {deepseekError} from './deepseek.js';

export async function run(opts) {
  try { return await claude.run({...opts, backend: 'deepseek', effort: deepseekSettings().effort}); }
  catch (e) { throw deepseekError(e); }
}

export function warm(opts) {
  return claude.warm({...opts, backend: 'deepseek', effort: deepseekSettings().effort});
}
