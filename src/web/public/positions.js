// Positions by domain: confidence, status, since; Confirm, Edit statement, Reject (with an optional reason); filter "needs confirmation".
(() => {
  'use strict';
  const {h, api, toast, color, refreshStats, statusLabel, confidence, fmtDate, busy, setMain, fill} = window.MM;
  const store = {get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }};
  let positions = [], domains = [], filter = store.get('mm-pos-filter') || 'all', domainFilter = 'all';
  const root = h('div', null, MM.pageHead('Positions'), MM.loading());
  setMain(root);

  async function load() {
    try { const d = await api('/api/positions'); positions = d.positions || []; domains = d.domains || []; render(); }
    catch (e) { root.replaceChildren(MM.pageHead('Positions'), MM.errorState(e.message, load)); }
  }

  function render() {
    const needs = positions.filter(p => p.status === 'needs_confirmation').length;
    const list = positions.filter(p => (filter === 'all' || (filter === 'needs' ? p.status === 'needs_confirmation' : p.status === 'active'))
      && (domainFilter === 'all' || p.domain === domainFilter));
    const groups = new Map();
    for (const p of list) { if (!groups.has(p.domain)) groups.set(p.domain, []); groups.get(p.domain).push(p); }
    const order = [...domains, ...[...groups.keys()].filter(d => !domains.includes(d))];
    const chip = (key, label, n) => h('button', {class: 'chip', type: 'button', 'aria-pressed': String(filter === key), onclick: () => { filter = key; store.set('mm-pos-filter', key); render(); }}, label, n !== undefined ? h('b', {text: n}) : null);
    const domainSelect = h('select', {'aria-label': 'Domain'}, h('option', {value: 'all', text: 'All domains'}),
      domains.map(d => h('option', {value: d, text: d, selected: d === domainFilter})));
    domainSelect.addEventListener('change', () => { domainFilter = domainSelect.value; render(); });
    fill(root,
      MM.pageHead('Positions', h('span', {class: 'count', text: `${positions.length} positions`})),
      h('div', {class: 'filter-row'}, h('div', {class: 'fu-seg', role: 'group', 'aria-label': 'Status'}, chip('all', 'All', positions.length), chip('needs', 'Needs confirmation', needs), chip('active', 'Confirmed', positions.length - needs)), domainSelect),
      list.length ? null : h('p', {class: 'empty', text: filter === 'needs' ? 'Nothing waits for confirmation.' : 'No positions yet. Add a dump to start.'}),
      order.filter(d => groups.has(d)).map(d => {
        const dot = h('span', {class: 'q-group-dot'}); dot.style.background = color(d);
        return h('section', {class: 'card-list'}, h('div', {class: 'section'}, dot, h('h2', {text: d}), h('span', {class: 'count', text: groups.get(d).length})), groups.get(d).map(card));
      }));
  }

  function card(p) {
    const el = h('article', {class: 'card', dataset: {id: p.id}});
    const statement = h('p', {class: 'p-statement', text: p.statement});
    const confirm = p.status === 'active' ? null : h('button', {class: 'btn small primary', type: 'button', text: 'Confirm'});
    const edit = h('button', {class: 'btn small', type: 'button', text: 'Edit'});
    const reject = h('button', {class: 'btn small reject', type: 'button', text: 'Reject'});
    const actions = h('div', {class: 'btn-row'}, confirm, edit, reject);
    const dates = [p.since && `since ${fmtDate(p.since)}`, p.last_confirmed && `confirmed ${fmtDate(p.last_confirmed)}`].filter(Boolean).join(' · ');
    fill(el, statement,
      h('div', {class: 'p-meta'}, MM.badge(p.status, statusLabel(p.status)), confidence(p.confidence),
        dates ? h('span', {text: dates}) : null),
      p.sources?.length ? h('details', {class: 'sources'}, h('summary', {text: `Sources (${p.sources.length})`}),
        h('ul', {class: 'plain'}, p.sources.map(s => h('li', null, s.quote ? h('q', {text: s.quote}) : null, ' ', h('span', {class: 'faint', text: [s.file, fmtDate(s.date)].filter(Boolean).join(', ')}))))) : null,
      actions);

    const post = async (button, action, body, label) => {
      busy(button, true, label);
      try {
        const r = await api(`/api/positions/${encodeURIComponent(p.id)}/${action}`, {method: 'POST', body});
        if (action === 'reject') { positions = positions.filter(x => x.id !== p.id); toast('Rejected.'); }
        else { Object.assign(p, r.position); toast(action === 'confirm' ? 'Confirmed.' : 'Saved.'); }
        render(); refreshStats();
      } catch (e) { toast(e.message, {error: true}); busy(button, false); }
    };
    confirm?.addEventListener('click', () => post(confirm, 'confirm', {}, 'Confirming'));
    reject.addEventListener('click', () => {
      const area = h('textarea', {rows: 2, maxlength: 600, placeholder: 'Why? Optional. One line is enough.', 'aria-label': 'Reason'});
      const go = h('button', {class: 'btn small bad', type: 'button', text: 'Reject'});
      const cancel = h('button', {class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => render()});
      actions.replaceChildren(h('div', {class: 'reject-form'}, area, h('div', {class: 'btn-row'}, go, cancel))); area.focus();
      go.addEventListener('click', () => post(go, 'reject', {reason: area.value.trim()}, 'Rejecting'));
    });
    edit.addEventListener('click', () => {
      const area = h('textarea', {rows: 3, maxlength: 600, 'aria-label': 'Statement'}); area.value = p.statement;
      const saveBtn = h('button', {class: 'btn small primary', type: 'button', text: 'Save'});
      const cancel = h('button', {class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => render()});
      statement.replaceWith(area); actions.replaceChildren(saveBtn, cancel); area.focus();
      saveBtn.addEventListener('click', () => {
        const text = area.value.trim();
        if (!text) { area.focus(); return; }
        post(saveBtn, 'edit', {statement: text}, 'Saving');
      });
    });
    return el;
  }
  load();
})();
