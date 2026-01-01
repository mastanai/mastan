// morning-set (07:30 Riyadh): send up to 5 open questions (at most 2 per domain) to Owner on Telegram.
// Each question is its own message; a Telegram reply to it answers that question (telegram-api records
// the message ids). Runs once per day unless --force.
import {atlas as sharedAtlas} from '../atlas/store.js';
import {today} from '../config.js';
import {kvGet, kvSet} from '../db.js';

export async function run({force = false, a = sharedAtlas(), telegram} = {}) {
  const date = today();
  if (!force && kvGet('morning-set.last_date') === date) return {status: 'skipped', detail: `already sent today (${date})`};
  const questions = a.morningSet(5);
  if (!questions.length) return {status: 'skipped', detail: 'no open questions'};
  telegram ||= await import('../channels/telegram-api.js');
  if (telegram.enabled && !telegram.enabled()) throw new Error('Telegram is not configured (token or owner id missing)');
  const n = questions.length;
  const intro = `Good morning. ${n} question${n === 1 ? '' : 's'} for today.\nReply to a message to answer it, or tap Later or Skip.`;
  const ids = await telegram.sendQuestions(questions, {intro});
  // First time a question goes out, it starts its "waiting N days" clock.
  let stamped = 0;
  for (const q of questions) {
    const doc = a.get('questions', q.id);
    if (!doc) continue;
    if (!doc.asked_at) { doc.asked_at = date; stamped++; }
    doc.last_sent = date;
    doc.times_sent = (Number(doc.times_sent) || 0) + 1;
    a.put('questions', doc);
  }
  a.commit(`morning set ${date}: ${n} questions sent`);
  kvSet('morning-set.last_date', date);
  return {status: 'ok', detail: `sent ${n} questions (${ids.length} messages, ${stamped} first time)`};
}
