// Fake `mastan-gh` for the request-PR tests. Speaks the same command line as github-gate/mastan-gh but talks to a local bare repo
// (remote "github" of the clone) instead of the gate. Each call is logged to <FAKE_GH_DIR>/calls.jsonl with its argument list and
// any body file. <FAKE_GH_DIR>/refuse names an op to refuse ("fetch", "push", "pr-create", "comment") with the gate's message style.
import {appendFileSync, readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

const dir = process.env.FAKE_GH_DIR;
let argv = process.argv.slice(2);
const entry = {argv, cwd: process.cwd()};
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (flag('--body-file')) entry.body = readFileSync(flag('--body-file'), 'utf8');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(entry) + '\n');
if (argv[0] === '-R') argv = argv.slice(2);
const op = argv[0] === 'pr' ? `pr-${argv[1]}` : argv[0];
const refuse = existsSync(join(dir, 'refuse')) ? readFileSync(join(dir, 'refuse'), 'utf8').trim() : '';
if (refuse === op || (refuse === 'comment' && op === 'pr-comment')) {
  process.stderr.write(`mastan-gh: ${op} is not allowed on your-org/mastan-me (allowed: read only)\n`);
  process.exit(1);
}
const git = (...args) => execFileSync('git', args, {encoding: 'utf8'});
if (op === 'fetch') { git('fetch', '-q', 'github'); console.log('your-org/mastan-me: 1 branches, default main'); }
else if (op === 'push') {
  const local = argv[1], remote = local.replace(/^me\//, '');
  git('push', '-q', 'github', `refs/heads/${local}:refs/heads/${remote}`);
  console.log(`pushed ${local} -> your-org/mastan-me ${remote}`);
} else if (op === 'pr-create') console.log('draft PR #7 opened: https://github.com/your-org/mastan-me/pull/7');
else if (op === 'pr-comment') console.log('commented: https://github.com/your-org/mastan-me/pull/7#issuecomment-1');
else { process.stderr.write(`mastan-gh: unknown ${op}\n`); process.exit(2); }
