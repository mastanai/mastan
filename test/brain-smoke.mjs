// Brain smoke test with invented fixture data in a throwaway data dir (MASTAN_ME_DATA must point there).
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
const data = process.env.MASTAN_ME_DATA;
if (!data || !data.includes('brain-smoke')) throw new Error('set MASTAN_ME_DATA to a brain-smoke dir');
mkdirSync(data + '/workspace', {recursive: true});
execFileSync('git', ['init', '-q', data + '/workspace']);
const {atlas} = await import('/opt/mastan-me/src/atlas/store.js');
const {brain} = await import('/opt/mastan-me/src/brain/index.js');
const a = atlas();
a.put('positions', {id: 'p-walk-daily', domain: 'Health & body', statement: 'I walk every day.', confidence: 0.5, since: '2026-10-01', last_confirmed: null, status: 'needs_confirmation', sources: [], links: [{id: 'p-no-time-for-sport', type: 'tension'}], tags: [], body: 'Fixture.'});
a.put('positions', {id: 'p-no-time-for-sport', domain: 'Health & body', statement: 'I have no time for sport.', confidence: 0.5, since: '2026-10-01', last_confirmed: null, status: 'needs_confirmation', sources: [], links: [{id: 'p-walk-daily', type: 'tension'}], tags: [], body: 'Fixture.'});
a.put('questions', {id: 'q-walk-vs-no-time', domain: 'Health & body', text: 'You said you walk every day and also that you have no time for sport. Which is true this month?', why: 'Two fixture positions conflict.', status: 'open', asked_at: '2026-10-20', answered_at: null, answer: null, positions: ['p-walk-daily', 'p-no-time-for-sport'], positions_created: [], positions_changed: []});
a.commit('fixture');
const t0 = Date.now();
const r = await brain.answer('q-walk-vs-no-time', 'Walking is true, about 40 minutes most days. Sport means the gym and I skip it because evenings go to work. I want two gym sessions a week from November.', 'test');
console.log(JSON.stringify({seconds: Math.round((Date.now() - t0) / 1000), ...r}, null, 1));
console.log(a.renderAtlasMd());
console.log(execFileSync('git', ['-C', data + '/workspace', 'log', '--oneline'], {encoding: 'utf8'}));
