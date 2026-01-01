import {pathToFileURL} from 'node:url';

const usage = 'Usage: mastan-me-schedule add --remind|--check --title "title" [--at "YYYY-MM-DD HH:MM"|--at HH:MM|--at now|--in 90m] [--repeat "every 3h"] [--until YYYY-MM-DD] [--times N] < text | list | pause|resume|delete|run <id>';
export async function schedule(args, {env = process.env, request = fetch, stdin = process.stdin} = {}) {
  if (!env.MASTAN_ME_RPC || !env.MASTAN_ME_CHAT_TOKEN) return {status: 'unavailable', error: 'Schedules are not available here (no chat context).'};
  const [action, ...flags] = args, input = {action};
  if (action === 'add') {
    for (let n = 0; n < flags.length; n++) {
      const flag = flags[n];
      if (['--remind', '--check'].includes(flag)) {
        if (input.kind) return {status: 'failed', error: usage};
        input.kind = flag === '--remind' ? 'reminder' : 'check';
      } else {
        const key = {'--title': 'title', '--at': 'at', '--in': 'in', '--repeat': 'repeat', '--until': 'until', '--times': 'times'}[flag];
        if (!key || Object.hasOwn(input, key) || n + 1 >= flags.length || flags[n + 1].startsWith('--')) return {status: 'failed', error: usage};
        const value = flags[++n];
        if (key === 'times' && !/^[1-9]\d*$/.test(value)) return {status: 'failed', error: '--times must be a positive whole number.'};
        input[key] = key === 'times' ? Number(value) : value;
      }
    }
    if (!input.kind || !input.title) return {status: 'failed', error: usage};
    const key = input.kind === 'check' ? 'brief' : 'text', max = input.kind === 'check' ? 20_000 : 2000;
    input[key] = '';
    // A reminder can omit stdin when called at a terminal.
    if (!stdin.isTTY) {
      stdin.setEncoding?.('utf8');
      for await (const part of stdin) {
        input[key] += part;
        if (input[key].length > max) return {status: 'failed', error: `${key === 'brief' ? 'Brief' : 'Text'} accepts up to ${max} characters.`};
      }
    }
  } else if (['pause', 'resume', 'delete', 'run'].includes(action) && flags.length === 1 && /^[1-9]\d*$/.test(flags[0])) input.id = Number(flags[0]);
  else if (action !== 'list' || flags.length) return {status: 'failed', error: usage};
  let url;
  try {
    url = new URL(env.MASTAN_ME_RPC);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Bad RPC');
  } catch { return {status: 'failed', error: 'Invalid local service address.'}; }
  try {
    const res = await request(new URL('/internal/schedules', url), {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': env.MASTAN_ME_CHAT_TOKEN}, body: JSON.stringify(input)});
    if (!res.ok) return {status: 'failed', error: `Schedule service refused request (HTTP ${res.status}).`};
    const out = await res.json();
    if (!['ok', 'failed', 'unavailable'].includes(out.status)) throw new Error('Bad response');
    return out;
  } catch { return {status: 'failed', error: 'Schedule service response was lost. List schedules before trying again.'}; }
}

export async function main(args, options) {
  const out = await schedule(args, options);
  console.log(JSON.stringify(out));
  return out.status === 'unavailable' ? 3 : out.status === 'failed' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
