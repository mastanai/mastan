// mastan-me-request-prs: settings and state of the client-requests-as-PRs flow, on the hub, as user mastan.
//   settings                     show every setting
//   set key=value [key=value]    change settings (enabled=on turns the flow on; it is off by default)
//   status                       usage in the last 24 hours and the latest items
// The flow itself runs as the job: mastan-me-job request-prs (timer mastan-me-request-prs.timer).
import {openDb} from '../db.js';
import {config} from '../config.js';
import {createRequestPrs, readSettings, writeSettings, DEFAULTS} from './request-prs.js';

const [cmd, ...rest] = process.argv.slice(2);
const db = openDb();
const usage = () => Object.assign(new Error('Usage: mastan-me-request-prs settings | set key=value ... | status'), {expose: true, code: 2});
try {
  if (cmd === 'settings' || !cmd) {
    const s = readSettings(db);
    for (const key of Object.keys(DEFAULTS)) console.log(`${key}=${s[key]}${s[key] === DEFAULTS[key] ? '' : ' (changed)'}`);
  } else if (cmd === 'set') {
    if (!rest.length) throw usage();
    const patch = {};
    for (const pair of rest) {
      const at = pair.indexOf('=');
      if (at < 1) throw Object.assign(new Error(`Not key=value: ${pair}`), {expose: true});
      patch[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const s = writeSettings(db, patch);
    console.log(Object.keys(patch).map(k => `${k}=${s[k]}`).join('\n'));
  } else if (cmd === 'status') {
    const st = createRequestPrs({db, config}, {agents: {}, log: () => {}}).status();
    console.log(`on: ${st.settings.enabled}. Last 24 hours: ${st.usage.runs} agent runs, ${st.usage.prs} draft PRs, about $${st.usage.cost.toFixed(2)}.`);
    for (const it of st.items) console.log(`${it.ref} ${it.state}${it.category ? ' (' + it.category + ')' : ''}${it.card_id ? ' card ' + it.card_id : ''}${it.pr_url ? ' ' + it.pr_url : ''}`);
  } else throw usage();
} catch (error) {
  console.error(error.expose ? error.message : 'Could not do that.');
  process.exitCode = error.code === 2 ? 2 : 1;
}
