import {pathToFileURL} from 'node:url';

const usage = 'Usage: mastan-me-task start --title "short title" < brief.txt | start --retry <id> | list | stop <id>';
export async function task(args, {env = process.env, request = fetch, stdin = process.stdin} = {}) {
  if (!env.MASTAN_ME_RPC || !env.MASTAN_ME_CHAT_TOKEN) return {status: 'unavailable', error: 'Background tasks are not available here (no chat context).'};
  const [action, ...flags] = args;
  const input = {action};
  if (action === 'start' && flags.length === 2 && flags[0] === '--title') {
    input.title = flags[1]; input.brief = '';
    stdin.setEncoding?.('utf8');
    for await (const part of stdin) {
      input.brief += part;
      if (input.brief.length > 20_000) return {status: 'failed', error: 'The brief is too long (20,000 characters at most).'};
    }
  } else if (action === 'start' && flags.length === 2 && flags[0] === '--retry' && /^[1-9]\d*$/.test(flags[1])) input.retry = Number(flags[1]);
  else if (action === 'stop' && flags.length === 1 && /^[1-9]\d*$/.test(flags[0])) input.id = Number(flags[0]);
  else if (action !== 'list' || flags.length) return {status: 'failed', error: usage};
  let url;
  try {
    url = new URL(env.MASTAN_ME_RPC);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Bad RPC');
  } catch { return {status: 'failed', error: 'Invalid local service address.'}; }
  try {
    const res = await request(new URL('/internal/tasks', url), {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': env.MASTAN_ME_CHAT_TOKEN}, body: JSON.stringify(input)});
    if (!res.ok) return {status: 'failed', error: `Task service refused request (HTTP ${res.status}).`};
    const out = await res.json();
    if (!['queued', 'running', 'ok', 'stopped', 'failed', 'unavailable'].includes(out.status)) throw new Error('Bad response');
    return out;
  } catch { return {status: 'failed', error: 'Task service response was lost. List tasks before trying again.'}; }
}

export async function main(args, options) {
  const out = await task(args, options);
  console.log(JSON.stringify(out));
  return out.status === 'unavailable' ? 3 : out.status === 'failed' ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
