// Dump: one box, Save files it through the brain, recent dumps with their status.
(() => {
  'use strict';
  const {h, api, toast, busy, setMain, fmtDateTime, refreshStats} = window.MM;
  const KEY = 'mm-dump-draft';
  const store = {get() { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } }, set(v) { try { sessionStorage.setItem(KEY, v); } catch {} }};
  const area = h('textarea', {rows: 8, placeholder: 'Anything on your mind. It gets filed into the atlas.', 'aria-label': 'Dump'});
  area.value = store.get();
  area.addEventListener('input', () => store.set(area.value));
  const saveBtn = h('button', {class: 'btn primary', type: 'button', text: 'Save'});
  const list = h('div', {class: 'card-list'}, MM.loading());
  setMain(MM.pageHead('Dump', saveBtn), h('div', {class: 'card dump-input'}, area),
    h('div', {class: 'section'}, h('h2', {text: 'Recent'})), list);

  let pollTimer = null;
  async function load() {
    let d;
    try { d = await api('/api/dumps'); } catch (e) { list.replaceChildren(MM.errorState(e.message, load)); return; }
    const dumps = d.dumps || [];
    if (!dumps.length) { list.replaceChildren(h('p', {class: 'empty', text: 'No dumps yet. Save a thought above.'})); return; }
    list.replaceChildren(...dumps.map(x => h('article', {class: 'card'},
      h('div', {class: 'd-meta'}, h('span', {text: fmtDateTime(x.created || x.date)}), x.source ? h('span', {text: x.source}) : null,
        MM.badge(x.status)),
      h('p', {class: 'd-preview', text: x.preview}), x.summary ? h('p', {class: 'muted small', text: x.summary}) : null)));
    clearTimeout(pollTimer);
    if (dumps.slice(0, 3).some(x => x.status === 'new' || x.status === 'processing' || x.status === 'filing')) pollTimer = setTimeout(load, 5000);
  }

  saveBtn.addEventListener('click', async () => {
    const text = area.value.trim();
    if (!text) { area.focus(); toast('Write something first.'); return; }
    busy(saveBtn, true, 'Saving');
    try {
      const r = await api('/api/dumps', {method: 'POST', body: {text}});
      area.value = ''; store.set('');
      toast(r.state === 'filing' ? 'Saved. Filing it now.' : 'Saved.');
      load(); refreshStats();
    } catch (e) { toast(e.message, {error: true}); }
    busy(saveBtn, false);
  });
  load();
})();
