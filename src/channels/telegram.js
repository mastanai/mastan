// Telegram channel: long polling, owner only. Plain messages go to the main agent (streamed by
// editing one message); a reply to a question message answers that question through the brain.
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, basename} from 'node:path';
import {config, today, loadModels, saveModels, modelLabel} from '../config.js';
import {openDb, kvGet, kvSet, lastJobRuns} from '../db.js';
import {atlas} from '../atlas/store.js';
import {brain} from '../brain/index.js';
import {call, enabled, token, sendText, sendQuestions, chunks, toHtml, sim} from './telegram-api.js';
import {toolLine} from './tool-line.js';
import {busyReply} from '../agent/busy-reply.js';

const HELP = `Mastan Me, your own harness.
Write anything: I answer with your memory, skills and atlas.
Reply to a question message to answer it.

/today  questions for you now
/dump <text>  save a raw idea
/stats  atlas numbers
/board  open board items
/new  fresh conversation
/tasks  background tasks in this chat
/schedules  active and paused schedules in this chat
/stop <id>  stop a background task (/stop stops the main turn)
/model  models; switch this chat: /model deepseek, /model flash, /model claude
/jobs  last job runs
Web: ${config.origin}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[telegram]', ...a);
const sec = ms => (ms / 1000).toFixed(1);

export class TelegramChannel {
  constructor({agent, board, tasks, schedules, runBusy}) {
    this.agent = agent;
    this.board = board;
    this.tasks = tasks;
    this.schedules = schedules;
    this.db = openDb();
    this.queue = new Map();
    this.busyReplies = new Map(); // chat id -> {pending, running}, applied in arrival order
    this.runBusy = runBusy;
    this.lastPoll = 0;
    this.polling = false;
    this.bot = null;
    this.problem = null;
  }

  status() {
    return {enabled: enabled(), polling: this.polling, bot: this.bot, problem: this.problem,
      last_poll_age_s: this.lastPoll ? Math.round((Date.now() - this.lastPoll) / 1000) : null};
  }

  async start() {
    if (!enabled()) { log('disabled: no token or owner id'); return; }
    try {
      const hook = await call('getWebhookInfo');
      if (hook.url) { this.problem = 'webhook set'; log('a webhook is set on this bot; not polling'); return; }
      this.bot = (await call('getMe')).username;
      await call('setMyCommands', {commands: [
        {command: 'today', description: 'Questions for you now'}, {command: 'dump', description: 'Save a raw idea'},
        {command: 'stats', description: 'Atlas numbers'}, {command: 'board', description: 'Open board items'},
        {command: 'new', description: 'Fresh conversation'}, {command: 'stop', description: 'Stop the running task'},
        {command: 'tasks', description: 'Background tasks in this chat'},
        {command: 'schedules', description: 'Schedules in this chat'},
        {command: 'model', description: 'Models; /model deepseek or /model claude'}, {command: 'jobs', description: 'Last job runs'}]}).catch(() => {});
    } catch (e) { this.problem = 'start failed'; log('start failed:', e.message.replace(token(), '<token>')); setTimeout(() => this.start(), 30_000); return; }
    this.polling = true;
    log(`polling as @${this.bot}`);
    void this.loop();
  }

  async loop() {
    let backoff = 0;
    while (this.polling) {
      try {
        const updates = await call('getUpdates', {offset: kvGet('tg_offset', 0), timeout: 25, allowed_updates: ['message', 'callback_query']}, {timeoutMs: 40_000});
        this.lastPoll = Date.now(); backoff = 0; this.problem = null;
        for (const u of updates) {
          kvSet('tg_offset', u.update_id + 1);
          this.handle(u).catch(e => log('handler error:', e.message.slice(0, 200)));
        }
      } catch (e) {
        this.lastPoll = Date.now();
        if (e.status === 409) { this.problem = 'conflict: another poller holds this bot'; log('409 conflict: another process is polling this bot'); await sleep(30_000); continue; }
        if (e.status === 401) { this.problem = 'token rejected'; log('401: token rejected; polling stopped'); this.polling = false; return; }
        backoff = Math.min(60_000, backoff ? backoff * 2 : 5000);
        log(`poll failed (${e.status || e.name}); retry in ${backoff / 1000}s`);
        await sleep(backoff + Math.random() * 1000);
      }
    }
  }

  isOwner(from) { return from && Number(from.id) === config.ownerTelegramId; }

  async handle(u) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m) return;
    if (!this.isOwner(m.from) || m.chat.type !== 'private') {
      log('message from a non-owner ignored');
      if (m.chat.type === 'private') await sendText(m.chat.id, 'This is a private assistant.').catch(() => {});
      return;
    }
    const chatId = m.chat.id;
    if (m.date) log(`message received ${Math.max(0, Math.round(Date.now() / 1000 - m.date))}s after Owner sent it`);
    let text = (m.text || m.caption || '').trim();
    const replyTo = m.reply_to_message?.message_id;
    if (replyTo && text && !text.startsWith('/')) {
      const row = this.db.prepare('SELECT question_id FROM tg_questions WHERE message_id=?').get(replyTo);
      if (row) return this.answerQuestion(chatId, row.question_id, text);
    }
    if (text.startsWith('/')) {
      try { return await this.command(chatId, text); }
      catch (e) { log('command failed:', e.message.slice(0, 160)); return sendText(chatId, 'That command failed. Try again in a minute.'); }
    }
    const files = await this.downloads(m).catch(e => { log('download failed:', e.message); return []; });
    if (files.length) text = `${text || 'Owner sent this file.'}\n\n${files.map(f => `[Attached: ${f.path} (${f.mime}, ${f.size} bytes)]`).join('\n')}`;
    if (!text) return;
    return this.enqueue(chatId, text);
  }

  async downloads(m) {
    const items = [];
    if (m.photo?.length) items.push({...m.photo.at(-1), name: `photo-${m.message_id}.jpg`, mime: 'image/jpeg'});
    for (const k of ['document', 'audio', 'voice', 'video']) if (m[k]) items.push({...m[k], name: m[k].file_name || `${k}-${m.message_id}`, mime: m[k].mime_type || 'application/octet-stream'});
    const out = [];
    for (const it of items) {
      if (it.file_size > 20_000_000) continue;
      const f = await call('getFile', {file_id: it.file_id});
      const res = await fetch(`https://api.telegram.org/file/bot${token()}/${f.file_path}`);
      if (!res.ok) continue;
      const dir = join(config.workspace, 'inbox', today());
      mkdirSync(dir, {recursive: true});
      const path = join(dir, basename(it.name).replace(/[^\w.-]/g, '_'));
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      out.push({path, mime: it.mime, size: buf.length});
    }
    return out;
  }

  enqueue(chatId, text) {
    const previous = this.busyReplies.get(chatId);
    if (this.agent.busy('telegram', chatId) || previous || this.queue.get(chatId)?.length) {
      const running = {...(this.agent.runningInfo?.('telegram', chatId) || previous?.running)};
      const simulation = sim.getStore();
      const answer = busyReply({running, queued: this.queue.get(chatId)?.length || 0, message: text}, {run: this.runBusy});
      const pending = (previous?.pending || Promise.resolve()).catch(() => {}).then(async () => {
        const result = await answer;
        if (result.queue) {
          const q = this.queue.get(chatId) || [];
          q.push({text, simulation}); this.queue.set(chatId, q);
        }
        return sendText(chatId, result.reply);
      });
      const state = {pending, running};
      this.busyReplies.set(chatId, state);
      return pending.finally(() => {
        if (this.busyReplies.get(chatId) === state) this.busyReplies.delete(chatId);
        this.advance(chatId);
      });
    }
    return this.runTurn(chatId, text);
  }

  advance(chatId) {
    setImmediate(() => {
      if (this.busyReplies.has(chatId) || this.agent.busy('telegram', chatId)) return;
      const next = this.queue.get(chatId)?.shift();
      if (next) sim.run(next.simulation, () => this.runTurn(chatId, next.text));
    });
  }

  // One turn: typing indicator at once, the reply streamed into one message as text arrives. While the
  // agent runs tools and has said nothing yet, that message shows what it is doing. No placeholder bubble.
  async runTurn(chatId, text) {
    const started = Date.now();
    const typing = () => call('sendChatAction', {chat_id: chatId, action: 'typing'}).catch(() => {});
    void typing();
    const typingTimer = setInterval(typing, 4500);
    let holder = null, latest = '', shown = '', status = null, firstText = 0, sending = false, closed = false;
    let nextProgress = started + 180_000;
    const show = async view => {
      if (sending || closed || !view || view === shown) return;
      sending = true;
      try {
        if (!holder) holder = await call('sendMessage', {chat_id: chatId, text: view, disable_web_page_preview: true});
        else await call('editMessageText', {chat_id: chatId, message_id: holder.message_id, text: view, disable_web_page_preview: true});
        shown = view;
      } catch {}
      sending = false;
    };
    const tick = async () => {
      if (closed) return;
      const now = Date.now();
      if (latest) await show(latest.length > 3800 ? '...' + latest.slice(-3800) : latest);
      else if (status && now - started > 2500) await show(status);
      if (now >= nextProgress) {
        nextProgress += 180_000;
        await sendText(chatId, `Still working (${Math.round((now - started) / 60_000)} min)${status ? ', ' + status.toLowerCase().replace(/\.\.\.$/, '') : ''}.`).catch(() => {});
      }
    };
    const ticker = setInterval(tick, 1200); // Telegram allows about one edit per second per chat
    const settle = async () => { closed = true; clearInterval(ticker); clearInterval(typingTimer); while (sending) await sleep(50); };
    try {
      const result = await this.agent.turn({channel: 'telegram', chatId, text,
        onDelta: t => { latest = t; if (!firstText) { firstText = Date.now(); void tick(); } }, // first words go out at once
        onTool: (name, input) => { status = toolLine(name, input); }});
      await settle();
      // A chat Owner switched off the default model says which model answered, under the reply.
      const parts = chunks((result.text || '(no reply)') + (result.isDefault === false && result.label ? `\n\n*${result.label}*` : ''));
      if (holder) await this.finalEdit(chatId, holder.message_id, parts[0]); else await sendText(chatId, parts[0]);
      for (const p of parts.slice(1)) await sendText(chatId, p);
      log(`turn done in ${sec(Date.now() - started)}s (first text ${firstText ? sec(firstText - started) + 's' : 'none'}, model ${sec(result.durationMs)}s)`);
    } catch (e) {
      await settle();
      const pick = this.agent.pickOf?.('telegram', chatId);
      const msg = e.code === 'ABORTED' ? 'Stopped.' : `That failed (${String(e.message).slice(0, 160)}). Try again, or /new for a fresh session.${pick && !pick.isDefault ? ` /model claude switches this chat back to ${modelLabel(loadModels().roles.main.model)}.` : ''}`;
      const body = (latest ? latest.slice(0, 3500) + '\n\n' : '') + msg;
      if (holder) await call('editMessageText', {chat_id: chatId, message_id: holder.message_id, text: body}).catch(() => sendText(chatId, msg).catch(() => {}));
      else await sendText(chatId, body).catch(() => {});
      log('turn failed:', e.code || e.exitCode || 'error', `after ${sec(Date.now() - started)}s`);
    } finally {
      this.advance(chatId);
    }
  }

  async finalEdit(chatId, messageId, text) {
    try { await call('editMessageText', {chat_id: chatId, message_id: messageId, text: toHtml(text), parse_mode: 'HTML', disable_web_page_preview: true}); }
    catch (e) {
      if (/not modified/.test(e.message)) return;
      try { await call('editMessageText', {chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true}); }
      catch { await sendText(chatId, text); }
    }
  }

  async answerQuestion(chatId, questionId, text) {
    let promise;
    try { promise = brain.answer(questionId, text, 'telegram'); }
    catch (e) { return sendText(chatId, `Could not take that answer: ${e.message}`); }
    await sendText(chatId, 'Got it. Filing your answer into the atlas.');
    try {
      const r = await promise;
      const lines = [r.summary || 'Filed.'];
      if (r.created.length || r.changed.length) lines.push(`${r.created.length} new, ${r.changed.length} changed positions.`);
      await sendText(chatId, lines.join('\n'));
      const follow = r.followups.map(id => atlas().get('questions', id)).filter(Boolean);
      if (follow.length) await sendQuestions(follow, {intro: 'Follow-up:'});
    } catch (e) {
      await sendText(chatId, 'Your answer is saved, but the brain could not process it now. The nightly job will retry.');
    }
  }

  async onCallback(cb) {
    if (!this.isOwner(cb.from)) return call('answerCallbackQuery', {callback_query_id: cb.id}).catch(() => {});
    const [, action] = String(cb.data || '').split(':');
    const row = cb.message && this.db.prepare('SELECT question_id FROM tg_questions WHERE message_id=?').get(cb.message.message_id);
    let note = 'Done';
    try {
      if (row && ['later', 'skip'].includes(action)) {
        const a = atlas();
        a.setQuestionStatus(row.question_id, action === 'later' ? 'later' : 'skipped');
        a.renderAtlasMd(); a.commit(`question ${row.question_id}: ${action}`);
        note = action === 'later' ? 'Moved to later' : 'Skipped';
        await call('editMessageReplyMarkup', {chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: {inline_keyboard: []}}).catch(() => {});
      }
    } catch (e) { note = 'Failed'; }
    await call('answerCallbackQuery', {callback_query_id: cb.id, text: note}).catch(() => {});
  }

  async command(chatId, text) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    const arg = text.slice(cmdRaw.length).trim();
    const a = atlas();
    switch (cmd) {
      case '/start': case '/help': return sendText(chatId, HELP);
      case '/new': {
        this.agent.newSession('telegram', chatId);
        const pick = this.agent.pickOf?.('telegram', chatId);
        return sendText(chatId, `Fresh session${pick && !pick.isDefault ? ` on ${pick.label}` : ''}. The atlas and memory are still here.`);
      }
      case '/tasks': return sendText(chatId, this.tasks ? this.tasks.listText({user: 'owner', channel: 'telegram', chatId}) : 'Background tasks are not available here.');
      case '/schedules': return sendText(chatId, arg ? 'Usage: /schedules' : this.schedules ? this.schedules.listText({user: 'owner', channel: 'telegram', chatId}) : 'Schedules are not available here.');
      case '/stop': {
        if (!arg) return sendText(chatId, this.agent.stop('telegram', chatId) ? 'Stopping.' : 'Nothing is running.');
        if (!/^\d+$/.test(arg)) return sendText(chatId, 'Usage: /stop <id>');
        const out = await this.tasks?.stop({user: 'owner', channel: 'telegram', chatId}, arg);
        return sendText(chatId, out?.status === 'stopped' ? 'Stopping.' : out?.error || 'Background tasks are not available here.');
      }
      case '/stats': {
        const s = a.stats();
        return sendText(chatId, `${s.positions} positions (${s.needs_confirmation} to confirm)\n${s.people} people, orgs, projects\n${s.connections} connections, ${s.tensions} tensions\n${s.dumps} dumps, ${s.open_questions} open questions\nUpdated ${s.last_updated ? s.last_updated.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}`);
      }
      case '/today': case '/questions': {
        const set = a.morningSet(5);
        if (!set.length) return sendText(chatId, 'No open questions right now.');
        return sendQuestions(set, {intro: `${set.length} questions. Reply to one to answer. Or open ${config.origin}/questions`});
      }
      case '/dump': {
        if (!arg) return sendText(chatId, 'Usage: /dump your idea');
        const p = brain.dump(arg, 'telegram');
        await sendText(chatId, 'Saved. I will file it.');
        p.then(r => sendText(chatId, `Dump filed. ${r.summary || ''}`.trim())).catch(() => {});
        return;
      }
      case '/board': {
        if (!this.board) return sendText(chatId, 'Board is not connected yet.');
        try {
          const snap = await this.board.snapshot();
          if (snap.unavailable) return sendText(chatId, `Board unavailable: ${snap.unavailable}.`);
          const items = (snap.items || []).filter(i => !/done/i.test(i.lane || i.status || ''));
          const lines = items.slice(0, 20).map((i, n) => `${n + 1}. ${i.needs_you ? '[you] ' : ''}${i.title}${i.area ? ` (${i.area})` : ''}`);
          const ro = snap.read_only ? `\n\nRead-only copy from ${String(snap.synced_at || '').slice(0, 16).replace('T', ' ')} (writer token not approved yet).` : '';
          return sendText(chatId, lines.length ? `Open board items:\n${lines.join('\n')}${ro}\n\n${config.origin}/board` : 'Board is empty.');
        } catch (e) { return sendText(chatId, 'Board unavailable right now.'); }
      }
      case '/jobs': {
        const runs = lastJobRuns();
        if (!runs.length) return sendText(chatId, 'No job runs yet.');
        return sendText(chatId, runs.map(r => `${r.job}: ${r.status} at ${new Date(r.started).toISOString().slice(0, 16).replace('T', ' ')} UTC`).join('\n'));
      }
      case '/model': return this.model(chatId, rest);
      default: return sendText(chatId, `Unknown command. /help lists them.`);
    }
  }

  // /model: roles, choices and this chat's model. /model <model or alias> switches this chat only (deepseek, flash,
  // claude); /model <role> <model> changes a role for every chat (DeepSeek is per chat only).
  async model(chatId, [roleName, model]) {
    const models = loadModels();
    const pick = this.agent.pickOf?.('telegram', chatId);
    if (!roleName) {
      const lines = Object.entries(models.roles).map(([k, v]) => `${k}: ${v.model} (${v.provider}${v.effort ? ', ' + v.effort : ''})`);
      const choices = Object.entries(models.choices || {}).map(([p, list]) => `${p}: ${list.join(', ')}`);
      const chat = pick ? `\n\nThis chat: ${pick.label}${pick.isDefault ? ' (default)' : ' (set by you)'}\nSwitch this chat: /model deepseek (V4 Pro), /model flash, /model claude` : '';
      return sendText(chatId, `Models now:\n${lines.join('\n')}\n\nChoices:\n${choices.join('\n')}\n\nSet a role: /model <role> <model>${chat}`);
    }
    if (!model && this.agent.setPick) return this.switchChat(chatId, roleName, models, pick);
    const r = models.roles[roleName];
    if (!r) return sendText(chatId, `No role ${roleName}. Roles: ${Object.keys(models.roles).join(', ')}`);
    const provider = Object.entries(models.choices || {}).find(([, list]) => list.includes(model))?.[0];
    if (!provider) return sendText(chatId, `Unknown model ${model}. /model shows the choices.`);
    if (provider === 'deepseek-cli') return sendText(chatId, 'DeepSeek is per chat: /model deepseek or /model flash.');
    models.roles[roleName] = {...r, provider, model};
    saveModels(models, 'owner');
    return sendText(chatId, `${roleName} is now ${model} (${provider}). Changed by you.`);
  }

  async switchChat(chatId, arg, models, pick) {
    const aliases = {claude: null, default: null, deepseek: 'deepseek-v4-pro', pro: 'deepseek-v4-pro', flash: 'deepseek-flash'};
    const target = Object.hasOwn(aliases, arg.toLowerCase()) ? aliases[arg.toLowerCase()] : arg;
    if (target !== null && !['claude-cli', 'deepseek-cli'].some(p => (models.choices[p] || []).includes(target))) {
      const r = models.roles[arg];
      if (r) return sendText(chatId, `${arg}: ${r.model} (${r.provider}${r.effort ? ', ' + r.effort : ''})`);
      return sendText(chatId, `Unknown model ${arg}. /model shows the choices.`);
    }
    if (pick && (target === null ? pick.isDefault : !pick.isDefault && pick.model === target)) return sendText(chatId, `This chat already runs on ${pick.label}.`);
    let now;
    try { now = this.agent.setPick('telegram', chatId, target); }
    catch (e) { return sendText(chatId, e.code === 'BUSY' ? e.message : `Could not switch: ${e.message}`); }
    return sendText(chatId, `This chat now runs on ${now.label}. New session; the atlas and memory are still here.${now.deepseek ? ' On DeepSeek, Work tools, background tasks and schedules are off. /model claude switches back.' : ''}`);
  }
}
