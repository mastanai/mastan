// Settings: models per role (Owner only), job runs, atlas stats, sign out.
(() => {
  'use strict';
  const {h, api, toast, busy, setMain, fmtDateTime} = window.MM;
  const STAT_LABELS = {positions: 'Positions', needs_confirmation: 'Need confirmation', people: 'People, orgs, projects', connections: 'Connections',
    tensions: 'Tensions', dumps: 'Dumps', open_questions: 'Open questions', last_updated: 'Last atlas change'};

  async function load() {
    let d;
    try { d = await api('/api/settings'); } catch (e) { setMain(MM.pageHead('Settings'), MM.errorState(e.message, load)); return; }
    const selects = {};
    const roles = Object.entries(d.roles || {}).map(([name, r]) => {
      const choices = d.choices?.[r.provider] || [r.model];
      const sel = h('select', {'aria-label': `Model for ${name}`, disabled: d.operator}, (choices.includes(r.model) ? choices : [r.model, ...choices]).map(m => h('option', {value: m, text: m, selected: m === r.model})));
      selects[name] = sel;
      return h('div', {class: 'role'}, h('div', {class: 'name'}, name, h('span', {class: 'prov', text: [r.provider, r.effort].filter(Boolean).join(', ')})), sel);
    });
    const saveBtn = h('button', {class: 'btn primary', type: 'button', text: 'Save models', disabled: d.operator});
    saveBtn.addEventListener('click', async () => {
      busy(saveBtn, true, 'Saving');
      const body = {roles: Object.fromEntries(Object.entries(selects).map(([k, s]) => [k, s.value]))};
      try { const r = await api('/api/settings/models', {method: 'POST', body}); toast(r.changed.length ? `Saved: ${r.changed.join(', ')}.` : 'No change.'); load(); }
      catch (e) { toast(e.message, {error: true}); busy(saveBtn, false); }
    });
    const jobs = d.jobs?.length
      ? h('table', {class: 'jobs'}, h('thead', null, h('tr', null, h('th', {text: 'Job'}), h('th', {text: 'Last run'}), h('th', {text: 'Status'}))),
        h('tbody', null, d.jobs.map(j => h('tr', null, h('td', {class: 'job-name', text: j.job}), h('td', {class: 'job-last', text: fmtDateTime(j.started)}),
          h('td', {class: 'job-status'}, MM.badge(j.status), j.detail ? h('div', {class: 'faint small job-note', text: j.detail}) : null)))))
      : h('p', {class: 'empty', text: 'No job runs yet. Check after the next scheduled run.'});
    const stats = d.stats ? h('dl', {class: 'kv'}, Object.entries(STAT_LABELS).flatMap(([k, label]) => [h('dt', {text: label}),
      h('dd', {text: k === 'last_updated' ? (d.stats[k] ? fmtDateTime(d.stats[k]) : 'never') : (d.stats[k] ?? 0)})])) : h('p', {class: 'error', text: 'Atlas unavailable. Reload to try again.'});
    const signOut = h('button', {class: 'btn', type: 'button', text: 'Sign out'});
    signOut.addEventListener('click', async () => {
      busy(signOut, true);
      try { await api('/api/logout', {method: 'POST'}); } catch {}
      location.replace('/login');
    });
    setMain(
      MM.pageHead('Settings'),
      h('div', {class: 'settings-grid'}, h('div', {class: 'settings-column'}, h('section', {class: 'card'}, h('h2', {text: 'Models'}),
        h('p', {class: 'muted small', text: d.operator ? 'Operator session: read only. Only Owner changes models.' : 'Only you change these. Nothing switches on its own.'}),
        roles, h('div', {class: 'btn-row'}, saveBtn),
        d.changed_at ? h('p', {class: 'faint small', text: `Last change ${fmtDateTime(d.changed_at)} by ${d.changed_by || 'unknown'}`}) : null),
      h('section', {class: 'card'}, h('h2', {text: 'Atlas'}), stats)),
      h('div', {class: 'settings-column'}, h('section', {class: 'card table-card'}, h('h2', {text: 'Jobs'}), h('div', {class: 'fu-scroll'}, jobs)),
      h('section', {class: 'card'}, h('h2', {text: 'Session'}), h('p', {class: 'muted small', text: 'Signs out this browser only.'}), signOut))));
  }
  load();
})();
