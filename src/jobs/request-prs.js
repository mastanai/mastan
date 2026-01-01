// request-prs (every 15 minutes, off until Owner turns it on): Board cards, triage, one draft PR, messages.
// See src/clients/request-prs.js and docs/CAPABILITY-REQUESTS.md. Without the setting it does nothing at all.
import {config} from '../config.js';
import {openDb} from '../db.js';
import {createBoardClient} from '../board/client.js';
import {sendToOwner} from '../channels/telegram-api.js';
import {createRequestPrs, defaultAgents, readSettings, requestPrsSchema, sandboxedTests} from '../clients/request-prs.js';

export async function run({db = openDb(), log = () => {}, flow} = {}) {
  requestPrsSchema(db);
  if (!readSettings(db).enabled) return {status: 'skipped', detail: 'off (mastan-me-request-prs set enabled=on)'};
  const board = createBoardClient(config);
  flow ||= createRequestPrs({db, config}, {
    board: board.hasToken() ? board : null, notify: text => sendToOwner(text), agents: await defaultAgents(), runTests: sandboxedTests(config), log});
  return flow.tick();
}
