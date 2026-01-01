import {$, h, icon, api, storage, toast, menuAt, closeTop, fmtTime, dateLabel, when, setNoticeBusy, telegramAvailable} from './ui.js';
import {accountHints, notificationHint} from './install.js';
import {mergeSnapshot} from './sync.js';
import {markdown} from './markdown.js';
import {t, setBrandName} from './strings.js';
import {currentTheme, setTheme} from './theme.js';
import {startApprovals} from './approvals.js';

const app = $('#app'), area = $('#message'), timeline = $('#timeline'), list = $('#messages'), sidebar = $('.sidebar');
const wide = matchMedia('(min-width:701px)'), coarse = matchMedia('(pointer:coarse)');
let trialTail = Promise.resolve(), trialReserved = 0, userScrollUntil = 0, programmaticTop = null;
let creatingSession = null, trialRunning = false, dateTimer, connectionLost = !navigator.onLine;
let boot, authenticated = false, current = null, sessions = [], source, attachments, voice, quote = null, lastSent = '', searching = '', searchTimer;
let titleUnread = 0, renaming = null, opening = false, openingTimer;
const loadingHistory = new Set();
let cached = new Map(), more = new Map(), optimistic = [], flushing = false, unread = 0, stick = true, switching = 0, notificationOffered = false, renderFrame;
const readThrough = new Map(), toolStatus = new Map();
const pendingUploads = new Map();
const messageVersions = new Map(), sessionVersions = new Map(), deletedSessions = new Set(); let messageVersion = 0;
let cachedBoot = false;
let shellReady = false;
let workspaceKind = 'chat', workspacePage, workspaceCleanup, workspaceVersion = 0;
const workspaceNavs = [];
function workspaceNav() {
  const nav = h('nav', {class: 'workspace-nav', 'aria-label': t('workspace')}, ['chat', 'board', 'atlas'].map(kind => h('button', {type: 'button', text: t(kind), dataset: {kind}, onclick: () => { void showWorkspace(kind).catch(e => toast(e.message)); }})));
  for (let i = workspaceNavs.length - 1; i >= 0; i--) if (!workspaceNavs[i].isConnected) workspaceNavs.splice(i, 1);
  workspaceNavs.push(nav); return nav;
}
function markWorkspace(kind) { for (const nav of workspaceNavs.filter(n => n.isConnected)) for (const button of nav.children) { if (button.dataset.kind === kind) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); } }
function leaveWorkspace(remember = true) {
  if (workspaceKind === 'chat') return;
  ++workspaceVersion; workspaceCleanup?.(); workspaceCleanup = null; workspaceKind = 'chat';
  if ($('#toasts')?.parentElement === workspacePage) $('#composer-wrap').prepend($('#toasts'));
  if (workspacePage) workspacePage.hidden = true;
  $('#chat').hidden = false; app.classList.remove('workspace-screen'); markWorkspace('chat');
  if (remember) storage.set(storeKey('workspace-tab'), 'chat');
}
async function showWorkspace(kind, {push = true} = {}) {
  if (!authenticated || !boot.workspace) return;
  closeTop();
  if (kind === 'chat') {
    leaveWorkspace(); if (push) history.pushState(current ? {session: current} : {list: true}, '', current ? '/chat/s/' + current : '/chat');
    setScreen(!current); if (current && !coarse.matches) area.focus(); return;
  }
  if (!['board', 'atlas'].includes(kind)) return;
  saveDraft(); voice?.cancel(false); ++switching; screenVersion++; clearTimeout(openingTimer); opening = false; setNoticeBusy(false);
  workspaceCleanup?.(); workspaceCleanup = null; const version = ++workspaceVersion; workspaceKind = kind;
  storage.set(storeKey('workspace-tab'), kind); markWorkspace(kind);
  if (push) history.pushState({workspace: kind}, '', '/' + kind);
  else if (location.pathname !== '/' + kind) history.replaceState({workspace: kind}, '', '/' + kind);
  storage.set(storeKey('workspace-session'), current);
  app.classList.add('workspace-screen'); $('#chat').hidden = true; $('#details-pane').hidden = true;
  sidebar.inert = !wide.matches; $('#chat').inert = true;
  if (!workspacePage) {
    const link = h('link', {rel: 'stylesheet', href: '/workspace.css?v=__SHELL_VERSION__'}); document.head.append(link);
    workspacePage = h('section', {class: 'workspace-page', tabindex: '-1'}); app.append(workspacePage);
  }
  workspacePage.hidden = false; workspacePage.setAttribute('aria-label', t(kind));
  const host = h('div', {class: 'workspace-content'});
  // The chat is hidden on these pages, so they carry their own top bar with the theme button in the same place.
  const bar = h('header', {class: 'chat-head workspace-bar'}, h('img', {class: 'avatar', src: '/static/mastan.png', alt: ''}), h('div', {class: 'chat-heading'}, h('div', {class: 'chat-title', text: t(kind)})), workspaceTheme());
  workspacePage.replaceChildren(bar, h('div', {class: 'workspace-phone-head'}, h('button', {class: 'icon', 'aria-label': t('back'), onclick: () => { leaveWorkspace(); showList(); }}, icon('back')), workspaceNav(), workspaceTheme()), host, $('#toasts'));
  workspacePage.focus({preventScroll: true}); markWorkspace(kind);
  try {
    const module = kind === 'board' ? await import('./board.js') : await import('./atlas.js');
    if (version !== workspaceVersion) return;
    const cleanup = await module.mount(host, {accountKey, ask: async draft => { leaveWorkspace(); await newSession(); area.value = draft; saveDraft(); autosize(); updateButton(); area.focus(); }});
    if (version === workspaceVersion) workspaceCleanup = cleanup; else cleanup?.();
  } catch (e) { if (version === workspaceVersion) host.replaceChildren(h('p', {role: 'status', text: e.message}), h('button', {class: 'text-button', text: t('retry'), onclick: () => showWorkspace(kind, {push: false})})); }
}
let media, renderedSession;
const renderedMessages = new WeakMap(), countedReplies = new Set();
const previewSizes = new ResizeObserver(entries => { for (const {target} of entries) { if (target.isConnected) fitPreview(target); else previewSizes.unobserve(target); } });
let accountKey = 'trial', queue = [], storeKey = key => accountKey + ':' + key;
const id = () => crypto.randomUUID();
const getMessages = (sid = current) => cached.get(sid || 'trial') || [];
const scrollDate = h('div', {class: 'scroll-date', 'aria-hidden': 'true'}); $('#chat').append(scrollDate);
const saveMessages = rows => { cached.set(current || 'trial', rows); };
for (const [selector, name] of [['#settings', 'settings'], ['#new-session', 'edit'], ['#search-icon', 'search'], ['#attach', 'attach'], ['#emoji', 'emoji'], ['#send', 'mic'], ['#stop', 'stop'], ['#back', 'back'], ['#details', 'panel'], ['#chat-menu', 'more']]) $(selector).append(icon(name));
$('#new-session').title = `${t('newSession')} (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌥N' : 'Ctrl+Alt+N'})`;
function applyBrandColors() {
  const brand = boot?.brand || {}, dark = currentTheme() === 'dark';
  for (const [css, key] of [['--blue', dark ? 'darkBlue' : 'blue'], ['--lilac', dark ? 'darkLilac' : 'lilac']]) if (/^#[0-9a-f]{6}$/i.test(brand[key] || '')) document.documentElement.style.setProperty(css, brand[key]);
}
function refreshTheme() {
  const dark = currentTheme() === 'dark', label = t(dark ? 'switchLight' : 'switchDark');
  for (const button of [$('#theme-toggle'), $('#side-theme-toggle'), ...document.querySelectorAll('.workspace-theme')]) {
    button.replaceChildren(icon(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-label', label); button.title = label;
  }
  applyBrandColors();
}
function workspaceTheme() {
  const button = h('button', {class: 'icon workspace-theme', onclick: () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark')});
  const dark = currentTheme() === 'dark', label = t(dark ? 'switchLight' : 'switchDark');
  button.append(icon(dark ? 'sun' : 'moon')); button.setAttribute('aria-label', label); button.title = label;
  return button;
}
addEventListener('mastan-theme', refreshTheme); matchMedia('(prefers-color-scheme:dark)').addEventListener('change', refreshTheme);
setTheme(document.documentElement.dataset.theme || 'dark');
for (const selector of ['#theme-toggle', '#side-theme-toggle']) $(selector).onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
$('#header-login').onclick = () => requireLogin();
function ring(facts) {
  boot.usage = facts; const button = $('#usage'); button.hidden = !facts;
  if (!facts) return;
  button.style.setProperty('--left', facts.percentLeft ?? 100); button.firstElementChild.textContent = facts.percentLeft == null ? '∞' : facts.percentLeft + '%';
  button.setAttribute('aria-label', `${t('allowance')}: ${facts.percentLeft ?? 100}% ${t('left')}`);
}
function setSubtitle(text) {
  $('#chat-subtitle').textContent = text;
}
function updateButton() {
  setNoticeBusy(opening || trialRunning || sessions.some(s => s.running));
  const running = authenticated ? sessions.find(s => s.id === current)?.running : trialRunning;
  setSubtitle(!navigator.onLine ? t('waitingNetwork') : connectionLost ? t('connecting') : running ? toolStatus.get(current) || t('working') : t('idle'));
  if (voice?.previewing() || voice?.active()) { $('#stop').hidden = true; return; }
  const hasContent = !!area.value.trim() || !!attachments?.files.length;
  const mode = 'send'; // No voice notes here yet: nothing on this server turns speech into text.
  if ($('#send').dataset.mode !== mode || !$('#send svg path')) $('#send').replaceChildren(icon(mode));
  $('#send').dataset.mode = mode;
  if (!$('#stop svg')) $('#stop').replaceChildren(icon('stop'));
  $('#send').setAttribute('aria-label', t(hasContent ? 'send' : 'record'));
  $('#stop').hidden = !running; $('#send').hidden = !!running && !hasContent;
}
function autosize() { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight, 213) + 'px'; }
function scrollBottom() {
  const last = list.lastElementChild;
  if (stick && last?.matches('.bubble')) {
    const space = list.clientHeight - last.offsetTop - last.offsetHeight;
    if (space > 1) list.style.paddingBlockStart = ((parseFloat(list.style.paddingBlockStart) || 0) + space) + 'px';
  }
  timeline.scrollTop = timeline.scrollHeight; programmaticTop = timeline.scrollTop;
}
function anchorHistory() {
  list.style.paddingBlockStart = '0px'; list.style.minHeight = '0';
  const css = getComputedStyle(timeline), space = timeline.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom) - list.getBoundingClientRect().height;
  list.style.minHeight = ''; list.style.paddingBlockStart = Math.max(0, space) + 'px'; scrollBottom();
}
new ResizeObserver(() => { if (stick) scrollBottom(); }).observe(timeline);
new ResizeObserver(() => { if (stick) scrollBottom(); }).observe(list);
function bottom(force = false) { if (!force && !stick) return; requestAnimationFrame(scrollBottom); }
function announce(message) { const node = h('span', {text: `${message.role === 'assistant' ? t('name') : t('you')}: ${message.text}`}); $('#announcer').append(node); while ($('#announcer').childElementCount > 6) $('#announcer').firstChild.remove(); }
function revealShell() { app.classList.remove('booting'); $('#composer').inert = false; }
function intro() {
  return h('div', {class: 'intro'}, h('img', {class: 'intro-avatar', src: '/static/mastan.png', alt: ''}), h('h1', {text: t('intro')}), h('p', {text: t('introLine')}), h('div', {class: 'starters'}, [['idea', 'ideaPrompt'], ['learn', 'learnPrompt'], ['plan', 'planPrompt']].map(([key, prompt]) => h('button', {onclick: () => { area.value = t(prompt); send(); }}, t(key), h('span', {text: '↗', 'aria-hidden': 'true'})))));
}
function hasLater(message, later) { return later.length > 0 || Number(message.id) < (sessions.find(s => s.id === message.sessionId)?.lastId || 0); }
function canRetry(message, later) { return authenticated && message.role === 'assistant' && ['failed', 'stopped'].includes(message.status) && !hasLater(message, later); }
function actionNodes(message, later) {
  if (hasLater(message, later)) {
    const answer = later.find(m => m.role === 'user')?.text.trim();
    return message.pause && !/^(yes|no)$/i.test(answer || '') ? [h('div', {class: 'message-choice', text: t('notAnswered')})] : [];
  }
  if (canRetry(message, later)) return [h('button', {class: 'message-action', text: t('retry'), onclick: () => retry(message)})];
  return message.pause ? [h('div', {class: 'message-actions'}, h('button', {class: 'message-action primary', text: t('yes'), onclick: () => { area.value = t('yes'); send(); }}), h('button', {class: 'message-action', text: t('no'), onclick: () => { area.value = t('no'); send(); }}))] : [];
}
function refreshActions() {
  const rows = allMessages();
  for (const el of list.querySelectorAll('[data-actions]')) {
    const index = rows.findIndex(m => String(m.id) === el.dataset.actions); if (index < 0) continue;
    const message = rows[index], later = rows.slice(index + 1); el.replaceChildren(...actionNodes(message, later));
    if (message.role === 'assistant' && message.status === 'failed' && hasLater(message, later)) updateText(el.parentElement.querySelector('.message-content'), t('replyUnfinished'));
  }
}
function mutateMessages(change) {
  const before = new Map([...list.querySelectorAll('.bubble')].map(el => [el.dataset.clientId || el.dataset.id, el.getBoundingClientRect().top]));
  change();
  if (stick) scrollBottom();
  if (stick || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  for (const el of list.querySelectorAll('.bubble')) {
    const top = before.get(el.dataset.clientId || el.dataset.id), delta = top - el.getBoundingClientRect().top;
    if (top !== undefined && Math.abs(delta) > .5 && Math.abs(delta) < timeline.clientHeight) el.animate([{transform: `translateY(${delta}px)`}, {transform: 'translateY(0)'}], {duration: 280, easing: 'cubic-bezier(.2,.9,.3,1)'});
  }
}
function bubble(message, previous, later = []) {
  const grouped = previous?.role === message.role && message.created - previous.created < 300_000 && dateLabel(previous.created) === dateLabel(message.created);
  const next = later[0], tail = !next || next.role !== message.role || next.created - message.created >= 300_000 || dateLabel(next.created) !== dateLabel(message.created);
  const el = h('article', {class: `bubble ${message.role} ${grouped ? '' : 'group-start'} ${tail ? 'tail' : ''} ${message.status === 'failed' ? 'failed' : ''}`, dir: 'auto', dataset: {id: String(message.id), clientId: message.clientId || ''}, tabindex: '0', 'aria-label': `${message.role === 'assistant' ? t('name') : t('you')}, ${fmtTime(message.created)}`});
  if (message.quoteId) {
    const quoted = getMessages().find(m => m.id === message.quoteId);
    el.append(h('button', {class: 'quote', onclick: () => list.querySelector(`[data-id="${message.quoteId}"]`)?.scrollIntoView({block: 'center'})}, h('b', {text: quoted?.role === 'user' ? t('you') : t('name')}), (quoted?.text || t('deletedMessage')).slice(0, 160)));
  }
  const content = h('div', {class: 'message-content'});
  if (message.files?.length) {
    // The lazy media module is ready before history is rendered.
    content.append(h('div', {class: 'message-media'}, media.fileNodes(message.files, media.showLightbox)));
  }
  el.historicalFailure = message.role === 'assistant' && message.status === 'failed' && hasLater(message, later);
  if (el.historicalFailure) content.append(markdown(t('replyUnfinished')));
  else if (message.text) content.append(messageBody(message.text, message.status));
  else if (message.status === 'running') content.append(h('div', {class: 'typing', role: 'status', 'aria-label': t('working')}, h('i'), h('i'), h('i')));
  el.append(content);
  if (message.pause || ['failed', 'stopped'].includes(message.status)) el.append(h('div', {dataset: {actions: String(message.id)}}, actionNodes(message, later)));
  const state = message.role === 'user' ? message.status === 'sending' ? '◷' : message.status === 'queued' ? '✓' : message.status === 'read' || message.status === 'done' ? '✓✓' : message.status === 'offline' ? '◷' : message.status === 'failed' ? '!' : '✓' : '';
  const metadata = h('span', {class: 'message-meta', dir: 'ltr'}, message.status === 'queued' ? h('span', {text: t('queued')}) : null, h('time', {datetime: new Date(message.created).toISOString(), text: fmtTime(message.created)}), state ? h('span', {class: 'ticks', text: state, 'aria-label': message.status}) : null);
  // Hide receipts until completion; only inline receipts reserve space.
  if (message.status === 'running') metadata.classList.add('reserved');
  placeMetadata(content, metadata);
  el.classList.toggle('typing-bubble', message.status === 'running' && !message.text && !message.files?.length);
  reserveBlock(el, message.text);
  el.message = {...message};
  el.oncontextmenu = event => { event.preventDefault(); messageMenu(el.message, event.clientX, event.clientY); };
  el.onkeydown = event => { if (event.key === 'F10' && event.shiftKey || event.key === 'ContextMenu') { event.preventDefault(); const r = el.getBoundingClientRect(); messageMenu(el.message, r.x + 20, r.y + 20); } };
  let press;
  el.addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse') press = setTimeout(() => messageMenu(el.message, event.clientX, event.clientY), 450); });
  for (const event of ['pointerup', 'pointermove', 'pointercancel']) el.addEventListener(event, () => clearTimeout(press), {passive: true});
  return el;
}
function placeMetadata(content, metadata) {
  const last = content.lastElementChild;
  metadata.classList.toggle('inline', !!last?.matches('p,blockquote'));
  // A real inline suffix wraps naturally if the final text line has no room.
  if (last?.matches('p,blockquote')) { last.append(' ', metadata); }
  else content.append(metadata);
}
function messageBody(text, status) {
  // The server appends this status to partial text, which may have an open fence.
  const stopped = status === 'stopped' && /(?:^|\n\n)Stopped\.$/.test(text);
  const body = stopped ? text.replace(/(?:^|\n\n)Stopped\.$/, '') : text;
  const fragment = markdown(body, {streaming: status === 'running'});
  if (stopped) fragment.append(h('div', {class: 'message-status', role: 'status', text: 'Stopped.'}));
  return fragment;
}
function updateText(content, text) {
  const growth = beforeGrowth(content.closest('.bubble'));
  const metadata = content.querySelector('.message-meta');
  const files = content.querySelector('.message-media');
  const el = content.closest('.bubble');
  reserveBlock(el, text);
  content.replaceChildren(...(files ? [files] : []), messageBody(text, el?.message?.status));
  if (metadata) placeMetadata(content, metadata);
  content.closest('.bubble')?.classList.remove('typing-bubble');
  afterGrowth(el, growth);
}
// FLIP the surface and counter-scale the text. Only transforms animate; layout runs once per chunk.
function beforeGrowth(el) {
  if (el?.message?.role !== 'assistant' || el.message.status !== 'running') return null;
  const from = el.getBoundingClientRect().width;
  el.style.setProperty('--stream-width', Math.max(parseFloat(getComputedStyle(el).width), el.streamWidth || 0) + 'px');
  return from;
}
function afterGrowth(el, from) {
  if (from === null) return;
  const width = parseFloat(getComputedStyle(el).width);
  el.streamWidth = Math.max(el.streamWidth || 0, width); el.style.setProperty('--stream-width', el.streamWidth + 'px');
  el.growth?.forEach(a => a.cancel());
  if (width - from < 1 || el.classList.contains('structured-block') || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const content = el.querySelector('.message-content'), options = {duration: 150, easing: 'cubic-bezier(.2,.7,.3,1)'};
  el.growth = [el.animate([{transform: `scaleX(${from / width})`}, {transform: 'scaleX(1)'}], options), content.animate([{transform: `scaleX(${width / from})`}, {transform: 'scaleX(1)'}], options)];
}
function reserveBlock(el, text) {
  // The same responsive width applies from the first fence/header through completion.
  if (/(?:^|\n)\s*(?:```|\|)|(?:^|\n)[^\n]+\|[^\n]*\n[ :|\-]+(?:\n|$)/.test(text || '')) el?.classList.add('structured-block');
}
function bubbleStamp(message, previous, later) {
  return JSON.stringify([message.id, message.clientId, message.role, message.text, message.status, message.created, message.files, message.quoteId, message.pause, previous?.id, previous?.role, previous?.created, later[0]?.id, later[0]?.role, later[0]?.created, hasLater(message, later), later.find(m => m.role === 'user')?.text]);
}
function reconcileBubble(el, message, previous, later) {
  const stamp = bubbleStamp(message, previous, later);
  if (renderedMessages.get(el) === stamp) return el;
  const growth = beforeGrowth(el), fresh = bubble(message, previous, later);
  if (!el) el = fresh;
  else {
    // Keep the article, media player and unchanged Markdown nodes alive across snapshots.
    const old = el.message;
    const content = el.querySelector('.message-content'), next = fresh.querySelector('.message-content');
    if (old.text === message.text && old.status === message.status && el.historicalFailure === fresh.historicalFailure && JSON.stringify(old.files) === JSON.stringify(message.files)) {
      const metadata = content.querySelector('.message-meta'); metadata?.remove();
      placeMetadata(content, next.querySelector('.message-meta'));
      next.replaceWith(content);
    } else if (JSON.stringify(old.files) === JSON.stringify(message.files)) {
      const files = content.querySelector('.message-media'); if (files) next.querySelector('.message-media')?.replaceWith(files);
    }
    if (el.classList.contains('structured-block')) fresh.classList.add('structured-block');
    el.className = fresh.className; Object.assign(el.dataset, fresh.dataset);
    el.setAttribute('aria-label', fresh.getAttribute('aria-label')); el.message = {...message}; el.historicalFailure = fresh.historicalFailure;
    el.replaceChildren(...fresh.childNodes);
  }
  afterGrowth(el, growth); renderedMessages.set(el, stamp); return el;
}
function allMessages() {
  const rows = [...getMessages(), ...optimistic.filter(m => m.sessionId === current || !authenticated && !m.sessionId)];
  const seen = new Set(); return rows.filter(m => m.status !== 'silent' && !seen.has(m.clientId || m.id) && seen.add(m.clientId || m.id)).sort((a, b) => Number(typingOnly(a)) - Number(typingOnly(b)) || a.created - b.created || (Number(a.id) || 0) - (Number(b.id) || 0));
}
const typingOnly = m => m.role === 'assistant' && m.status === 'running' && !m.text && !m.files?.length;
function render({older = false} = {}) {
  cancelAnimationFrame(renderFrame);
  const rows = allMessages().slice(older ? 0 : -160, older ? 160 : undefined), nodes = [];
  const same = renderedSession === current, existing = new Map(same ? [...list.querySelectorAll('.bubble')].map(el => [el.dataset.clientId || el.dataset.id, el]) : []);
  if (!same || older) list.style.paddingBlockStart = '';
  const days = new Map(same ? [...list.querySelectorAll('.day')].map(el => [el.dataset.day, el]) : []);
  if (more.get(current)) nodes.push(same && list.querySelector('.earlier') || h('button', {class: 'earlier', text: t('earlier'), onclick: loadOlder}));
  let day = null, previous = null;
  for (const [index, message] of rows.entries()) {
    const d = dateLabel(message.created); if (d !== day) { nodes.push(days.get(d) || h('div', {class: 'day', text: d, dataset: {day: d}})); day = d; }
    nodes.push(reconcileBubble(existing.get(message.clientId || String(message.id)), message, previous, rows.slice(index + 1))); previous = message;
  }
  const knownEmpty = authenticated ? current ? sessions.find(s => s.id === current)?.empty === true : sessions.length === 0 : cached.has('trial');
  if (!rows.length && knownEmpty) nodes.push(same && list.querySelector('.intro') || intro());
  mutateMessages(() => {
    const kept = new Set(nodes); for (const node of [...list.children]) if (!kept.has(node)) node.remove();
    nodes.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
  }); renderedSession = current; updateButton();
}
function replaceMessage(message) {
  messageVersions.set(message.id, ++messageVersion);
  const rows = cached.get(message.sessionId) || [], index = rows.findIndex(m => m.id === message.id || message.clientId && m.clientId === message.clientId);
  if (index >= 0) { if (message.role === 'user' && rows[index].status === 'read' && ['sent', 'queued'].includes(message.status)) message = {...message, status: 'read'}; rows[index] = {...rows[index], ...message}; } else rows.push(message);
  cached.set(message.sessionId, rows);
  if (message.clientId) optimistic = optimistic.filter(m => m.clientId !== message.clientId);
  if (message.sessionId !== current) return;
  const el = list.querySelector(`[data-id="${message.id}"]`) || (message.clientId && list.querySelector(`[data-client-id="${message.clientId}"]`));
  if (message.status === 'silent') { mutateMessages(() => { el?.remove(); refreshActions(); }); return; }
  if (el || stick) render();
  else mutateMessages(refreshActions);
  bottom();
}
function sideRender() {
  sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
  const animate = !app.classList.contains('booting') && (wide.matches || app.classList.contains('list-screen')) && listPainted;
  const container = $('#sessions'), old = new Map([...container.querySelectorAll('.session-item')].map((node, index) => [node.dataset.id, {node, index, top: node.getBoundingClientRect().top}]));
  for (const {node} of old.values()) node.getAnimations().forEach(animation => animation.cancel());
  const sorted = sessions.filter(s => !searching || s.match || s.title.toLowerCase().includes(searching.toLowerCase()) || s.last.toLowerCase().includes(searching.toLowerCase()));
  container.querySelector('.empty-side')?.remove();
  for (const [index, session] of sorted.entries()) {
    let button = old.get(session.id)?.node;
    if (button?.dataset.editing) continue;
    if (button && !button.querySelector('.session-name')) { button.remove(); button = null; }
    if (!button) {
      button = h('button', {class: 'session-item', dataset: {id: session.id}, onclick: () => openSession(session.id)});
      button.append(h('span', {class: 'session-avatar c' + ([...session.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5), 'aria-hidden': 'true'}), h('span', {class: 'session-body'}, h('span', {class: 'session-title-row'}, h('span', {class: 'session-name'}), h('time', {class: 'session-when'})), h('span', {class: 'session-preview'}, h('p'), h('span', {class: 'session-mark'}))));
    }
    button.setAttribute('aria-current', current === session.id ? 'true' : 'false'); button.title = session.title;
    button.querySelector('.session-avatar').textContent = [...session.title.trim()][0]?.toUpperCase() || 'M';
    button.querySelector('.session-name').replaceChildren(...highlighted(session.title, searching));
    button.querySelector('.session-when').textContent = session.empty ? '' : when(session.lastAt ?? session.updated);
    const draft = storage.get(storeKey('draft:' + session.id), '').trim(), preview = button.querySelector('.session-preview p');
    const snippet = searching && session.matchSnippet;
    const text = previewText(snippet || draft || (session.running ? t('working') : session.last || t('ready')));
    preview.previewSource = !snippet && draft ? [h('span', {class: 'draft-label', text: t('draft') + ': '}), ...highlighted(text, searching)] : highlighted(text, searching);
    fitPreview(preview); previewSizes.observe(preview);
    const mark = button.querySelector('.session-mark');
    const badge = session.id !== current && session.unread;
    mark.className = 'session-mark ' + (session.running ? 'working-dot' : badge ? 'badge' : session.pinned ? 'pin' : '');
    mark.replaceChildren(...(session.running ? [] : badge ? [badge > 999 ? '999+' : String(badge)] : session.pinned ? [icon('pin')] : []));
    mark.setAttribute('aria-label', session.running ? t('working') : session.pinned ? t('pin') : '');
    button.oncontextmenu = event => { event.preventDefault(); sessionMenu(session, event.clientX, event.clientY); };
    button.onkeydown = event => { if (event.shiftKey && event.key === 'F10') { event.preventDefault(); const r = button.getBoundingClientRect(); sessionMenu(session, r.x + 100, r.y); } };
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
  }
  const kept = new Set(sorted.map(s => s.id)); for (const {node} of old.values()) if (!kept.has(node.dataset.id)) node.remove();
  if (!sorted.length) container.append(h('div', {class: 'empty-side', text: searching ? t('noResults') : t('emptyList')}));
  if (animate && !matchMedia('(prefers-reduced-motion:reduce)').matches) for (const [index, node] of [...container.querySelectorAll('.session-item')].entries()) {
    const from = old.get(node.dataset.id); if (!from || from.index === index) continue;
    node.getAnimations().forEach(animation => animation.cancel());
    node.animate([{transform: `translateY(${from.top - node.getBoundingClientRect().top}px)`}, {transform: 'translateY(0)'}], {duration: 280, easing: 'cubic-bezier(.2,.9,.3,1.1)'});
  }
  const session = sessions.find(s => s.id === current); $('#chat-title').textContent = session?.title || t('name'); updateButton(); tasksBar();
}
function highlighted(text, term) {
  if (!term) return [text];
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  return at < 0 ? [text] : [text.slice(0, at), h('mark', {text: text.slice(at, at + term.length)}), ...highlighted(text.slice(at + term.length), term)];
}
function fitPreview(preview) {
  if (!preview.previewSource) return;
  preview.replaceChildren(...preview.previewSource.map(part => typeof part === 'string' ? part : part.cloneNode(true)));
  if (!preview.clientWidth || preview.scrollWidth <= preview.clientWidth) return;
  // Trim to the visible line before adding one ellipsis, preserving search marks and the draft label.
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT), nodes = []; let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const text = preview.textContent, range = document.createRange();
  const point = at => { for (const n of nodes) { if (at <= n.length) return [n, at]; at -= n.length; } return [preview, preview.childNodes.length]; };
  const measure = document.createElement('canvas').getContext('2d'); measure.font = getComputedStyle(preview).font;
  const available = preview.clientWidth - measure.measureText('…').width;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); range.setStart(preview, 0); range.setEnd(...point(mid)); if (range.getBoundingClientRect().width <= available) lo = mid; else hi = mid - 1; }
  const end = text.slice(0, lo).trimEnd().replace(/[.…]+$/, '').length;
  range.setStart(...point(end)); range.setEnd(preview, preview.childNodes.length); range.deleteContents(); preview.append('…');
}
function acceptSession(item, requestedAt = Infinity) {
  if (deletedSessions.has(item.id) && requestedAt !== Infinity) return;
  if ((sessionVersions.get(item.id) || 0) > requestedAt) return;
  if (requestedAt === Infinity) sessionVersions.set(item.id, ++messageVersion);
  deletedSessions.delete(item.id);
  const found = sessions.find(s => s.id === item.id);
  if (found) Object.assign(found, item); else sessions.push(item);
  if (!item.running) toolStatus.delete(item.id);
}
function removeSession(sid) {
  sessionVersions.set(sid, ++messageVersion); deletedSessions.add(sid);
  if (renaming?.id === sid) renaming.finish(false);
  sessions = sessions.filter(s => s.id !== sid); cached.delete(sid);
  if (current === sid) { switching++; clearTimeout(openingTimer); opening = false; delete $('#chat').dataset.historyLoading; voice?.cancel(false); current = null; showList(false); render(); }
  sideRender();
}
async function loadSessions() {
  const requestedAt = messageVersion, rows = await api('/api/sessions');
  // An absent row may predate a create/send. Only a delete event or a confirmed 404 removes it.
  const ids = new Set(rows.map(s => s.id));
  for (const item of sessions.filter(s => !ids.has(s.id))) void api(`/api/sessions/${item.id}/messages?latest=1`).catch(error => {
    if (error.status === 404 && (sessionVersions.get(item.id) || 0) <= requestedAt) removeSession(item.id);
  });
  for (const row of rows) acceptSession(row, requestedAt);
  sideRender();
}
let paneMotionTimer, listPainted = false, screenVersion = 0;
function paneMoving() {
  if (wide.matches || app.classList.contains('booting') || !swipe?.axis && matchMedia('(prefers-reduced-motion:reduce)').matches) {
    app.classList.remove('pane-moving'); clearTimeout(paneMotionTimer); return;
  }
  app.classList.add('pane-moving'); clearTimeout(paneMotionTimer);
  paneMotionTimer = setTimeout(() => { if (!swipe) app.classList.remove('pane-moving'); }, 340);
}
function setScreen(isList) {
  screenVersion++;
  if (app.classList.contains('list-screen') !== (isList && !wide.matches)) paneMoving();
  app.classList.toggle('list-screen', isList && !wide.matches);
  $('#chat').inert = isList && !wide.matches; sidebar.inert = !isList && !wide.matches;
  const notices = $('#toasts');
  if (isList && !wide.matches) sidebar.insertBefore(notices, $('#session-hints'));
  else if (notices.parentElement !== $('#composer-wrap')) $('#composer-wrap').prepend(notices);
  if (isList || wide.matches) requestAnimationFrame(() => { listPainted = true; });
}
function saveDraft() { const key = storeKey('draft:' + (current || 'trial')); if (area.value) storage.set(key, area.value); else storage.remove(key); }
function showList(push = true) {
  leaveWorkspace();
  voice?.cancel(false);
  markRead(); saveDraft(); sideRender(); setScreen(true); if (push) history.pushState({list: true}, '', '/chat');
  if (!wide.matches) { $('#message').blur(); $(`#sessions [data-id="${current}"]`)?.focus({preventScroll: true}); }
}
async function openSession(sid, {push = true} = {}) {
  leaveWorkspace();
  renaming?.finish(true); closeTop();
  markRead(); clearTimeout(openingTimer); opening = true; setNoticeBusy(true); toolStatus.delete(sid);
  saveDraft(); voice?.cancel(false); attachments?.clear(); quote = null; $('#reply-tray').hidden = true;
  scrollDate.classList.remove('visible'); clearTimeout(dateTimer); userScrollUntil = 0;
  current = sid; stick = true; clearUnread();
  const hasHistory = cached.has(sid);
  if (!hasHistory) { $('#chat').dataset.historyLoading = sid; if (app.classList.contains('booting')) setScreen(true); }
  const mine = ++switching;
  const screen = screenVersion;
  if (push) history.pushState({session: sid, fromList: !!history.state?.list}, '', '/chat/s/' + sid);
  area.value = storage.get(storeKey('draft:' + sid), ''); autosize(); sideRender();
  if (hasHistory) { render(); if (allMessages().length) anchorHistory(); delete $('#chat').dataset.historyLoading; setScreen(false); }
  revealShell();
  const requestedAt = messageVersion;
  try {
    const out = await api(`/api/sessions/${sid}/messages`);
    cached.set(sid, mergeSnapshot(out.messages, cached.get(sid) || [], messageVersions, requestedAt));
    acceptSession(out.session, requestedAt); more.set(sid, out.more);
    sideRender();
    if (mine !== switching || screenVersion !== screen && app.classList.contains('list-screen')) return;
    // Merge events that arrived after the request began.
    render(); if (!hasHistory && allMessages().length) anchorHistory(); delete $('#chat').dataset.historyLoading; scrollBottom(); setScreen(false);
    const firstUnread = out.session.firstUnread && list.querySelector(`[data-id="${out.session.firstUnread}"]`);
    if (firstUnread && out.session.unread > 1) { firstUnread.scrollIntoView({block: 'start'}); stick = false; } else bottom(true);
    markRead(); if (!coarse.matches) area.focus({preventScroll: true});
  } catch (e) {
    if (e.status === 404) {
      const active = mine === switching && current === sid;
      if ((sessionVersions.get(sid) || 0) <= requestedAt) removeSession(sid);
      if (active && wide.matches && sessions[0]) await openSession(sessions[0].id, {push: false});
    } else if (mine === switching) toast(e.message);
  }
  finally { if (mine === switching) { delete $('#chat').dataset.historyLoading; openingTimer = setTimeout(() => { opening = false; updateButton(); }, 280); } }
}
async function ensureSession() {
  if (current) return current;
  if (!creatingSession) creatingSession = api('/api/sessions', {method: 'POST', body: {}}).then(session => {
    acceptSession(session); current = session.id; sideRender(); history.replaceState({session: current}, '', '/chat/s/' + current); return current;
  }).finally(() => { creatingSession = null; });
  return creatingSession;
}
async function newSession() {
  if (!authenticated) return requireLogin();
  voice?.cancel(false);
  if (!creatingSession) creatingSession = api('/api/sessions', {method: 'POST', body: {}}).finally(() => { creatingSession = null; });
  const session = await creatingSession;
  acceptSession(session);
  await openSession(session.id);
}
async function loadOlder() {
  const sid = current, first = getMessages()[0]; if (!sid || !first || loadingHistory.has(sid)) return;
  loadingHistory.add(sid); stick = false;
  const anchor = [...list.querySelectorAll('.bubble')].find(el => el.getBoundingClientRect().bottom > timeline.getBoundingClientRect().top + 4);
  const anchorId = anchor?.dataset.id, offset = anchor?.getBoundingClientRect().top;
  try { const out = await api(`/api/sessions/${sid}/messages?before=${first.id}`); if (sid !== current) return;
    const seen = new Map([...out.messages, ...getMessages()].map(m => [m.id, m])); cached.set(sid, [...seen.values()].sort((a, b) => a.id - b.id).slice(0, 160)); more.set(sid, out.more);
    timeline.style.overflowAnchor = 'none'; render({older: true});
    const kept = anchorId && list.querySelector(`[data-id="${anchorId}"]`); if (kept) timeline.scrollTop += kept.getBoundingClientRect().top - offset;
    requestAnimationFrame(() => { timeline.style.overflowAnchor = ''; });
  } catch (e) { toast(e.message); } finally { loadingHistory.delete(sid); }
}
// Previews stay plain; full messages keep their Markdown rendering and copy text.
function previewText(value) {
  return String(value || '')
    .replace(/^[\t ]*(?:`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\t ]*(?:>[\t ]*)+/gm, '')
    .replace(/^[\t ]*(?:#{1,6}[\t ]+|(?:[-+*•]|\d+[.)])[\t ]+)(?:\[[ xX]\][\t ]*)?/gm, '')
    .replace(/^[\t :|*-]*[-*][\t :|*-]*$/gm, '')
    .replace(/[`*_~]/g, '').replace(/\|/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function replyTo(message) { quote = message; $('#reply-tray').hidden = false; $('#reply-tray').replaceChildren(h('div', null, h('b', {text: message.role === 'user' ? t('you') : t('name')}), previewText(message.text).slice(0, 180)), h('button', {class: 'icon', 'aria-label': t('cancel'), onclick: cancelReply}, icon('close'))); area.focus(); }
function cancelReply() { quote = null; $('#reply-tray').hidden = true; }
function messageMenu(message, x, y) {
  const items = [{label: t('reply'), image: 'reply', action: () => replyTo(message)}, {label: t('copy'), image: 'copy', action: () => navigator.clipboard.writeText(message.text).then(() => toast(t('copied')))}];
  if (canRetry(message, allMessages().slice(allMessages().findIndex(m => m.id === message.id) + 1))) items.push({label: t('retry'), image: 'retry', action: () => retry(message)});
  if (authenticated) items.push({label: t('delete'), image: 'trash', danger: true, action: () => api(`/api/sessions/${current}/messages/${message.id}`, {method: 'DELETE'})});
  menuAt(x, y, items, {anchor: list.querySelector(`[data-id="${message.id}"]`)});
}
async function retry(message) { await api(`/api/sessions/${current}/retry`, {method: 'POST', body: {id: message.id}}); }
function sessionMenu(session, x, y) {
  menuAt(x, y, [{label: t('rename'), image: 'edit', action: () => rename(session)}, {label: t('freshSessionItem'), image: 'retry', action: () => slash('/new')}, {label: t(session.pinned ? 'unpin' : 'pin'), image: 'pin', action: async () => { const out = await api(`/api/sessions/${session.id}`, {method: 'PATCH', body: {pinned: !session.pinned}}); if (!deletedSessions.has(session.id)) acceptSession(out); sideRender(); }}, {label: t('deleteSession'), image: 'trash', danger: true, action: () => deleteSession(session)}]);
}
function rename(session) {
  renaming?.finish(true);
  if (!wide.matches && !app.classList.contains('list-screen')) showList();
  const button = $(`#sessions [data-id="${session.id}"]`), target = button?.querySelector('.session-name');
  if (!target) { searching = ''; $('#search').value = ''; sideRender(); if ($('#sessions [data-id="' + session.id + '"]')) return rename(session); return; }
  const input = h('input', {class: 'rename-input', value: session.title, 'aria-label': t('rename'), maxlength: '70'});
  const container = h('div', {class: 'session-item', dataset: {id: session.id, editing: 'true'}}, input);
  let finished = false;
  const finish = commit => {
    if (finished) return; finished = true;
    const title = input.value.trim();
    // Restore synchronously, before blur, an SSE event or a PATCH response can render this row.
    container.replaceWith(button); renaming = null; sideRender();
    if (commit && title && title !== session.title) void api('/api/sessions/' + session.id, {method: 'PATCH', body: {title}})
      .then(out => { if (!deletedSessions.has(session.id)) { acceptSession(out); sideRender(); } }).catch(e => toast(e.message));
  };
  renaming = {id: session.id, finish};
  button.replaceWith(container); input.focus(); input.select();
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(e.key === 'Enter'); button.focus({preventScroll: true}); } };
  input.onblur = () => finish(true);
}
async function deleteSession(session) {
  const wasCurrent = current === session.id;
  await api('/api/sessions/' + session.id, {method: 'DELETE'}); deletedSessions.add(session.id); sessionVersions.set(session.id, ++messageVersion); sessions = sessions.filter(s => s.id !== session.id); cached.delete(session.id); sideRender();
  toast(t('deleted'), {duration: 6000, action: async () => { const restored = await api(`/api/sessions/${session.id}/undo`, {method: 'POST', body: {}}); acceptSession(restored); sideRender(); }});
  if (wasCurrent && (!current || current === session.id)) { current = null; if (wide.matches && sessions[0]) await openSession(sessions[0].id); else { render(); showList(); } }
}
async function requireLogin() {
  if (authenticated) return;
  location.replace('/login');
}
function persistQueue() { storage.set(storeKey('outbox'), queue); }
function send() {
  const text = area.value.trim(), files = attachments?.take() || [];
  if (!text && !files.length) return;
  if (authenticated && !files.length && /^\/(?:new|thread)(?:\s|$)/i.test(text)) { area.value = ''; saveDraft(); autosize(); updateButton(); void slash(text).catch(e => toast(e.message)); return; }
  if (!authenticated && trialReserved >= 3) return requireLogin();
  const clientId = id(), sid = current, sentAt = Date.now(), quoteId = quote?.id || null;
  const message = {id: clientId, clientId, sessionId: sid, role: 'user', text, files: files.map(f => ({name: f.file.name, size: f.file.size, mime: f.file.type, local: f.local, duration: f.file.duration, waveform: f.file.waveform})), quoteId, created: sentAt, status: navigator.onLine ? 'sending' : 'offline'};
  const previous = allMessages().filter(m => !typingOnly(m)).at(-1);
  optimistic.push(message); const session = sessions.find(s => s.id === sid);
  if (session) { Object.assign(session, {empty: false, last: text || files[0]?.file.name || '', lastAt: sentAt, updated: sentAt}); sessionVersions.set(sid, ++messageVersion); }
  lastSent = text; area.value = ''; saveDraft(); sideRender(); autosize(); cancelReply(); stick = true;
  list.querySelector('.intro')?.remove();
  if (!previous || dateLabel(previous.created) !== dateLabel(message.created)) list.append(h('div', {class: 'day', text: dateLabel(message.created)}));
  mutateMessages(() => { list.insertBefore(bubble(message, previous), list.querySelector('.typing-bubble')); if (previous?.role === message.role && message.created - previous.created < 300_000) list.querySelector(`[data-id="${previous.id}"]`)?.classList.remove('tail'); refreshActions(); }); updateButton();
  while (list.querySelectorAll('.bubble').length > 160) list.querySelector('.bubble').remove();
  bottom(true); // Append one bubble synchronously, before storage or network work.
  if (!coarse.matches) area.focus({preventScroll: true});
  if (!authenticated) { trialReserved++; trialTail = trialTail.then(() => trialSend(message)); return; }
  const item = {sessionId: sid, clientId, text, quoteId, files: [], created: sentAt, waiting: !!files.length};
  queue.push(item); persistQueue();
  void (async () => {
    if (!item.sessionId) item.sessionId = await ensureSession();
    message.sessionId = item.sessionId;
    if (files.length) {
      const {queuedFiles} = await import('./media.js');
      await queuedFiles.put(storeKey('files:' + clientId), files.map(f => f.file));
      const promise = Promise.all(files.map(f => f.promise)); pendingUploads.set(clientId, promise);
      const uploaded = await promise; pendingUploads.delete(clientId);
      if (uploaded.every(Boolean)) { item.files = uploaded.map((id, i) => ({id, ...media.audioMetadata(files[i].file)})); item.waiting = false; }
    }
    persistQueue(); void flush();
  })().catch(e => { message.status = 'failed'; render(); toast(e.message); });
}
// Same as Telegram: /new starts a fresh agent session in this conversation, /thread <name> opens a new conversation.
async function slash(text) {
  const [, command, name = ''] = /^\/(\w+)\s*(.*)$/s.exec(text);
  if (command.toLowerCase() === 'new' && !name) { await api('/api/chat/new', {method: 'POST', body: {thread: Number(current)}}); toast(t('freshSession')); return; }
  const session = await api('/api/sessions', {method: 'POST', body: {title: name || t('newSession')}});
  acceptSession(session); await openSession(session.id);
}
function tasksBar() {
  const bar = $('#task-bar'), tasks = sessions.find(s => s.id === current)?.tasks || [];
  bar.hidden = !tasks.length;
  bar.replaceChildren(...tasks.map(task => h('span', null, h('b', {text: `${task.id}. ${task.title}`, title: task.title}), task.status, h('button', {text: t('stop'), onclick: () => api('/api/chat/stop', {method: 'POST', body: {thread: Number(current), task: task.id}}).catch(e => toast(e.message))}))));
}
async function trialSend(message) {
  trialRunning = true; updateButton();
  const waiting = {id: id(), role: 'assistant', text: '', status: 'running', created: Date.now() + 1};
  const rows = getMessages('trial'); rows.push({...message, status: 'done'}, waiting); cached.set('trial', rows); optimistic = optimistic.filter(m => m.clientId !== message.clientId); render(); bottom(true);
  try {
    const response = await fetch('/api/trial', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', Accept: 'application/x-ndjson'}, body: JSON.stringify({text: message.text, clientId: message.clientId})});
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', out = {};
    while (true) {
      const {done, value} = await reader.read(); if (done) break; buffer += decoder.decode(value, {stream: true});
      let cut; while ((cut = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
        if (event.type === 'delta') { waiting.text = event.text; const el = list.querySelector(`[data-id="${waiting.id}"] .message-content`); if (el) mutateMessages(() => { updateText(el, event.text); }); bottom(); }
        else out = event;
      }
    }
    if (out.text) { waiting.text = out.text; waiting.status = out.stopped ? 'stopped' : 'done'; announce(waiting); } else rows.splice(rows.indexOf(waiting), 1);
    trialRunning = false; render(); bottom(true); if (out.login) await requireLogin();
  } catch (e) { waiting.text = e.message; waiting.status = 'failed'; render(); } finally { trialRunning = false; updateButton(); }
}
async function flush() {
  if (flushing || !authenticated || !navigator.onLine) return;
  flushing = true;
  try {
    while (queue.length) {
      const item = queue[0];
      if (!item.sessionId) { try { item.sessionId = await ensureSession(); const local = optimistic.find(m => m.clientId === item.clientId); if (local) local.sessionId = item.sessionId; persistQueue(); } catch { setTimeout(() => void flush(), 4000); break; } }
      if (pendingUploads.has(item.clientId)) break;
      if (item.waiting) {
        try {
          const {queuedFiles} = await import('./media.js'), files = await queuedFiles.get(storeKey('files:' + item.clientId));
          if (!files.length) throw new Error(t('uploadFailed'));
          const uploaded = await Promise.all(files.map(file => attachments.upload({file, progress: 0}, item.sessionId)));
          if (uploaded.some(v => !v)) throw new Error(t('uploadFailed'));
          item.files = uploaded.map((id, i) => ({id, ...media.audioMetadata(files[i])})); item.waiting = false; persistQueue();
        } catch { setTimeout(() => void flush(), 4000); break; }
      }
      try {
        const out = await api(`/api/sessions/${item.sessionId}/messages`, {method: 'POST', body: {text: item.text, clientId: item.clientId, quoteId: item.quoteId, files: item.files}});
        replaceMessage(out); queue.shift(); persistQueue();
        void import('./media.js').then(({queuedFiles}) => queuedFiles.remove(storeKey('files:' + item.clientId))).catch(() => {});
      } catch (e) {
        if (e.status === 401) { authenticated = false; await requireLogin(); break; }
        if (e.status && e.status !== 429 && e.status < 500) { queue.shift(); persistQueue(); const local = optimistic.find(m => m.clientId === item.clientId); if (local) { local.status = 'failed'; render(); } toast(e.message); continue; }
        setTimeout(() => void flush(), 3000); break;
      }
    }
  } finally { flushing = false; }
}
function connect(cursor = 0) {
  source?.close(); let last = storage.get(storeKey('event'), cursor);
  source = new EventSource('/api/events?after=' + last);
  const event = (type, fn) => source.addEventListener(type, e => { const n = Number(e.lastEventId); if (n <= last) return; const data = JSON.parse(e.data); fn(data); last = n; storage.set(storeKey('event'), n); });
  source.addEventListener('reset', e => { last = Number(e.lastEventId) || 0; storage.set(storeKey('event'), last); cached.clear(); void loadSessions(); void refreshCurrent(); for (const type of ['board', 'atlas']) window.dispatchEvent(new Event('mastan-' + type)); });
  event('session', item => { acceptSession(item); sideRender(); });
  event('session-deleted', item => removeSession(item.id));
  event('message', message => {
    const wasRunning = (cached.get(message.sessionId) || []).find(m => m.id === message.id)?.status === 'running';
    if (message.role === 'assistant' && !message.notification && ['done', 'failed', 'stopped', 'paused', 'silent'].includes(message.status)) {
      const session = sessions.find(s => s.id === message.sessionId); if (session) session.running = false; sessionVersions.set(message.sessionId, ++messageVersion);
      toolStatus.delete(message.sessionId); sideRender();
    }
    replaceMessage(message);
    updateButton();
    if (message.role === 'assistant' && message.status !== 'running' && message.sessionId === current && !app.classList.contains('list-screen') && !document.hidden) markRead();
    if (message.role === 'assistant' && message.status === 'done') {
      announce(message);
      if (message.sessionId === current && (!stick || app.classList.contains('list-screen') || document.hidden) && !countedReplies.has(message.id)) { countedReplies.add(message.id); unread++; $('#jump').hidden = false; $('#jump b').hidden = false; $('#jump b').textContent = unread > 999 ? '999+' : unread; }
      if (document.hidden) { document.title = `(${++titleUnread}) ${t('name')}`; if (!boot?.pushKey && globalThis.Notification?.permission === 'granted') new Notification(t('replyNotice'), {body: message.text.slice(0, 120), icon: '/static/mastan.png', tag: message.sessionId}); }
      if (!notificationOffered && (message.notification || wasRunning && Date.now() - message.created > 15_000)) offerNotifications(message.notification);
    }
  });
  source.addEventListener('delta', e => {
    const data = JSON.parse(e.data);
    const rows = cached.get(data.sessionId) || []; const found = rows.find(m => m.id === data.id); if (!found || found.status !== 'running') return; if (found) { found.text = data.text; messageVersions.set(found.id, ++messageVersion); }
    toolStatus.delete(data.sessionId);
    if (data.sessionId === current) { updateButton(); cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(() => { const el = list.querySelector(`[data-id="${data.id}"]`); if (el) { updateText(el.querySelector('.message-content'), data.text); el.message = {...found}; const all = allMessages(), at = all.findIndex(m => m.id === data.id); renderedMessages.set(el, bubbleStamp(found, all[at - 1], all.slice(at + 1))); if (stick) scrollBottom(); } }); }
  });
  event('status', data => { toolStatus.set(data.sessionId, /(?:web_search|WebSearch)/.test(data.text) ? t('searchingWeb') : /(?:mcp__|Working \()/.test(data.text) ? t('working') : data.text || t('working')); if (data.sessionId === current) updateButton(); });
  event('message-deleted', data => { const rows = cached.get(data.sessionId) || []; const found = rows.find(m => m.id === data.id); if (!found || found.status !== 'running') return; if (found) { found.text = t('deletedMessage'); found.files = []; found.status = 'deleted'; replaceMessage(found); } });
  event('usage', ring);
  for (const type of ['board', 'atlas']) event(type, () => window.dispatchEvent(new Event('mastan-' + type)));
  source.onopen = () => { connectionLost = false; updateButton(); void flush(); void loadSessions().catch(() => {}); void refreshCurrent(); };
  source.onerror = () => {
    connectionLost = true; updateButton();
    if (navigator.onLine) void api('/api/bootstrap').then(state => { if (!state.authenticated && authenticated) { source?.close(); cached.clear(); sessions = []; current = null; optimistic = []; authenticated = false; storage.remove('last-boot'); void start().then(requireLogin); } }).catch(() => {});
  };
}
async function refreshCurrent() {
  const sid = current; if (!sid) return; const requestedAt = messageVersion;
  try { const out = await api(`/api/sessions/${sid}/messages?latest=1`); if (current !== sid) return; cached.set(sid, mergeSnapshot(out.messages, cached.get(sid) || [], messageVersions, requestedAt)); more.set(sid, out.more); acceptSession(out.session, requestedAt); sideRender(); render(); bottom(); markRead(); } catch {}
}
function markRead() {
  if (!current || document.hidden || !authenticated || app.classList.contains('list-screen')) return;
  const sid = current, session = sessions.find(s => s.id === sid), last = getMessages().at(-1);
  const read = Math.max(typeof last?.id === 'number' ? last.id : 0, session?.lastId || 0);
  if (!read || (readThrough.get(sid) || 0) >= read) return;
  readThrough.set(sid, read);
  if (session) { session.unread = 0; session.firstUnread = null; }
  void api('/api/sessions/' + sid, {method: 'PATCH', body: {read}}).catch(() => { readThrough.delete(sid); });
}
function offerNotifications(work = false) {
  notificationOffered = true;
  notificationHint(boot?.pushKey, work);
}
async function details() {
  const session = sessions.find(s => s.id === current); if (!session) return;
  const pane = $('#details-pane'); pane.hidden = !pane.hidden; if (pane.hidden) return;
  pane.replaceChildren(h('button', {class: 'icon', 'aria-label': t('close'), onclick: () => { pane.hidden = true; }}, icon('close')), h('img', {class: 'avatar', src: '/static/mastan.png', alt: ''}), h('h2', {text: session.title}), h('p', {text: t('detailsLine')}), h('div', {class: 'details-actions'}, h('button', {class: 'text-button', text: t('rename'), onclick: () => { pane.hidden = true; rename(session); }}), h('button', {class: 'text-button danger', text: t('deleteSession'), onclick: () => { pane.hidden = true; void deleteSession(session); }})));
}
async function start(wanted = null) {
  source?.close(); renaming?.finish(false);
  const workspacePath = /^\/(board|atlas)$/.exec(location.pathname)?.[1];
  const accountWanted = location.pathname === '/account';
  const rootWanted = location.pathname === '/chat';
  const priorWorkspace = storage.get((storage.get('last-boot')?.accountKey || accountKey) + ':workspace-tab');
  const installedRoot = matchMedia('(display-mode:standalone)').matches && location.pathname === '/chat';
  try { boot = await api('/api/bootstrap'); storage.set('last-boot', boot); cachedBoot = false; }
  catch (error) { boot = storage.get('last-boot'); if (!boot?.authenticated) throw error; cachedBoot = true; connectionLost = true; }
  setBrandName(boot.brand?.name);
  const brand = $('.brand'); if (brand.firstChild) brand.firstChild.textContent = t('name');
  area.placeholder = t('placeholder'); area.setAttribute('aria-label', t('placeholder')); document.title = t('name');
  applyBrandColors();
  if (/^\/[a-zA-Z0-9_./-]+$/.test(boot.brand?.avatar || '')) document.querySelectorAll('img.avatar,img.intro-avatar').forEach(img => { img.src = boot.brand.avatar; });
  authenticated = boot.authenticated; area.maxLength = authenticated ? 20000 : 2000; accountKey = boot.accountKey || 'trial';
  $('#header-login').hidden = authenticated;
  app.classList.toggle('workspace-enabled', !!(authenticated && boot.workspace));
  if (authenticated && boot.workspace && !sidebar.querySelector('.workspace-nav')) sidebar.querySelector('.side-head').insertBefore(workspaceNav(), sidebar.querySelector('.brand'));
  sidebar.querySelector('.workspace-nav')?.toggleAttribute('hidden', !boot.workspace);
  markWorkspace('chat');
  sessions = boot.sessions; app.classList.toggle('trial-mode', !authenticated); sidebar.hidden = !authenticated;
  // An email alert from Telegram: this opens the conversation holding that email.
  const alert = /^\/chat\/mail\/([a-f0-9]{24})$/.exec(location.pathname)?.[1];
  if (alert) {
    try { const opened = await api(`/api/mail/${alert}/open`, {method: 'POST', body: {}}); acceptSession(opened); wanted = opened.id; }
    catch (e) { toast(e.message); }
    history.replaceState({list: true}, '', '/chat');
  }
  $('#details-pane').hidden = true;
  for (const selector of ['#back', '#details', '#chat-menu']) $(selector).hidden = !authenticated;
  $('#details').hidden = !authenticated || !wide.matches;
  $('#back').hidden = !authenticated || wide.matches; $('#trial-label').hidden = true;
  $('#composer-foot').textContent = '';
  ring(boot.usage);
  $('#whatsapp-down').hidden = !boot.whatsappDown; $('#whatsapp-down').textContent = t('whatsappDown');
  if (!attachments) {
    media = await import('./media.js');
    attachments = new media.Attachments({authenticated: () => authenticated, requireLogin, session: ensureSession, limits: boot.limits});
  }
  if (authenticated) {
    sidebar.animate?.([{opacity: 0, transform: 'translateX(-20px)'}, {opacity: 1, transform: 'translateX(0)'}], {duration: matchMedia('(prefers-reduced-motion:reduce)').matches ? 0 : 280, easing: 'cubic-bezier(.2,.9,.3,1.1)'});
    queue = storage.get(storeKey('outbox'), []);
    optimistic = await Promise.all(queue.map(async item => {
      let files = [];
      if (item.waiting || item.files?.length) try {
        files = (await media.queuedFiles.get(storeKey('files:' + item.clientId))).map(file => ({name: file.name, size: file.size, mime: file.type, local: URL.createObjectURL(file), ...media.audioMetadata(file)}));
      } catch { /* The text queue remains usable if browser file storage is unavailable. */ }
      return {...item, id: item.clientId, role: 'user', files, status: 'offline'};
    }));
    sideRender(); const sid = wanted || boot.promoted || /^\/chat\/s\/([A-Za-z0-9_-]+)$/.exec(location.pathname)?.[1] || (boot.workspace && workspacePath && sessions.some(s => s.id === storage.get(storeKey('workspace-session'))) ? storage.get(storeKey('workspace-session')) : null) || sessions[0]?.id;
    const initial = !history.state?.session && !history.state?.list;
    if (initial) history.replaceState({list: true}, '', '/chat');
    if (!boot.operator) await Promise.race([startApprovals($('#approvals')), new Promise(done => setTimeout(done, 400))]); // A slow gate must never hold the composer.
    if (sid) await openSession(sid, {push: initial}); else { current = null; render(); revealShell(); if (!wide.matches) showList(false); }
    connect(boot.cursor); void flush();
    // A draft handed over by another page (the atlas "Ask" button).
    try { const handed = sessionStorage.getItem('mm-chat-draft'); if (handed) { sessionStorage.removeItem('mm-chat-draft'); await newSession(); area.value = handed; saveDraft(); autosize(); updateButton(); area.focus(); } } catch {}
    if (installedRoot && !wanted && !boot.promoted) { showList(false); history.replaceState({list: true}, '', '/chat'); }
    const workspaceWanted = workspacePath || (!wanted && !boot.promoted && rootWanted ? priorWorkspace : null);
    if (boot.workspace && ['board', 'atlas'].includes(workspaceWanted)) await showWorkspace(workspaceWanted, {push: false});
    if (accountWanted) void openAccount();
    accountHints(accountKey);
  } else {
    current = null; trialReserved = boot.trial.filter(m => m.role === 'user').length; cached.set('trial', boot.trial); render(); revealShell(); bottom(true); setScreen(false); area.value = storage.get('trial:draft:trial', ''); autosize();
    if (accountWanted || !boot.trialAvailable) await requireLogin(); else area.focus({preventScroll: true});
  }
}
addEventListener('mastan-composer', updateButton);
area.oninput = () => { saveDraft(); autosize(); updateButton(); sideRender(); };
area.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !coarse.matches && !event.isComposing) { event.preventDefault(); send(); }
  if (event.key === 'ArrowUp' && !area.value && lastSent) { event.preventDefault(); area.value = lastSent; autosize(); updateButton(); }
  if (event.key === 'Escape') cancelReply();
};
$('#send').onclick = () => { if (area.value.trim() || attachments?.files.length) send(); else area.focus(); };
$('#stop').onclick = () => { void api(authenticated ? `/api/sessions/${current}/stop` : '/api/trial/stop', {method: 'POST', body: {}}).catch(e => toast(e.message)); };
$('#emoji').onclick = () => import('./emoji.js').then(({picker}) => picker({button: $('#emoji'), area, onInput: () => area.dispatchEvent(new Event('input'))})).catch(error => toast(error.message));
$('#attach').onclick = () => { if (!authenticated) return requireLogin(); $('#composer-foot').textContent = t('limits') + ' ' + t('dailyLimit') + ' ' + Math.round(boot.limits.dailyBytes / 1024 ** 2) + ' MB.'; $('#file-input').click(); };
$('#file-input').onchange = async event => { await attachments.add([...event.target.files]); event.target.value = ''; updateButton(); };
$('#new-session').onclick = () => newSession().catch(e => toast(e.message));
$('#settings').onclick = event => menuAt(event.clientX, event.clientY + 16, [{label: t('logout'), image: 'back', danger: true, action: () => api('/api/logout', {method: 'POST', body: {}}).then(() => { storage.remove('last-boot'); location.replace('/login'); })}]);
async function openAccount() {}
$('#usage').onclick = openAccount;
const backToList = () => { if (history.state?.fromList) history.back(); else showList(); };
$('#back').onclick = backToList;
$('#details').onclick = details;
$('#chat-menu').onclick = event => { const session = sessions.find(s => s.id === current); if (session) sessionMenu(session, event.clientX - 160, event.clientY + 20); };
$('#search').oninput = event => {
  searching = event.target.value;
  sessions.forEach(s => { delete s.match; delete s.matchSnippet; });
  sideRender(); clearTimeout(searchTimer);
  if (searching) searchTimer = setTimeout(async () => { try { const query = searching, out = await api('/api/sessions?q=' + encodeURIComponent(query)); if (searching !== query) return; const matches = new Map(out.map(s => [s.id, s])); sessions.forEach(s => { s.match = matches.has(s.id); s.matchSnippet = matches.get(s.id)?.matchSnippet; }); sideRender(); } catch {} }, 160);
};
$('#search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('#sessions .session-item')?.click(); } else if (event.key === 'Escape') { event.stopPropagation(); searching = ''; $('#search').value = ''; sideRender(); } };
function clearUnread() { unread = 0; $('#jump').hidden = true; $('#jump b').hidden = true; $('#jump b').textContent = '0'; }
$('#jump').onclick = async () => { stick = true; clearUnread(); await refreshCurrent(); bottom(true); markRead(); };
for (const type of ['wheel', 'touchmove']) timeline.addEventListener(type, () => { userScrollUntil = performance.now() + 1400; }, {passive: true});
timeline.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScrollUntil = performance.now() + 1400; });
timeline.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse' && event.clientX > timeline.getBoundingClientRect().right - 16) userScrollUntil = performance.now() + 1400; }, {passive: true});
timeline.addEventListener('scroll', () => {
  const automatic = programmaticTop !== null && Math.abs(timeline.scrollTop - programmaticTop) < 1; programmaticTop = null;
  if (!automatic && performance.now() < userScrollUntil) {
    const top = timeline.getBoundingClientRect().top, days = [...list.querySelectorAll('.day')];
    const day = days.filter(node => node.getBoundingClientRect().bottom < top).at(-1);
    if (day) scrollDate.textContent = day.textContent;
    scrollDate.classList.toggle('visible', !!day); clearTimeout(dateTimer); dateTimer = setTimeout(() => scrollDate.classList.remove('visible'), 1100);
    userScrollUntil = performance.now() + 1400;
  }
  stick = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100; $('#jump').hidden = stick; if (stick) { clearUnread(); markRead(); } if (timeline.scrollTop < 30 && more.get(current) && !timeline.dataset.loading) { timeline.dataset.loading = '1'; void loadOlder().finally(() => { delete timeline.dataset.loading; }); }
}, {passive: true});
document.addEventListener('paste', event => { if (workspaceKind !== 'chat') return; const files = [...event.clipboardData?.files || []]; if (files.length) { event.preventDefault(); void attachments.add(files).then(updateButton); } });
let dragDepth = 0;
app.addEventListener('dragenter', event => { if (workspaceKind !== 'chat') return; if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
app.addEventListener('dragover', event => { if (workspaceKind !== 'chat') return; if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
app.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) $('#drop-overlay').hidden = true; });
app.addEventListener('drop', event => { event.preventDefault(); if (workspaceKind !== 'chat') return; dragDepth = 0; $('#drop-overlay').hidden = true; void attachments.add([...event.dataTransfer.files]).then(updateButton); });
document.addEventListener('keydown', event => {
  const cmd = event.metaKey || event.ctrlKey;
  if (cmd && event.key.toLowerCase() === 'k' && authenticated) { event.preventDefault(); if (!wide.matches) showList(); $('#search').focus(); }
  if (cmd && (event.key.toLowerCase() === 'n' || event.altKey && event.code === 'KeyN') && authenticated) { event.preventDefault(); void newSession().catch(e => toast(e.message)); }
  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && authenticated) { event.preventDefault(); const rows = [...$('#sessions').querySelectorAll('.session-item')], index = rows.findIndex(s => s.dataset.id === current); const next = rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]; if (next) void openSession(next.dataset.id); }
  if (event.key === 'Escape') { if (!closeTop()) { if (voice?.cancel()) event.preventDefault(); else if (!$('#details-pane').hidden) $('#details-pane').hidden = true; else cancelReply(); } }
});
// Like Telegram Web: with a mouse, a click on the conversation or a typed character goes to the message box. Phones keep their keyboard down.
const composerFree = () => !coarse.matches && !/^\/(board|atlas)$/.test(location.pathname) && !app.inert && !$('#composer').inert && !$('#layers').children.length && !area.disabled;
$('#chat').addEventListener('click', event => {
  if (!composerFree() || !getSelection().isCollapsed || event.target.closest('a,button,input,textarea,select,summary,label,audio,video,img,canvas,[role="button"],[role="menu"],[role="dialog"]')) return;
  area.focus({preventScroll: true});
});
document.addEventListener('keydown', event => {
  const paste = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v';
  const typed = !event.metaKey && !event.ctrlKey && !event.altKey && (event.key.length === 1 && event.key !== ' ' || ['Dead', 'Process'].includes(event.key));
  if ((paste || typed) && composerFree() && !event.target.closest?.('input,textarea,select,[contenteditable="true"]')) area.focus({preventScroll: true});
});
addEventListener('popstate', () => { closeTop(); const workspace = /^\/(board|atlas)$/.exec(location.pathname)?.[1]; if (workspace && authenticated && boot.workspace) { void showWorkspace(workspace, {push: false}); return; } leaveWorkspace(); if (location.pathname === '/account' && authenticated) { void openAccount(); return; } const sid = /^\/chat\/s\/([A-Za-z0-9_-]+)$/.exec(location.pathname)?.[1]; if (sid && authenticated) void openSession(sid, {push: false}); else if (authenticated) showList(false); });
addEventListener('online', () => { connectionLost = authenticated && source?.readyState !== 1; updateButton(); if (cachedBoot || !boot) void start(current); else { void flush(); if (authenticated) { void loadSessions().catch(() => {}); void refreshCurrent(); } } });
addEventListener('offline', () => { connectionLost = true; updateButton(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { titleUnread = 0; if (stick) clearUnread(); document.title = t('name'); markRead(); } });
wide.addEventListener('change', () => { $('#back').hidden = wide.matches || !authenticated; $('#details').hidden = !wide.matches || !authenticated; if (!wide.matches) $('#details-pane').hidden = true; setScreen(!current); });
let swipe;
const chat = $('#chat');
function startSwipe(point, target) {
  const rtl = document.dir === 'rtl';
  if (wide.matches || !authenticated || app.classList.contains('list-screen') || !(rtl ? point.clientX > innerWidth - 25 : point.clientX < 25) || target.closest('button,input,textarea')) return;
  swipe = {x: point.clientX, y: point.clientY, dx: 0, rtl, axis: null, samples: [{x: 0, at: performance.now()}]};
}
function moveSwipe(point, event) {
  if (!swipe) return;
  const dx = (point.clientX - swipe.x) * (swipe.rtl ? -1 : 1), dy = Math.abs(point.clientY - swipe.y);
  if (!swipe.axis && Math.max(Math.abs(dx), dy) >= 3) { if (dy > dx) { endSwipe(true); return; } swipe.axis = 'x'; }
  if (dx <= dy && !swipe.axis) return;
  event.preventDefault();
  paneMoving();
  swipe.dx = Math.max(0, Math.min(innerWidth, dx));
  const now = performance.now(); swipe.samples.push({x: swipe.dx, at: now}); swipe.samples = swipe.samples.filter(s => now - s.at < 110);
  chat.style.transition = 'none'; chat.style.transform = `translateX(${swipe.dx * (swipe.rtl ? -1 : 1)}px)`;
  const progress = swipe.dx / innerWidth;
  sidebar.style.transition = 'none'; sidebar.style.transform = `translateX(${(progress - 1) * innerWidth * .2 * (swipe.rtl ? -1 : 1)}px)`;
  $('.list-dim').style.transition = 'none'; $('.list-dim').style.opacity = String((1 - progress) * .2);
}
function endSwipe(cancelled = false) {
  if (!swipe) return;
  const moved = swipe.dx > 0;
  const sample = swipe.samples[0], velocity = (swipe.dx - sample.x) / Math.max(1, performance.now() - sample.at);
  const back = !cancelled && (swipe.dx >= innerWidth * .3 || swipe.dx > 12 && velocity > .55);
  chat.style.transition = back ? '' : 'transform 280ms var(--spring)';
  if (back) { setScreen(true); backToList(); }
  chat.style.transform = ''; sidebar.style.transition = ''; sidebar.style.transform = ''; $('.list-dim').style.transition = ''; $('.list-dim').style.opacity = ''; swipe = null;
  if (moved) paneMoving();
}
chat.addEventListener('touchstart', event => { if (event.touches.length === 1) startSwipe(event.touches[0], event.target); else endSwipe(true); }, {passive: true});
chat.addEventListener('touchmove', event => { if (event.touches.length === 1) moveSwipe(event.touches[0], event); else endSwipe(true); }, {passive: false});
chat.addEventListener('touchend', () => endSwipe()); chat.addEventListener('touchcancel', () => endSwipe(true));
chat.addEventListener('pointerdown', event => { if (event.pointerType !== 'touch') startSwipe(event, event.target); }, {passive: true});
chat.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') moveSwipe(event, event); });
chat.addEventListener('pointerup', event => { if (event.pointerType !== 'touch') endSwipe(); });
chat.addEventListener('pointercancel', event => { if (event.pointerType !== 'touch') endSwipe(true); });
chat.addEventListener('transitionend', event => { if (event.target === chat && event.propertyName === 'transform' && !swipe) { chat.style.transition = ''; app.classList.remove('pane-moving'); clearTimeout(paneMotionTimer); } });
const viewport = () => { document.documentElement.style.setProperty('--app-top', (globalThis.visualViewport?.offsetTop || 0) + 'px'); document.documentElement.style.setProperty('--app-height', (globalThis.visualViewport?.height || innerHeight) + 'px'); if (stick) bottom(); };
globalThis.visualViewport?.addEventListener('resize', viewport); globalThis.visualViewport?.addEventListener('scroll', viewport); viewport();
function logout() { voice?.cancel(false); source?.close(); storage.remove('last-boot');
  try { for (const key of Object.keys(localStorage)) if (key.startsWith('mastan:' + accountKey + ':')) localStorage.removeItem(key); } catch {}
  for (const item of queue) void import('./media.js').then(({queuedFiles}) => queuedFiles.remove(storeKey('files:' + item.clientId))).catch(() => {}); storage.remove(storeKey('outbox')); storage.remove(storeKey('event')); cached.clear(); queue = []; optimistic = []; current = null; history.replaceState({}, '', '/chat'); location.reload(); }
void start().catch(error => { revealShell(); toast(error.message, {duration: 10000, action: () => start(), label: t('retry')}); }).finally(() => { shellReady = true; });
