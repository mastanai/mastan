(() => {
  'use strict';
  const {h, api, setMain, toast} = MM;
  // Who uses Mastan: ids, places and counts, no message text. The list opens for the signed-in owner,
  // and lives in this page's memory, so it goes away with the tab.
  const whole = n => Math.round(n || 0).toLocaleString('en-US');
  const day = ts => ts ? MM.fmtDate(ts * 1000) : '';
  const SERVERS = {'mac-wa': 'Mac WP', 'mac-tg': 'Mac TG', 'mac-old-wa': 'Old Mac WP', 'mac-old-tg': 'Old Mac TG', mac: 'Mac mini', 'prod-01': 'Canary', 'dev-01': 'dev-01', 'client-a-01': 'Client A', 'client-c-01': 'Client C', 'client-d-01': 'Client D', 'client-b-01': 'Client B (old)'};
  const serverName = s => SERVERS[s] || s;
  // The stats job tags the Mac mini by channel (Mac WP = WhatsApp, Mac TG = Telegram), only for Owner, Work and Business.
  // Old Mac WP / TG: wrote only to the old Mac; the tag goes once they write to any other server.
  // Plan with a days-left counter: trial = welcome month, paid = days until the next payment (or until it ends if cancelled).
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
  const daysLeft = ts => Math.max(0, Math.ceil((ts * 1000 - Date.now()) / 864e5));
  const plural = n => `${n} day${n === 1 ? '' : 's'} left`;
  function planText(p) {
    const name = cap(p.plan);
    if (p.plan_kind === 'trial' && p.plan_ends) return `${name} trial, ${plural(daysLeft(p.plan_ends))}`;
    if (p.plan_kind === 'paid' && p.plan_ends) return `${name} paid, ${plural(daysLeft(p.plan_ends))}${p.plan_cancel ? ', then ends' : ''}`;
    if (p.plan_kind === 'gift') return `${name} free forever`;
    if (p.plan_kind === 'free') return 'Free';
    return name;
  }
  // Share of the weekly Codex limit (ChatGPT Pro) this person used in the last 7 days, from the subscription meter.
  const CODEX_TITLE = 'Share of the weekly Codex limit used in the last 7 days. Estimated by the subscription meter; canary users only.';
  const codex = p => p.codex_7d == null ? '—' : p.codex_7d === 0 ? '0%' : p.codex_7d < 0.1 ? '<0.1%' : p.codex_7d.toFixed(1) + '%';
  const userTitle = p => p.name && p.name !== p.id && !p.masked ? p.name : null;
  const SOURCES = {whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Web'};
  const sourceName = s => SOURCES[s] || s;
  const sourcesOf = p => Object.keys(SOURCES).filter(s => p.channels.includes(s)).map(sourceName).join(', ');
  const heading = note => MM.pageHead('People', h('span', {class: 'muted small', text: note}));
  const languageName = code => { try { return code ? new Intl.DisplayNames(['en'], {type: 'language'}).of(code) : ''; } catch { return code; } };
  let people = null, clientIds = new Set();
  function clientButton(p) {
    if (!MM.pickablePerson(p)) return null;
    const button = h('button', {type: 'button', class: 'btn', text: clientIds.has(p.id) ? 'In Clients' : 'Add to Clients', disabled: clientIds.has(p.id)});
    button.onclick = async () => {
      button.disabled = true;
      try { await api('/api/clients', {method: 'POST', body: MM.personFields(p)}); clientIds.add(p.id); button.textContent = 'In Clients'; toast('Added to Clients'); }
      catch (e) { toast(e.message, {error: true}); button.disabled = false; }
    };
    return button;
  }
  const view = {search: '', country: '', language: '', server: '', source: '', plan: '', active: ''};
  // Sorting: click a header; click again to flip. Empty values always go last. The choice is remembered in this browser.
  const PLAN_ORDER = {paid: 0, trial: 1, gift: 2, free: 3};
  const COLUMNS = [
    {label: 'User', key: 'user', value: p => p.id.toLowerCase(), first: 1},
    {label: 'Country', key: 'country', value: p => p.country === 'Unknown' ? null : p.country, first: 1},
    {label: 'Language', key: 'language', value: p => languageName(p.language) || null, first: 1},
    {label: 'Source', key: 'source', value: p => sourcesOf(p) || null, first: 1},
    // Plan: paid, trial, free forever, free; inside a group the fewest days left come first.
    {label: 'Plan', key: 'plan', value: p => p.plan_kind ? PLAN_ORDER[p.plan_kind] * 1e10 + (p.plan_ends || 0) : null, first: 1},
    {label: 'First', key: 'first', value: p => p.first || null, first: -1},
    {label: 'Last', key: 'last', value: p => p.last || null, first: -1},
    {label: 'Codex 7d', key: 'codex', value: p => p.codex_7d, first: -1, title: CODEX_TITLE},
    {label: 'Clients', key: null},
  ];
  const SORT_KEY = 'mm-people-sort';
  let sort = {key: 'last', dir: -1};
  try { const saved = JSON.parse(localStorage.getItem(SORT_KEY)); if (saved && COLUMNS.some(c => c.key && c.key === saved.key) && [1, -1].includes(saved.dir)) sort = saved; } catch {}
  function sorted(list) {
    const col = COLUMNS.find(c => c.key === sort.key);
    return list.map((p, i) => [col.value(p), i, p]).sort(([a, i], [b, j]) => {
      if (a == null || b == null) return a == null && b == null ? i - j : a == null ? 1 : -1;
      const d = typeof a === 'string' ? a.localeCompare(b) : a - b;
      return d * sort.dir || i - j;
    }).map(x => x[2]);
  }
  const PLANS = {trial: 'Trial', ending: 'Trial ends within 7 days', paid: 'Paid', gift: 'Free forever', free: 'Free', none: 'No plan (not on canary)'};
  const ACTIVE = {day: 'Active last 24 hours', week: 'Active last 7 days', month: 'Active last 30 days', quiet: 'Quiet 30+ days'};
  function planMatches(p) {
    if (!view.plan) return true;
    if (view.plan === 'none') return !p.plan_kind;
    if (view.plan === 'ending') return p.plan_kind === 'trial' && p.plan_ends && daysLeft(p.plan_ends) <= 7;
    return p.plan_kind === view.plan;
  }
  function activeMatches(p) {
    if (!view.active) return true;
    const age = p.last ? (Date.now() / 1000 - p.last) / 86400 : Infinity;
    return view.active === 'quiet' ? age > 30 : age <= {day: 1, week: 7, month: 30}[view.active];
  }

  async function load() {
    try {
      people = await MM.loadPeople();
      clientIds = new Set((await api('/api/clients/person-ids', {method: 'POST', body: {}})).person_ids);
      list();
    } catch (error) {
      setMain(heading(error.message), h('button', {class: 'btn primary', type: 'button', text: 'Try again', onclick: load}));
    }
  }

  function matches(p) {
    if (view.country && p.country !== view.country) return false;
    if (view.server && !p.servers.includes(view.server)) return false;
    if (view.source && !p.channels.includes(view.source)) return false;
    if (view.language && p.language !== view.language) return false;
    if (!planMatches(p) || !activeMatches(p)) return false;
    // WhatsApp Web wraps copied numbers in invisible direction marks; drop them first.
    const text = view.search.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim().toLowerCase();
    if (!text) return true;
    // A pasted number like "+994 50 123 45 67" or "(050) 123-45-67" matches on its digits alone.
    if (/^[\d\s+()\-.\u00a0\u202f]+$/.test(text)) {
      const digits = text.replace(/\D/g, '');
      if (digits.length >= 3) return [p.id, p.name].some(s => (s || '').replace(/\D/g, '').includes(digits.replace(/^0+/, '')));
    }
    return [p.id, p.name, p.country, p.language, p.plan, planText(p), ...p.channels].join(' ').toLowerCase().includes(text);
  }

  function rows(body, count) {
    const shown = sorted(people.filter(matches));
    count.textContent = `${whole(shown.length)} of ${whole(people.length)} people`;
    // Hidden here but still in the data for reports: name, servers, message counts, tokens and cost.
    body.replaceChildren(...shown.map(p => h('tr', {},
      h('td', {class: p.masked ? 'pp-masked' : null, 'data-label': 'User', title: userTitle(p), text: p.id}),
      h('td', {'data-label': 'Country', text: p.country}),
      h('td', {'data-label': 'Language', text: languageName(p.language)}),
      h('td', {'data-label': 'Source', text: sourcesOf(p)}),
      h('td', {'data-label': 'Plan', text: planText(p)}),
      h('td', {'data-label': 'First', text: day(p.first)}),
      h('td', {'data-label': 'Last', text: day(p.last)}),
      h('td', {'data-label': 'Codex 7d', title: CODEX_TITLE, text: codex(p)}),
      h('td', {'data-label': 'Clients'}, clientButton(p)),
      h('td', {class: 'pp-compact', colspan: 9},
        h('div', {class: 'pp-identity'}, h('strong', {class: p.masked ? 'pp-masked' : '', text: p.id})),
        h('div', {class: 'pp-profile', text: [sourcesOf(p), p.country, languageName(p.language), planText(p)].filter(Boolean).join(' · ')}),
        clientButton(p), h('div', {class: 'pp-activity'}, h('span', {text: `First ${day(p.first) || 'unknown'} · last ${day(p.last) || 'unknown'} · Codex 7d ${codex(p)}`}))))));
    if (!shown.length) body.append(h('tr', null, h('td', {colspan: 9}, MM.empty('No matches. Clear the search or choose another filter.'))));
  }

  function list() {
    const body = h('tbody', {}), count = h('span', {class: 'muted small'});
    const refresh = () => rows(body, count);
    const select = (key, first, values, label = v => v) => h('select', {'aria-label': first, onchange: e => { view[key] = e.target.value; refresh(); }},
      h('option', {value: '', text: first}), values.map(v => h('option', {value: v, text: label(v), selected: view[key] === v})));
    const clear = h('button', {type: 'button', class: 'btn', text: 'Clear filters', onclick: () => { Object.keys(view).forEach(k => { view[k] = ''; }); list(); }});
    const countries = [...new Set(people.map(p => p.country))].sort((a, b) => (a === 'Unknown') - (b === 'Unknown') || a.localeCompare(b));
    const servers = [...new Set(people.flatMap(p => p.servers))].sort((a, b) => serverName(a).localeCompare(serverName(b)));
    const sources = Object.keys(SOURCES).filter(s => people.some(p => p.channels.includes(s)));
    const languages = [...new Set(people.map(p => p.language).filter(Boolean))].sort((a, b) => languageName(a).localeCompare(languageName(b)));
    const headCells = COLUMNS.map(c => {
      if (!c.key) return h('th', {text: c.label});
      const on = sort.key === c.key;
      const button = h('button', {type: 'button', class: 'pp-sort' + (on ? ' on' : ''), title: c.title || `Sort by ${c.label}`,
        text: c.label + (on ? (sort.dir === 1 ? ' ↑' : ' ↓') : '')});
      button.onclick = () => {
        sort = on ? {key: c.key, dir: -sort.dir} : {key: c.key, dir: c.first};
        try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch {}
        list();
      };
      return h('th', {'aria-sort': on ? (sort.dir === 1 ? 'ascending' : 'descending') : null}, button);
    });
    const head = h('thead', {}, h('tr', {}, headCells));
    const sortedBy = COLUMNS.find(c => c.key === sort.key).label;
    setMain(heading(`Sorted by ${sortedBy}. Click a column to sort. No message text here. Client-server numbers are masked.`),
      h('div', {class: 'fu'}, h('section', {class: 'card fu-panel'},
        h('div', {class: 'pp-filters'},
          h('input', {type: 'search', placeholder: 'Search number, name, country', 'aria-label': 'Search', value: view.search, oninput: e => { view.search = e.target.value; refresh(); }}),
          h('div', {class: 'filter-row'}, select('plan', 'All plans', Object.keys(PLANS), k => PLANS[k]), select('active', 'Any time', Object.keys(ACTIVE), k => ACTIVE[k]),
            select('country', 'All countries', countries), select('language', 'All languages', languages, languageName),
            select('server', 'All servers', servers, serverName), select('source', 'All sources', sources, sourceName), clear)), count,
        h('div', {class: 'fu-scroll pp-list', tabindex: 0, role: 'region', 'aria-label': 'People'}, h('table', {class: 'fu-table pp-table'}, head, body)))));
    refresh();
  }

  load();
})();
