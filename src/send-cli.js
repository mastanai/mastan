import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const codes = {sent: 0, failed: 1, uncertain: 2, unavailable: 3};
export async function send(args, {env = process.env, request = fetch} = {}) {
  if (!env.MASTAN_ME_RPC || !env.MASTAN_ME_CHAT_TOKEN) return {status: 'unavailable', error: 'File delivery is not available here (no chat context).'};
  const [path, ...flags] = args;
  if (!path || path.startsWith('--') || flags.length % 2) return {status: 'failed', error: 'Usage: mastan-me-send <path> [--caption text] [--name filename]'};
  const input = {path: resolve(path)};
  for (let i = 0; i < flags.length; i += 2) {
    const key = {'--caption': 'caption', '--name': 'name'}[flags[i]];
    if (!key || Object.hasOwn(input, key)) return {status: 'failed', error: 'Bad file delivery options.'};
    input[key] = flags[i + 1];
  }
  let url;
  try {
    url = new URL(env.MASTAN_ME_RPC);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Bad RPC');
  } catch { return {status: 'failed', error: 'Invalid local service address.'}; }
  try {
    const res = await request(new URL('/internal/send-file', url), {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6 * 60_000),
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': env.MASTAN_ME_CHAT_TOKEN}, body: JSON.stringify(input)});
    if (!res.ok) return {status: 'failed', error: `File service refused request (HTTP ${res.status}).`};
    const out = await res.json();
    if (!['sent', 'failed', 'uncertain'].includes(out.status)) return {status: 'uncertain', error: 'File service returned no delivery receipt. Do not resend.'};
    return out;
  } catch { return {status: 'uncertain', error: 'File service response was lost. The file may have arrived. Do not resend.'}; }
}

export async function main(args, options) {
  const out = await send(args, options);
  console.log(JSON.stringify(out));
  return codes[out.status];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
