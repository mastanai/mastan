// A real hub for the end-to-end test on the server branch: the real web service on a loopback port with a temporary database.
// Telegram is a fake: each digest is printed. Commands arrive as lines on stdin, so the other process can act as the owner.
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';

const data = process.env.MASTAN_ME_DATA || mkdtempSync(join(tmpdir(), 'capability-hub-'));
process.env.MASTAN_ME_DATA = data;
process.env.MASTAN_ME_TELEGRAM = 'off';
const {config} = await import('../src/config.js');
const {openDb} = await import('../src/db.js');
const {createWeb} = await import('../src/web/index.js');
const db = openDb(), ctx = {config, db, atlas: {stats: () => ({})}};
const clock = {at: Number(process.env.HUB_NOW) || Date.now()};
const print = value => process.stdout.write(JSON.stringify(value) + '\n');
const web = createWeb(ctx, {now: () => clock.at, capabilityNotify: async text => print({digest: text})});
const server = createServer((req, res) => web(req, res).catch(() => { res.statusCode = 500; res.end(); }));
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;
// After a restart the server keeps the token it already holds.
const token = process.env.HUB_KEEP_TOKEN ? null : ctx.capabilityRequests.connect(process.env.HUB_SERVER || 'dev-server-01', 'Dev Client');
print({port, token});
for await (const line of createInterface({input: process.stdin})) {
  const command = JSON.parse(line);
  if (command.quit) break;
  if (command.advance) clock.at += command.advance;
  if (command.tick) await ctx.capabilityRequests.tick();
  if (command.status) ctx.capabilityRequests.setStatus(command.key, command.status);
  print({done: true, list: ctx.capabilityRequests.list()});
}
server.close(); server.closeAllConnections();
ctx.capabilityRequests.shutdown();
db.close();
if (!process.env.MASTAN_ME_DATA_KEEP) rmSync(data, {recursive: true, force: true});
process.exit(0);
