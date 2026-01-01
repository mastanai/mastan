// Fleet approvals inside the chat. Everything on a card comes from the gate, never from the model's text, so a reply
// cannot fake one. A tap here does not approve anything by itself: the passkey signs the gate's own challenge.
import {h, api, toast} from './ui.js';
const IDLE_MS = 3000, TRACK_MS = 1000, AUTO_LINGER_MS = 30_000;
const kind = server => /^canary/.test(server) ? ['production', 'Production'] : /^(dev-01|mastan-server)$/.test(server) ? ['own', 'Your server'] : ['client', 'Client server'];
const FINAL = {done: 'Done', failed: 'Failed', denied: 'Denied', cancelled: 'Cancelled', expired: 'Expired'};

export function startApprovals(host) {
  const cards = new Map(); // request id -> {el, row, tracking}
  const banners = new Map(); // server -> element
  const dismissed = new Set(); // auto-approved cards already closed
  let timer, closed = false, loaded = false, expanded = false, autoState = null;
  const autoButton = h('button', {class: 'auto-approve', type: 'button', onclick: () => toggleAuto()});
  host.parentElement.querySelector('#composer-foot')?.after(autoButton);
  autoButton.hidden = true;
  function drawAuto() {
    autoButton.hidden = !autoState;
    if (!autoState) return;
    const live = autoState.on && autoState.lease;
    autoButton.dataset.on = String(live);
    autoButton.setAttribute('aria-pressed', String(live));
    autoButton.textContent = live ? 'Auto-approve: on' : autoState.on ? 'Auto-approve: off here, tap to turn on' : 'Auto-approve: off';
    autoButton.title = live ? 'Commands from your messages here run without a card. Tap to turn off.' : 'Every command needs your passkey. Tap to turn on.';
  }
  async function toggleAuto() {
    autoButton.disabled = true;
    try {
      if (autoState?.on && autoState.lease) autoState = await api('/api/fleet/auto', {method: 'POST', body: {on: false}});
      else if (autoState?.lease) autoState = await api('/api/fleet/auto', {method: 'POST', body: {on: true}});
      else {
        if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) throw new Error('This browser cannot use passkeys.');
        const options = await api('/api/fleet/auto/challenge');
        const assertion = await SimpleWebAuthnBrowser.startAuthentication({optionsJSON: options});
        autoState = await api('/api/fleet/auto/open', {method: 'POST', body: {assertion, challenge: options.challenge}});
      }
      drawAuto();
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Passkey cancelled.' : e.message); }
    autoButton.disabled = false;
  }
  const list = h('div', {class: 'approval-list', id: 'approval-list'});
  const label = h('span');
  const summary = h('button', {class: 'approval-summary', type: 'button', 'aria-controls': list.id, onclick: () => { expanded = !expanded; sync(); }}, label, h('span', {class: 'approval-chevron', 'aria-hidden': 'true', text: '⌄'}));
  host.replaceChildren(summary, list); host.hidden = true;
  function sync() {
    const pending = [...cards.values()].filter(c => c.row.state === 'pending').length;
    host.hidden = !cards.size && !banners.size;
    host.classList.toggle('approval-group', pending >= 2);
    host.classList.toggle('approvals-expanded', expanded);
    label.textContent = `${pending} approvals waiting`;
    summary.setAttribute('aria-expanded', String(expanded));
  }
  async function approve(card, button) {
    button.disabled = true;
    try {
      if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) throw new Error('This browser cannot use passkeys.');
      const options = await api(`/api/fleet/challenge/${card.row.id}`);
      const assertion = await SimpleWebAuthnBrowser.startAuthentication({optionsJSON: options});
      card.row = await api(`/api/fleet/approve/${card.row.id}`, {method: 'POST', body: assertion});
      card.tracking = true; draw(card); schedule(0);
    } catch (e) { button.disabled = false; toast(e.name === 'NotAllowedError' ? 'Passkey cancelled.' : e.message); }
  }
  async function deny(card) {
    try { card.row = await api(`/api/fleet/deny/${card.row.id}`, {method: 'POST', body: {}}); card.tracking = true; draw(card); }
    catch (e) { toast(e.message); }
  }
  function draw(card) {
    const {row} = card, [cls, tag] = kind(row.server), auto = !!row.auto, pending = row.state === 'pending', running = row.state === 'approved';
    card.el.className = `approval ${cls}${auto ? ' auto' : ''}`;
    card.el.dataset.state = row.state;
    card.el.replaceChildren(...[
      h('div', {class: 'approval-head'}, h('span', {text: row.server}), h('span', {class: 'approval-tag', text: auto ? `${tag}, auto-approved` : row.hold ? `${tag}, kept for you: ${row.hold}` : tag})),
      h('div', {class: 'approval-reason', text: row.reason, title: row.reason}),
      h('pre', {class: 'approval-command', text: row.command, title: row.command, tabindex: '0', 'aria-label': 'Command. Focus to expand', onclick: event => { event.stopPropagation(); event.currentTarget.focus(); }}),
      row.output ? h('pre', {class: 'approval-output', text: row.output}) : null,
      h('div', {class: 'approval-actions'},
        pending ? h('button', {class: 'primary', text: 'Approve', 'aria-label': 'Approve with passkey', onclick: event => approve(card, event.currentTarget)}) : null,
        pending ? h('button', {text: 'Deny', onclick: () => deny(card)}) : null,
        !pending && !running ? h('button', {text: 'Close', onclick: () => { dismissed.add(row.id); card.el.remove(); cards.delete(row.id); sync(); }}) : null,
        h('span', {class: 'approval-state', text: pending ? 'Waiting for you' : running ? 'Running' : `${FINAL[row.state] || row.state}${row.exit_code === null || row.exit_code === undefined ? '' : `, exit ${row.exit_code}`}`}))].filter(Boolean));
    const output = card.el.querySelector('.approval-output'); if (output) output.scrollTop = output.scrollHeight;
    sync();
  }
  function drawWindows(windows) {
    const open = new Set(windows.map(w => w.server));
    for (const [server, el] of banners) if (!open.has(server)) { el.remove(); banners.delete(server); }
    for (const w of windows) {
      let el = banners.get(w.server);
      if (!el) {
        el = h('div', {class: 'approval window-open'}, h('span'), h('button', {text: 'Close', onclick: () => api(`/api/fleet/windows/${encodeURIComponent(w.server)}/close`, {method: 'POST', body: {}}).then(poll).catch(e => toast(e.message))}));
        banners.set(w.server, el); list.prepend(el);
      }
      el.firstElementChild.textContent = `No-tap window open on ${w.server}, ${Math.max(1, Math.ceil((w.expires - w.now) / 60000))} min left`;
    }
  }
  async function poll() {
    if (document.hidden) return;
    try {
      const out = await api('/api/fleet/pending');
      if (out.installed === false) { closed = true; return; }
      drawWindows(out.windows.map(w => ({...w, now: out.now})));
      autoState = out.autoState; drawAuto();
      for (const row of out.auto || []) {
        if (cards.has(row.id) || dismissed.has(row.id)) continue;
        const card = {el: h('div'), row, tracking: row.state === 'approved'};
        cards.set(row.id, card); list.append(card.el); draw(card);
      }
      const seen = new Set(out.pending.map(r => r.id));
      for (const row of out.pending) {
        let card = cards.get(row.id);
        if (!card) { if (loaded) expanded = true; card = {el: h('div'), row}; cards.set(row.id, card); list.append(card.el); draw(card); }
      }
      for (const card of cards.values()) {
        if (seen.has(card.row.id)) continue;
        // A clean auto-approved run leaves after a while; it stays on the Fleet page. A failed one stays until closed.
        if (card.row.auto && card.row.state === 'done') {
          card.doneAt ||= Date.now();
          if (Date.now() - card.doneAt > AUTO_LINGER_MS) { dismissed.add(card.row.id); card.el.remove(); cards.delete(card.row.id); }
          continue;
        }
        if (FINAL[card.row.state] && !card.tracking) continue;
        // Gone from pending: follow it to its end. Denied here or by another device, it shows its final state.
        const row = await api(`/api/fleet/live/${card.row.id}`);
        if (row.state !== card.row.state || row.output !== card.row.output) { card.row = row; draw(card); }
        card.tracking = row.state === 'approved';
      }
      loaded = true; sync();
    } catch { /* The next tick tries again; the connection line already shows an outage. */ }
    schedule();
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(poll, ms ?? ([...cards.values()].some(c => c.tracking) ? TRACK_MS : IDLE_MS));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  // Settle the first poll during chat boot so it cannot move the revealed composer.
  return poll();
}
