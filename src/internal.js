// Internal routes accept only direct loopback requests. Chat tokens cannot call operator routes.
import {createHash, timingSafeEqual} from 'node:crypto';
import {sim, sendToOwner} from './channels/telegram-api.js';
import {chatForToken} from './chat-tokens.js';
import {createFileSender} from './files.js';
import {fleetAutoOf} from './web/fleet-auto.js';

export function createInternal(ctx, options = {}) {
  const {config, telegram, agent, tasks, schedules} = ctx;
  const send = createFileSender(ctx, options);
  const json = (res, status, value) => res.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(value));
  return async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !Object.hasOwn(req.headers, 'x-real-ip');
    if (!local || req.method !== 'POST') return json(res, 404, {error: 'Not found.'});
    const chatRoute = ['/internal/send-file', '/internal/tasks', '/internal/schedules', '/internal/fleet-run'].includes(req.url);
    const chat = chatRoute ? chatForToken(req.headers['x-chat-token']) : null;
    if (chatRoute) {
      if (!chat) return json(res, 404, {error: 'Not found.'});
    } else {
      const want = createHash('sha256').update(config.sessionSecret + ':internal').digest();
      const got = Buffer.from(String(req.headers['x-internal-token'] || ''), 'hex');
      if (!config.sessionSecret || got.length !== want.length || !timingSafeEqual(got, want)) return json(res, 404, {error: 'Not found.'});
    }
    let input;
    try {
      let size = 0; const parts = [];
      for await (const c of req) { size += c.length; if (size > 100_000) return json(res, 413, {error: 'Too long.'}); parts.push(c); }
      input = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bad body');
    } catch { return json(res, 400, {error: 'Bad JSON body.'}); }
    if (chat && req.url === '/internal/fleet-run') return json(res, 200, await fleetAutoOf(ctx, options.fleet).onRun(chat, input.id));
    if (chat) {
      // Tasks and schedule checks run on Claude with Work tools, and their results come back into the chat: not from DeepSeek chats.
      if (chat.deepseek && req.url !== '/internal/send-file') return json(res, 200, {status: 'unavailable', error: 'Background tasks and schedules are off in DeepSeek chats. Do the work in this reply, or tell Owner to switch with /model claude.'});
      const out = req.url === '/internal/schedules'
        ? schedules ? await schedules.request(chat, input) : {status: 'unavailable', error: 'Schedules are not available here.'}
        : req.url === '/internal/tasks' ? tasks ? await tasks.request(chat, input) : {status: 'unavailable', error: 'Background tasks are not available here.'}
          : await send(chat, input);
      return json(res, 200, out);
    }
    if (req.url === '/internal/admin/schedules') {
      if (input.runs !== undefined && (!Number.isSafeInteger(input.runs) || input.runs < 1)) return json(res, 400, {error: 'Give a schedule id.'});
      return json(res, 200, schedules ? {status: 'ok', schedules: schedules.adminList(input.runs)} : {status: 'unavailable'});
    }
    if (req.url === '/internal/admin/schedule-fire') return json(res, 200, schedules ? schedules.fire(input.id) : {status: 'unavailable'});
    if (req.url === '/internal/telegram-sim') {
      const store = {calls: []};
      const chatId = Number(input.chat_id || 1);
      const update = {update_id: 0, message: {message_id: Number(input.message_id || 1), from: {id: Number(input.from_id || config.ownerTelegramId)},
        chat: {id: chatId, type: 'private'}, text: input.text, reply_to_message: input.reply_to ? {message_id: input.reply_to} : undefined}};
      await sim.run(store, async () => {
        await telegram.handle(update);
        const deadline = Date.now() + Number(input.wait_ms ?? (input.until_tasks_done ? 60 * 60_000 : 0));
        while (Date.now() < deadline && (agent.busyCount() || input.until_calls && store.calls.length < input.until_calls
          || input.until_tasks_done && tasks?.busySimulation(store))) await new Promise(r => setTimeout(r, 100));
      });
      return json(res, 200, store);
    }
    if (req.url === '/internal/notify') {
      if (typeof input.text !== 'string' || !input.text.trim()) return json(res, 400, {error: 'Text required.'});
      const sent = await sendToOwner(input.text, input.silent ? {disable_notification: true} : {});
      return json(res, 200, {messages: sent.length});
    }
    return json(res, 404, {error: 'Not found.'});
  };
}
