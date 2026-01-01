// Dump smoke test in a throwaway data dir with invented content.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync} from 'node:fs';
const data = process.env.MASTAN_ME_DATA;
if (!data || !data.includes('brain-smoke')) throw new Error('set MASTAN_ME_DATA to a brain-smoke dir');
mkdirSync(data + '/workspace', {recursive: true});
execFileSync('git', ['init', '-q', data + '/workspace']);
const {atlas} = await import('/opt/mastan-me/src/atlas/store.js');
const {brain} = await import('/opt/mastan-me/src/brain/index.js');
const p = brain.dump('Idea: a weekly 20 minute review where the agent shows me three decisions it made for me and I grade them. If I grade two weeks in a row with no red, it may act on yellow items alone.', 'test');
const r = await p;
console.log(JSON.stringify({id: p.dumpId, created: r.created, changed: r.changed, followups: r.followups, summary: r.summary}, null, 1));
console.log(readFileSync(`${data}/workspace/atlas/dumps/${p.dumpId}.md`, 'utf8').slice(0, 1200));
