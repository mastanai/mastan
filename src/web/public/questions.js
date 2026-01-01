// Question Panel: open questions grouped by domain, numbered cards, answer / later / skip.
(() => {
  'use strict';
  const {h, api, toast, color, refreshStats, waitingLabel, busy, setMain} = window.MM;
  const store = {get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} }, del(k) { try { sessionStorage.removeItem(k); } catch {} }};

  function card(q, label) {
    const area = h('textarea', {placeholder: 'Your answer, in your words', 'aria-label': 'Answer', rows: 3});
    const draftKey = 'mm-draft-' + q.id;
    area.value = store.get(draftKey) || '';
    area.addEventListener('input', () => store.set(draftKey, area.value));
    const answerBtn = h('button', {class: 'btn primary', type: 'button', text: 'Answer'});
    const laterBtn = h('button', {class: 'btn', type: 'button', text: 'Later'});
    const skipBtn = h('button', {class: 'btn ghost', type: 'button', text: 'Skip'});
    const status = h('p', {class: 'filing', hidden: true});
    const result = h('div', {class: 'q-result', hidden: true});
    const meta = h('p', {class: 'q-meta' + (q.waiting_days > 2 ? ' waiting' : ''), text: waitingLabel(q.waiting_days)});
    const el = h('article', {class: 'card q-card', dataset: {id: q.id, waiting: q.waiting_days ?? ''}},
      h('span', {class: 'q-num', text: label}),
      h('p', {class: 'q-text', text: q.text}),
      q.why ? h('p', {class: 'q-why'}, h('b', {text: 'Why: '}), q.why) : null,
      meta, area, h('div', {class: 'btn-row'}, answerBtn, laterBtn, skipBtn), status, result);

    const lock = on => { for (const b of [answerBtn, laterBtn, skipBtn]) b.disabled = on; area.disabled = on; };
    answerBtn.addEventListener('click', async () => {
      const text = area.value.trim();
      if (!text) { area.focus(); toast('Write an answer first.'); return; }
      lock(true); busy(answerBtn, true, 'Sending');
      try {
        await api(`/api/questions/${encodeURIComponent(q.id)}/answer`, {method: 'POST', body: {text}});
        store.del(draftKey);
        busy(answerBtn, false); lock(true);
        status.hidden = false; status.textContent = 'Filing your answer';
        status.classList.add('loading');
        refreshStats();
        poll(q, el, status, result);
      } catch (e) { toast(e.message, {error: true}); busy(answerBtn, false); lock(false); }
    });
    const move = (button, action, message) => async () => {
      lock(true); busy(button, true);
      try {
        await api(`/api/questions/${encodeURIComponent(q.id)}/${action}`, {method: 'POST'});
        toast(message);
        el.remove(); recount(); refreshStats();
      } catch (e) { toast(e.message, {error: true}); busy(button, false); lock(false); }
    };
    laterBtn.addEventListener('click', move(laterBtn, 'later', 'Moved to later.'));
    skipBtn.addEventListener('click', move(skipBtn, 'skip', 'Skipped.'));
    if (q.answering) { lock(true); status.hidden = false; status.textContent = 'Filing your answer'; status.classList.add('loading'); poll(q, el, status, result); }
    return el;
  }

  async function poll(q, el, status, result) {
    const started = Date.now();
    while (Date.now() - started < 6 * 60_000) {
      await new Promise(r => setTimeout(r, 2000));
      let r;
      try { r = await api(`/api/questions/${encodeURIComponent(q.id)}/answer`); } catch { continue; }
      if (r.state === 'filing') continue;
      status.classList.remove('loading');
      if (r.state === 'error') { status.classList.add('error'); status.textContent = 'Filing failed. The answer was kept; try again later.'; return; }
      el.classList.add('done');
      highlightLongest();
      status.textContent = 'Filed.';
      el.querySelector('textarea')?.remove();
      el.querySelector('.btn-row')?.remove();
      result.hidden = false;
      const bits = [];
      if (r.summary) bits.push(h('p', {text: r.summary}));
      const counts = [r.created ? `${r.created} new` : null, r.changed ? `${r.changed} changed` : null].filter(Boolean).join(', ');
      if (counts) bits.push(h('p', {class: 'faint', text: `Atlas: ${counts}.`}));
      result.replaceChildren(...bits);
      if (r.followups?.length) {
        const holder = h('div', {class: 'followups'}, h('p', {class: 'muted small', text: `Follow-up question${r.followups.length === 1 ? '' : 's'}`}));
        for (const f of r.followups) holder.append(card(f, 'new'));
        el.after(holder);
      }
      refreshStats();
      return;
    }
    status.classList.remove('loading');
    status.textContent = 'Still filing. Check back in a few minutes.';
  }

  function recount() {
    highlightLongest();
    for (const group of document.querySelectorAll('.q-group')) {
      const n = group.querySelectorAll('.q-card:not(.done)').length;
      const c = group.querySelector('.count');
      if (c) c.textContent = n;
    }
  }

  function highlightLongest() {
    const cards = [...document.querySelectorAll('.q-card')];
    const longest = cards.filter(el => !el.classList.contains('done')).reduce((oldest, el) =>
      Number(el.dataset.waiting) > Number(oldest?.dataset.waiting || 0) ? el : oldest, null);
    for (const el of cards) el.classList.toggle('q-longest', el === longest);
  }

  async function load() {
    let data;
    try { data = await api('/api/questions'); }
    catch (e) { setMain(MM.pageHead('Questions'), MM.errorState(e.message, load)); return; }
    const parts = [];
    const total = data.groups.reduce((n, g) => n + g.count, 0);
    parts.push(MM.pageHead('Questions', h('span', {class: 'count', text: total ? `${total} open` : ''})));
    refreshStats();
    if (!total) parts.push(h('p', {class: 'empty', text: 'No open questions. New ones arrive with the morning set.'}));
    let n = 0;
    for (const g of data.groups) {
      const dot = h('span', {class: 'q-group-dot'}); dot.style.background = color(g.domain);
      const group = h('section', {class: 'q-group card-list'}, h('div', {class: 'section'}, dot, h('h2', {text: g.domain}), h('span', {class: 'count', text: g.count})));
      for (const q of g.questions) group.append(card(q, String(++n)));
      parts.push(group);
    }
    if (data.later?.length) {
      const list = h('div', {class: 'card-list'});
      for (const q of data.later) {
        const reopen = h('button', {class: 'btn small', type: 'button', text: 'Ask again'});
        const row = h('div', {class: 'card'}, h('p', {text: q.text}), h('p', {class: 'faint small', text: q.domain}), reopen);
        reopen.addEventListener('click', async () => {
          busy(reopen, true);
          try { await api(`/api/questions/${encodeURIComponent(q.id)}/reopen`, {method: 'POST'}); toast('Back in the panel.'); load(); refreshStats(); }
          catch (e) { toast(e.message, {error: true}); busy(reopen, false); }
        });
        list.append(row);
      }
      parts.push(h('details', {class: 'later'}, h('summary', {text: `Later (${data.later.length})`}), list));
    }
    setMain(parts);
    highlightLongest();
  }
  load();
})();
