// Shared helpers for signed-in pages. All rendering uses DOM nodes and textContent; no innerHTML with data.
(() => {
  'use strict';
  // One-time link fragments never stay in history.
  if (/(^|[#&])(operator|enrol|enroll)=/.test(location.hash)) history.replaceState(null, '', location.pathname);
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const DOMAIN_COLORS = {
    'Self & psychology': '#cf87a2',
    'Work & building': '#86aecb',
    'Money & investing': '#d9b26a',
    'Meaning & spirituality': '#a78dce',
    'Family & parenting': '#d08a72',
    'Technology & AI': '#6fb3b3',
    'Science & cosmos': '#8098da',
    'Health & body': '#8fc7a8',
    'Mastan & product': '#a3b56e',
    'Decisions I delegate': '#baaa8d',
    'People': '#7f8a84',
  };
  const LIGHT_DOMAIN_COLORS = Object.fromEntries(Object.keys(DOMAIN_COLORS).map((domain, i) => [domain,
    ['#914666', '#24597d', '#7d5610', '#71509b', '#934a33', '#236b6b', '#465fa1', '#1f6a48', '#586b22', '#6e6045', '#56635b'][i]]));
  const domains = [...Object.keys(DOMAIN_COLORS), 'Other'];
  const domainColor = domain => document.documentElement.dataset.theme === 'light'
    ? LIGHT_DOMAIN_COLORS[domain] || '#56635b' : DOMAIN_COLORS[domain] || '#7a857e';
  function refreshDomainColors() {
    domains.forEach((domain, i) => document.documentElement.style.setProperty(`--domain-${i}`, domainColor(domain)));
  }
  refreshDomainColors();
  window.addEventListener('mastan-theme', refreshDomainColors);
  const color = domain => document.body.dataset.page === 'atlas' ? domainColor(domain)
    : `var(--domain-${domains.includes(domain) ? domains.indexOf(domain) : domains.length - 1})`;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') {
        // Set individual properties so the strict style policy stays intact.
        for (const [property, value] of Object.entries(v)) el.style[property] = value;
      }
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  async function api(path, {method = 'GET', body} = {}) {
    const opts = {method, credentials: 'same-origin', headers: {}};
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = csrf;
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try { res = await fetch(path, opts); } catch { throw new ApiError('No connection. Try again.', 0); }
    if (res.status === 401) { location.replace('/login'); throw new ApiError('Please sign in again.', 401); }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new ApiError((data && data.error) || 'Request failed. Please try again.', res.status), {existing_id: typeof data?.existing_id === 'string' ? data.existing_id : null});
    return data;
  }

  let toastTimer;
  function toast(message, {error = false, ms = 2600} = {}) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', !!error);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function refreshStats() {
    try {
      const s = await api('/api/stats');
      for (const chip of document.querySelectorAll('[data-stat]')) {
        const b = chip.querySelector('b');
        if (b && s[chip.dataset.stat] !== undefined) b.textContent = s[chip.dataset.stat];
      }
      return s;
    } catch { return null; }
  }

  function waitingLabel(days) {
    if (days === null || days === undefined) return 'new';
    if (days === 0) return 'asked today';
    return `waiting ${days} day${days === 1 ? '' : 's'}`;
  }
  const dateFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', year: 'numeric'});
  const timeFormat = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  function displayDate(value, format) {
    if (value === null || value === undefined || value === '') return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const parts = Object.fromEntries(format.formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.day} ${parts.month}${parts.hour === undefined ? ` ${parts.year}` : ` ${parts.hour}:${parts.minute}`}`;
  }
  const fmtDate = value => displayDate(value, dateFormat);
  const fmtDateTime = value => displayDate(value, timeFormat);
  const stateToken = state => ({
    active: 'ok', confirmed: 'ok', ok: 'ok', done: 'ok', filed: 'ok', processed: 'ok', reachable: 'ok', healthy: 'ok', live: 'ok',
    pending: 'warn', needs_confirmation: 'warn', 'needs-you': 'warn', cancelling: 'warn', incomplete: 'warn', warning: 'warn', test: 'warn', sample: 'warn',
    failed: 'bad', error: 'bad', overdue: 'bad', past_due: 'bad', unreachable: 'bad', down: 'bad', expired: 'bad', incomplete_expired: 'bad', unpaid: 'bad',
    running: 'info', approved: 'info', processing: 'info', filing: 'info', in_progress: 'info', trialing: 'info',
  }[state] || 'off');
  const badge = (state, label = state) => h('span', {class: `badge ${stateToken(state)}`, text: label});
  function ago(value) {
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 48) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} days ago`;
  }
  const pct = c => (c === null || c === undefined || c === '') ? '?' : `${Math.round(Number(c) * 100)}%`;
  const statusLabel = s => ({active: 'confirmed', needs_confirmation: 'needs confirmation', superseded: 'rejected'}[s] || s || '');

  function confidence(c) {
    const bar = h('span', {class: 'conf-bar'}, h('i'));
    bar.firstChild.style.width = `${Math.max(0, Math.min(1, Number(c) || 0)) * 100}%`;
    return h('span', {class: 'conf', title: 'Confidence'}, bar, pct(c));
  }
  function busy(button, on, label) {
    if (on) { button.dataset.label = button.textContent; button.disabled = true; if (label) button.textContent = label; }
    else { button.disabled = false; if (button.dataset.label) button.textContent = button.dataset.label; }
  }
  function main() { return document.getElementById('main'); }
  function fill(el, ...nodes) { el.replaceChildren(...nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false)); return el; }
  function setMain(...nodes) { return fill(main(), ...nodes); }
  const filterRows = new Set();
  const updateRail = row => {
    row.classList.toggle('has-overflow', row.scrollWidth > row.clientWidth + 1);
    row.classList.toggle('at-start', row.scrollLeft < 1);
    row.classList.toggle('at-end', row.scrollLeft + row.clientWidth >= row.scrollWidth - 1);
  };
  const filterSizes = new ResizeObserver(entries => {
    for (const {target} of entries) updateRail(target);
  });
  new MutationObserver(() => {
    for (const row of filterRows) {
      if (!row.isConnected) { filterSizes.unobserve(row); filterRows.delete(row); }
    }
    for (const row of document.querySelectorAll('.filter-row, .cl-kpis, .cl-filter-fields .cl-tags')) {
      if (!filterRows.has(row)) { filterRows.add(row); filterSizes.observe(row); row.addEventListener('scroll', () => updateRail(row), {passive: true}); }
      updateRail(row);
    }
  }).observe(main(), {childList: true, subtree: true});
  const pageHead = (title, ...actions) => {
    const controls = h('div', {class: 'page-actions'}, ...actions);
    // Empty status labels do not reserve a blank action row on phones.
    for (const label of controls.querySelectorAll(':scope > span:empty')) label.remove();
    return h('div', {class: 'page-head'}, h('h1', {text: title}), controls);
  };
  const loading = () => h('p', {class: 'loading', role: 'status', text: 'loading...'});
  const empty = text => h('p', {class: 'empty', text});
  const errorState = (message, retry) => h('div', {class: 'error', role: 'alert'}, h('span', {text: message}),
    h('button', {class: 'btn small', type: 'button', text: 'Try again', onclick: retry}));

  window.MM = {h, api, ApiError, toast, refreshStats, waitingLabel, fmtDate, fmtDateTime, stateToken, badge, ago, pct, statusLabel, confidence, busy, color, DOMAIN_COLORS, main, setMain, fill, pageHead, loading, empty, errorState,
    operator: document.body.dataset.operator === '1'};
})();
