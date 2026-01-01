(() => {
  'use strict';
  // What clients asked their agents for and could not get. The text comes from client servers, so nothing here goes in as HTML.
  const {h, api, toast, badge, ago, fmtDateTime, setMain, fill} = MM;
  const LABELS = {new: 'New', seen: 'Seen', planned: 'Planned', done: 'Done', declined: 'Declined'};
  const root = h('div', null, MM.pageHead('Requests'), MM.loading());
  setMain(root);
  const since = at => ago(new Date(at).toISOString());
  let data, showAll = false;

  async function load() {
    try {
      data = await api('/api/capability-requests'); render();
      // A Board card or a message links here as /requests#<ref>: show that request even when it is closed.
      const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView({block: 'center'});
      else if (location.hash.length > 1 && !showAll && data.groups.some(g => g.ref === location.hash.slice(1))) { showAll = true; render(); document.getElementById(location.hash.slice(1))?.scrollIntoView({block: 'center'}); }
    }
    catch (e) { root.replaceChildren(MM.pageHead('Requests'), MM.errorState(e.message, load)); }
  }
  const isOpen = g => !['done', 'declined'].includes(g.status);
  const who = s => `${s.server} (${s.client})`;
  function statusControl(group) {
    const select = h('select', {'aria-label': 'Status of this request', style: {width: 'auto'}},
      group.status === 'new' ? h('option', {value: 'new', text: LABELS.new, selected: true, disabled: true}) : null,
      data.statuses.map(status => h('option', {value: status, text: LABELS[status], selected: status === group.status})));
    select.addEventListener('change', async () => {
      select.disabled = true;
      try { await api('/api/capability-requests/status', {method: 'POST', body: {key: group.key, status: select.value}}); await load(); }
      catch (e) { toast(e.message, {error: true}); select.disabled = false; select.value = group.status; }
    });
    return select;
  }
  // The request-PR flow's state, from the hub: a label, a reason when it needs Owner, and the draft PR when there is one.
  const agentLine = a => !a ? null : h('p', {class: 'muted'}, `Agent: ${a.label}${a.reason ? `. ${a.reason}` : ''}`,
    a.pr_url && /^https:\/\/github\.com\//.test(a.pr_url) ? [' ', h('a', {href: a.pr_url, target: '_blank', rel: 'noopener noreferrer', text: 'Draft PR'})] : null);
  const card = group => h('article', {class: 'card', id: group.ref},
    h('p', {class: 'p-statement'}, h('strong', {text: group.title})),
    agentLine(group.agent),
    h('p', {class: 'muted', text: `${group.kind}. Asked ${group.count} ${group.count === 1 ? 'time' : 'times'}, last ${since(group.last_at)}.`}),
    h('p', null, group.servers.map(s => h('div', {text: `${who(s)}${s.count > 1 ? `, ${s.count} times` : ''}`}))),
    h('p', null, group.status === 'new' ? badge('new', LABELS.new) : null, ' ', statusControl(group)),
    h('details', null, h('summary', {text: 'What was asked'}), group.needs.map(n => h('p', {class: 'muted', text: `${fmtDateTime(n.at)}, ${n.server}: ${n.need}`}))));

  function render() {
    const open = data.groups.filter(isOpen), shown = showAll ? data.groups : open;
    const chip = (value, label) => h('button', {class: 'chip', type: 'button', 'aria-pressed': String(showAll === value), text: label, onclick: () => { showAll = value; render(); }});
    fill(root,
      MM.pageHead('Requests', h('span', {class: 'count', text: `${open.length} open`})),
      h('div', {class: 'filter-row'}, h('div', {class: 'fu-seg', role: 'group', 'aria-label': 'Show'}, chip(false, 'Open'), chip(true, 'All'))),
      shown.length ? h('section', {class: 'card-list'}, shown.map(card)) : h('p', {class: 'empty', text: showAll ? 'No requests yet.' : 'Nothing open.'}),
      h('section', null, h('div', {class: 'section'}, h('h2', {text: 'Connected servers'})),
        data.connections.length ? data.connections.map(s => h('p', {class: 'muted', text: `${who(s)}: ${s.last_seen ? 'last heard ' + since(s.last_seen) : 'not heard yet'}`}))
          : h('p', {class: 'empty', text: 'No server is connected yet.'})));
  }
  load();
})();
