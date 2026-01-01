// Auto-approve glue between the chat and the gate. The agent tells us which request it made, with its own chat token.
// Only a web turn that Owner's own browser started holds a lease, so Telegram, tasks and schedules always get a card.
import {fleetCall} from './fleet.js';

const TRACKED_MAX = 200;
const WAIT_S = 900;

export function createFleetAuto(ctx, {transport = fleetCall} = {}) {
  const tracked = new Map(); // request id -> {who, thread}
  const socketPath = () => ctx.fleetSocket || '/run/mastan-fleet.sock';
  const remember = (id, where) => {
    tracked.set(id, where);
    if (tracked.size > TRACKED_MAX) tracked.delete(tracked.keys().next().value);
  };
  return {
    // Called from /internal/fleet-run. `chat` comes from the chat token, never from the request body.
    async onRun(chat, id) {
      if (!/^[a-f0-9]{32}$/.test(String(id))) return {status: 'refused'};
      if (chat.channel !== 'web' || chat.kind || chat.taskId || chat.simulation || chat.user !== 'owner' || !ctx.chat) return {status: 'other'};
      const thread = ctx.chat.threadOfChat(chat.chatId);
      if (!thread) return {status: 'other'};
      remember(id, {who: chat.user, thread});
      const lease = ctx.chat.turnLease(thread);
      if (!lease) return {status: 'web', auto: false};
      try {
        const out = await transport({op: 'auto_run', id, lease}, {socketPath: socketPath()});
        return {status: 'web', auto: !!out.ok};
      } catch { return {status: 'web', auto: false}; } // The card still shows.
    },
    // Owner approved a card. If the turn that asked has ended by the time it finishes, start a turn with the result.
    afterApprove(id, lease) {
      const where = tracked.get(id);
      if (!where || !ctx.chat) return Promise.resolve();
      tracked.delete(id);
      return transport({op: 'wait', id, timeout_s: WAIT_S}, {socketPath: socketPath(), timeout: (WAIT_S + 20) * 1000})
        .then(row => { if (row.ok && row.state !== 'approved') ctx.chat.resumeAfterRequest(where.who, where.thread, row, lease); })
        .catch(() => {});
    },
  };
}

export const fleetAutoOf = (ctx, options) => (ctx.fleetAuto ||= createFleetAuto(ctx, options));
