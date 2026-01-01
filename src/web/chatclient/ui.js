import {t} from './strings.js';
export const $ = selector => document.querySelector(selector);
document.addEventListener('keydown', event => { if (event.key === 'Tab') document.documentElement.classList.add('keyboard-nav'); }, true);
for (const type of ['pointerdown', 'touchstart']) document.addEventListener(type, () => document.documentElement.classList.remove('keyboard-nav'), {capture: true, passive: true});
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'hidden') node.hidden = true;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter(v => v != null && v !== false)); return node;
}
const paths = {
  send: 'M12 19V5m-6 6 6-6 6 6', mic: 'M12 2.5a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3ZM18.5 10.5v1a6.5 6.5 0 0 1-13 0v-1M12 18v3.5',
  emoji: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01',
  stop: 'M7 7h10v10H7z', plus: 'M12 5v14M5 12h14', search: 'M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5',
  settings: 'm10 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-2-3 1-2-2-2 1Zm2 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  edit: 'm4 16 12-12 4 4L8 20H4v-4Zm10-10 4 4', back: 'm14 5-7 7 7 7M7 12h14', close: 'm6 6 12 12M6 18 18 6', more: 'M5 12h.01M12 12h.01M19 12h.01',
  panel: 'M4 4h16v16H4zM15 4v16', attach: 'm20.5 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4', reply: 'm9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7', trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  retry: 'M20 10a8 8 0 1 0 0 5M20 4v6h-6', pin: 'm8 3 8 0-1 6 4 4H5l4-4-1-6Zm4 10v8', check: 'm5 12 4 4L19 6', lock: 'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',
  play: 'M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7Z', pause: 'M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z', download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  account: 'M16 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  bell: 'M6 9a6 6 0 0 1 12 0v6l2 3H4l2-3V9Zm4 12h4',
  sun: 'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2',
  moon: 'M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11Z',
  document: 'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6',
  shield: 'm12 2 8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5l8-3Z', mail: 'M3 5h18v14H3V5Zm0 0 9 8 9-8',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': name === 'more' ? '3' : '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(k, v);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.plus); svg.append(path); return svg;
}
export const csrfToken = () => $('meta[name="csrf-token"]')?.content || '';
export async function api(path, {method = 'GET', body, signal} = {}) {
  const response = await fetch(path, {method, credentials: 'same-origin', signal, headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(method === 'GET' ? {} : {'X-CSRF-Token': csrfToken()})}, body: body === undefined ? undefined : JSON.stringify(body)});
  if (response.status === 401) { location.replace('/login'); throw Object.assign(new Error('Please sign in again.'), {status: 401}); }
  let out; try { out = await response.json(); } catch { throw new Error('Request unavailable.'); }
  if (!response.ok) throw Object.assign(new Error(out.error || 'Request unavailable.'), {status: response.status, reason: out.reason});
  return out;
}
export const storage = {
  get(key, fallback = null) { try { const v = localStorage.getItem('mastan:' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('mastan:' + key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem('mastan:' + key); } catch {} },
};
export function telegramAvailable(boot = {}) { return !!boot.telegram; }
const notices = []; let noticeBusy = false, currentNotice = null, noticeTimer, promptsDismissed = false;
export const promptsAllowed = () => !promptsDismissed;
export function dismissPrompts() {
  promptsDismissed = true;
  for (let i = notices.length - 1; i >= 0; i--) if (notices[i].quiet) notices.splice(i, 1);
  if (currentNotice?.quiet) { currentNotice.el.remove(); currentNotice = null; }
  dispatchEvent(new Event('mastan-prompts-dismissed'));
}
const noticeBlocked = () => noticeBusy || !!document.activeElement?.closest('#composer') || !!$('#layers')?.children.length;
function showNotice() {
  clearTimeout(noticeTimer);
  if (noticeBlocked() && currentNotice?.quiet) { currentNotice.el.hidden = true; return; }
  if (currentNotice) {
    currentNotice.el.hidden = false;
    if (currentNotice.until <= Date.now()) { currentNotice.el.remove(); currentNotice = null; }
  }
  while (!currentNotice && notices.length) {
    const next = notices.shift(); if (next.until <= Date.now()) continue; if (next.quiet && noticeBlocked()) { notices.push(next); break; }
    currentNotice = next; $('#toasts').replaceChildren(next.el);
  }
  if (currentNotice && Number.isFinite(currentNotice.until)) noticeTimer = setTimeout(showNotice, Math.max(1, currentNotice.until - Date.now()));
}
export function setNoticeBusy(busy) { noticeBusy = busy; showNotice(); }
new MutationObserver(showNotice).observe($('#layers'), {childList: true});
document.addEventListener('focusin', showNotice); document.addEventListener('focusout', () => setTimeout(showNotice, 0));
export function toast(text, {action, label = t('undo'), duration = 4000, dismissible = false, quiet = false, onDismiss} = {}) {
  if (quiet && promptsDismissed) return () => {};
  const el = h('div', {class: quiet ? 'toast quiet-notice' : 'toast'}, h('span', {text, title: text}));
  const notice = {el, quiet, until: quiet ? Infinity : Date.now() + duration};
  const close = () => { el.remove(); const i = notices.indexOf(notice); if (i >= 0) notices.splice(i, 1); if (currentNotice === notice) currentNotice = null; showNotice(); };
  if (action) el.append(h('button', {text: label, onclick: async () => { close(); try { await action(); } catch (e) { toast(e.message); } }}));
  if (dismissible) el.append(h('button', {'aria-label': t('close'), text: '×', onclick: () => { if (quiet) dismissPrompts(); onDismiss?.(); close(); }}));
  if (!quiet && currentNotice?.quiet) { currentNotice.el.remove(); notices.unshift(currentNotice); currentNotice = null; }
  if (quiet) notices.push(notice); else notices.unshift(notice); showNotice(); return close;
}
let topClose = null;
export function closeTop() { if (topClose) { topClose(); return true; } return false; }
export function modal(title, content, {onClose, panel = false, back} = {}) {
  closeTop();
  const previous = document.activeElement, app = $('#app'), backdrop = h('div', {class: 'layer-backdrop'});
  if (panel) backdrop.classList.add('panel-backdrop');
  const body = h('section', {class: panel ? 'sheet side-panel' : 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title}, h('div', {class: 'sheet-head'}, typeof back === 'function' ? h('button', {class: 'icon sheet-back', 'aria-label': t('goBack'), onclick: () => back()}, icon('back')) : null, h('h2', {text: title}), h('button', {class: 'icon', 'aria-label': t('close'), onclick: () => close()}, icon('close'))), content);
  const close = () => { app.inert = false; backdrop.remove(); body.remove(); if (topClose === close) topClose = null; previous?.focus(); onClose?.(); };
  topClose = close; backdrop.onclick = close; app.inert = true;
  body.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...body.querySelectorAll('button,a[href],input,select,textarea')].filter(n => !n.disabled && !n.hidden);
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  $('#layers').append(backdrop, body); body.querySelector('button')?.focus(); return {body, close};
}
export function menuAt(x, y, items, {anchor, className = '', label, content, role = 'menu'} = {}) {
  closeTop();
  const backdrop = anchor && matchMedia('(max-width:700px)').matches ? h('div', {class: 'message-menu-backdrop'}) : null;
  anchor?.classList.add('menu-selected');
  const menu = h('div', {class: 'context-menu ' + className, role, 'aria-label': label}, content || items.map(({label, image, action, danger, title}) => h('button', {role: 'menuitem', title, 'aria-label': title || label, class: danger ? 'danger' : '', onclick: () => { close(); Promise.resolve(action()).catch(e => toast(e.message)); }}, image ? icon(image) : null, label)));
  const previous = document.activeElement;
  const timeline = anchor?.closest('.timeline'), padding = timeline?.style.paddingBlockEnd;
  const close = () => { menu.remove(); backdrop?.remove(); anchor?.classList.remove('menu-selected'); if (timeline) timeline.style.paddingBlockEnd = padding; document.removeEventListener('pointerdown', outside); if (topClose === close) topClose = null; previous?.focus({preventScroll: true}); };
  const outside = e => { if (!menu.contains(e.target)) close(); };
  topClose = close; $('#layers').append(...(backdrop ? [backdrop, menu] : [menu]));
  const left = Math.max(10, Math.min(x, innerWidth - menu.offsetWidth - 10));
  let top = Math.max(10, Math.min(y, innerHeight - menu.offsetHeight - 10));
  if (anchor) {
    const r = anchor.getBoundingClientRect(), height = menu.offsetHeight, gap = 8;
    if (r.bottom + gap + height <= innerHeight - 10) top = r.bottom + gap;
    else if (r.top - gap - height >= 10) top = r.top - gap - height;
    else {
      // A viewport-tall bubble needs room made for the menu. Keep the clicked text visible.
      const timeline = anchor.closest('.timeline'), targetBottom = innerHeight - height - gap - 10;
      if (timeline) { timeline.style.paddingBlockEnd = height + gap + 'px'; timeline.scrollTop += r.bottom - targetBottom; }
      top = Math.max(10, anchor.getBoundingClientRect().bottom + gap);
    }
  }
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  if (backdrop) {
    const r = anchor.getBoundingClientRect();
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    const style = getComputedStyle(anchor), [tl, tr, br, bl] = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(c => parseFloat(style['border' + c + 'Radius']) || 0);
    const {left: l, right, top: topEdge, bottom: b} = r;
    const tail = anchor.classList.contains('tail'), leftTail = tail && parseFloat(getComputedStyle(anchor, '::before').left) < 0;
    const rightEdge = tail && !leftTail ? `V${b - 50 / 9}L${right + 5} ${b}` : `V${b - br}Q${right} ${b} ${right - br} ${b}`;
    const leftEdge = leftTail ? `H${l - 5}L${l} ${b - 50 / 9}` : `H${l + bl}Q${l} ${b} ${l} ${b - bl}`;
    path.setAttribute('d', `M0 0H${innerWidth}V${innerHeight}H0Z M${l + tl} ${topEdge}H${right - tr}Q${right} ${topEdge} ${right} ${topEdge + tr}${rightEdge}${leftEdge}V${topEdge + tl}Q${l} ${topEdge} ${l + tl} ${topEdge}Z`);
    path.setAttribute('fill-rule', 'evenodd'); path.setAttribute('fill', '#0e143487'); svg.append(path); backdrop.append(svg);
  }
  menu.style.transformOrigin = `${Math.max(0, Math.min(menu.offsetWidth, x - left))}px ${Math.max(0, Math.min(menu.offsetHeight, y - top))}px`;
  (menu.querySelector('input') || menu.querySelector('button'))?.focus();
  menu.onkeydown = e => {
    if (e.key === 'Escape') close();
    if (role === 'menu' && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const list = [...menu.children]; list[(list.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus(); }
  };
  queueMicrotask(() => document.addEventListener('pointerdown', outside)); return close;
}
export const fmtSize = size => size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1000))} KB`;
export const fmtTime = at => new Intl.DateTimeFormat('en', {hour: 'numeric', minute: '2-digit'}).format(at);
export const fmtDate = at => new Intl.DateTimeFormat('en', {month: 'long', day: 'numeric'}).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(at)) ? at + 'T12:00:00' : at));
export function dateLabel(at) {
  const d = new Date(at), today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  return at >= +today ? t('today') : at >= +yesterday ? t('yesterday') : new Intl.DateTimeFormat('en', {month: 'long', day: 'numeric'}).format(d);
}
export function when(at, now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  return at >= +today ? fmtTime(at) : at >= +yesterday ? t('yesterday') : new Intl.DateTimeFormat('en', {weekday: 'short'}).format(at);
}
export const escapeData = s => String(s || '');
