// Board: Topic Board items through ctx.board. Lanes, area filter, needs-you, edit note, move lane, done, add.
// Every area is shown, Work included (since 26 Oct).
(() => {
  'use strict';
  const {h, api, toast, busy, setMain, fmtDate, fmtDateTime, fill} = window.MM;
  const LANE_NAMES = {open: 'Open', in_progress: 'In progress', later: 'Later', done: 'Done'};
  const store = {get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }};
  let state = {items: [], areas: [], lanes: Object.keys(LANE_NAMES), lane: 'open', area: 'all', needsOnly: false, synced_at: null};
  try { Object.assign(state, JSON.parse(store.get('mm-board') || '{}')); } catch {}
  const save = () => store.set('mm-board', JSON.stringify({lane: state.lane, area: state.area, needsOnly: state.needsOnly}));

  const root = h('div', null, MM.pageHead('Board'), MM.loading());
  setMain(root);

  async function load() {
    let data;
    try { data = await api('/api/board'); }
    catch (e) { data = {available: false, reason: e.message}; }
    if (!data.available) {
      root.replaceChildren(MM.pageHead('Board'),
        h('div', {class: 'unavailable', role: 'alert'}, h('p', {text: 'Board unavailable.'}), h('p', {class: 'small', text: `${data.reason && data.reason !== 'Board unavailable.' ? data.reason + ' ' : ''}Your items are safe on mastan.ai.`}),
          h('button', {class: 'btn small', type: 'button', text: 'Try again', onclick: load})));
      return;
    }
    state.items = data.items || [];
    state.areas = data.areas || [];
    state.lanes = data.lanes || state.lanes;
    state.synced_at = data.synced_at;
    state.read_only = data.read_only || null;
    state.last_error = data.last_error || null;
    if (!state.lanes.includes(state.lane)) state.lane = 'open';
    if (state.area !== 'all' && !state.areas.includes(state.area)) state.area = 'all';
    render();
  }

  function render() {
    const inLane = state.items.filter(i => i.lane === state.lane);
    const shown = inLane.filter(i => (state.area === 'all' || i.area === state.area) && (!state.needsOnly || i.needs_you));
    const needs = state.items.filter(i => i.needs_you && (i.lane === 'open' || i.lane === 'in_progress')).length;
    const lanes = h('div', {class: 'lanes', role: 'tablist'}, state.lanes.map(l => h('button', {type: 'button', role: 'tab', 'aria-selected': String(l === state.lane),
      onclick: () => { state.lane = l; save(); render(); }}, LANE_NAMES[l] || l, h('span', {class: 'n', text: state.items.filter(i => i.lane === l).length}))));
    const areaChips = h('div', {class: 'chips scroll fu-seg board-areas'}, ['all', ...state.areas].map(a => h('button', {class: 'chip', type: 'button', 'aria-pressed': String(a === state.area),
      onclick: () => { state.area = a; save(); render(); }}, a === 'all' ? 'All areas' : a)));
    const needsChip = h('button', {class: 'chip', type: 'button', 'aria-pressed': String(state.needsOnly), onclick: () => { state.needsOnly = !state.needsOnly; save(); render(); }},
      'Needs you', h('b', {text: needs}));
    const addBtn = state.read_only ? null : h('button', {class: 'btn small primary', type: 'button', text: 'Add item', onclick: () => openAdd(addHolder)});
    const addHolder = h('div');
    const when = state.synced_at ? (state.read_only ? `snapshot ${fmtDateTime(state.synced_at)}` : `synced ${fmtDateTime(state.synced_at)}`) : '';
    fill(root,
      MM.pageHead('Board', h('span', {class: 'count', text: `${when}${state.last_error ? ', last sync failed' : ''}`}), addBtn),
      state.read_only ? h('p', {class: 'readonly-banner', text: 'Read-only until the board writer token is approved. Edit on mastan.ai/board meanwhile.'}) : null,
      addHolder, h('div', {class: 'filter-row board-filters'}, lanes, areaChips, needsChip),
      shown.length ? h('div', {class: 'card-list'}, shown.map(card)) : h('p', {class: 'empty', text: 'Nothing here. Choose another lane or add an item.'}));
  }

  function card(item) {
    const flagged = item.needs_you && (item.lane === 'open' || item.lane === 'in_progress');
    const el = h('article', {class: 'card' + (flagged ? ' flag' : ''), dataset: {id: item.id}});
    const laneSelect = h('select', {'aria-label': 'Move to lane'}, state.lanes.map(l => h('option', {value: l, selected: l === item.lane, text: `Lane: ${LANE_NAMES[l] || l}`})));
    const doneBtn = item.lane === 'done' ? null : h('button', {class: 'btn small good', type: 'button', text: 'Done'});
    const editBtn = h('button', {class: 'btn small', type: 'button', text: 'Edit note'});
    const needBtn = h('button', {class: 'btn small ghost', type: 'button', text: item.needs_you ? 'Clear needs you' : 'Needs you'});
    fill(el,
      h('div', {class: 'b-title'}, h('span', {text: item.title}), flagged ? h('span', {class: 'badge needs-you', text: 'Needs you'}) : null),
      item.note ? h('p', {class: 'b-note', text: item.note}) : null,
      item.next ? h('p', {class: 'b-next'}, h('b', {text: 'Next '}), item.next) : null,
      h('div', {class: 'b-meta'}, MM.badge(item.lane, LANE_NAMES[item.lane] || item.lane), h('span', {text: item.area}), item.priority ? h('span', {class: `badge priority-${item.priority}`, text: item.priority}) : null,
        item.updated ? h('span', {text: `updated ${fmtDate(item.updated)}`}) : null),
      state.read_only ? null : h('div', {class: 'b-actions'}, laneSelect, doneBtn, editBtn, needBtn));
    if (state.read_only) return el;

    laneSelect.addEventListener('change', async () => {
      const lane = laneSelect.value;
      laneSelect.disabled = true;
      try {
        const r = await api(`/api/board/items/${encodeURIComponent(item.id)}` + (lane === 'done' ? '/done' : ''), {method: 'POST', body: lane === 'done' ? {} : {lane}});
        apply(item, r.item, {lane});
        toast(`Moved to ${LANE_NAMES[lane]}.`);
      } catch (e) { toast(e.message, {error: true}); laneSelect.value = item.lane; laneSelect.disabled = false; if (e.status === 409) load(); }
    });
    doneBtn?.addEventListener('click', async () => {
      busy(doneBtn, true);
      try { const r = await api(`/api/board/items/${encodeURIComponent(item.id)}/done`, {method: 'POST'}); apply(item, r.item, {lane: 'done'}); toast('Done.'); }
      catch (e) { toast(e.message, {error: true}); busy(doneBtn, false); if (e.status === 409) load(); }
    });
    needBtn.addEventListener('click', async () => {
      busy(needBtn, true);
      try { const r = await api(`/api/board/items/${encodeURIComponent(item.id)}`, {method: 'POST', body: {needs_you: !item.needs_you}}); apply(item, r.item, {needs_you: !item.needs_you}); }
      catch (e) { toast(e.message, {error: true}); busy(needBtn, false); if (e.status === 409) load(); }
    });
    editBtn.addEventListener('click', () => {
      const note = h('textarea', {rows: 3, maxlength: 600, 'aria-label': 'Note'}); note.value = item.note || '';
      const next = h('textarea', {rows: 2, maxlength: 600, 'aria-label': 'Next step'}); next.value = item.next || '';
      const saveBtn = h('button', {class: 'btn small primary', type: 'button', text: 'Save'});
      const cancel = h('button', {class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => render()});
      const form = h('div', {class: 'add-form'}, h('label', {text: 'Note'}), note, h('label', {text: 'Next step'}), next, h('div', {class: 'btn-row'}, saveBtn, cancel));
      el.querySelector('.b-actions').replaceWith(form);
      note.focus();
      saveBtn.addEventListener('click', async () => {
        busy(saveBtn, true);
        const patch = {note: note.value.trim(), next: next.value.trim()};
        try { const r = await api(`/api/board/items/${encodeURIComponent(item.id)}`, {method: 'POST', body: patch}); apply(item, r.item, patch); toast('Saved.'); }
        catch (e) { toast(e.message, {error: true}); busy(saveBtn, false); if (e.status === 409) load(); }
      });
    });
    return el;
  }

  function apply(item, fromServer, patch) {
    Object.assign(item, fromServer && fromServer.id === item.id ? fromServer : patch);
    render();
  }

  function openAdd(holder) {
    if (holder.firstChild) { holder.replaceChildren(); return; }
    const title = h('input', {type: 'text', maxlength: 120, placeholder: 'Short title', 'aria-label': 'Title'});
    const area = h('select', {'aria-label': 'Area'}, state.areas.map(a => h('option', {value: a, text: a, selected: a === (state.area === 'all' ? 'Personal' : state.area)})));
    const lane = h('select', {'aria-label': 'Lane'}, state.lanes.filter(l => l !== 'done').map(l => h('option', {value: l, text: LANE_NAMES[l], selected: l === (state.lane === 'done' ? 'open' : state.lane)})));
    const note = h('textarea', {rows: 2, maxlength: 600, placeholder: 'Note (optional)', 'aria-label': 'Note'});
    const needs = h('input', {type: 'checkbox'});
    const addBtn = h('button', {class: 'btn primary', type: 'button', text: 'Add'});
    const form = h('div', {class: 'card add-form'}, h('label', {text: 'Title'}), title, h('div', {class: 'row2'}, h('div', null, h('label', {text: 'Area'}), area), h('div', null, h('label', {text: 'Lane'}), lane)),
      h('label', {text: 'Note'}), note, h('label', {class: 'switch'}, needs, 'Needs you'), h('div', {class: 'btn-row'}, addBtn, h('button', {class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => holder.replaceChildren()})));
    holder.replaceChildren(form);
    title.focus();
    addBtn.addEventListener('click', async () => {
      if (!title.value.trim()) { title.focus(); toast('Add a title.'); return; }
      busy(addBtn, true, 'Adding');
      const body = {title: title.value.trim(), area: area.value, lane: lane.value, needs_you: needs.checked};
      if (note.value.trim()) body.note = note.value.trim();
      try {
        const r = await api('/api/board/items', {method: 'POST', body});
        toast('Added.');
        state.lane = body.lane; save();
        if (r.item) { state.items.unshift(r.item); render(); } else load();
      } catch (e) { toast(e.message, {error: true}); busy(addBtn, false); }
    });
  }

  load();
})();
