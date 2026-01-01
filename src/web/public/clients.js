(() => {
  'use strict';
  const {h, api, setMain, toast, fmtDate, fmtDateTime, badge, busy, ago} = MM;
  const TAGS = [['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold'], ['not_sure', 'Not sure'], ['customer', 'Customer'], ['lost', 'Lost']];
  const PLANS = ['Plus', 'Pro', 'Private', 'Enterprise', 'Other'];
  const SORTS = [['action', 'Next action first'], ['payment', 'Next payment'], ['lifetime', 'Lifetime paid'], ['margin', 'Margin'], ['newest', 'Newest']];
  const day = (at = Date.now()) => new Date(at + 3 * 3600_000).toISOString().slice(0, 10);
  const addDays = n => new Date(Date.parse(day() + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
  const date = value => value ? fmtDate(value) : 'Unknown';
  const clock = fmtDateTime;
  const money = (n, currency = 'usd') => currency === 'usd' ? new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2}).format(n) : `${currency.toUpperCase()} ${new Intl.NumberFormat('en-US', {minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Math.max(2, new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits)}).format(n)}`;
  const amounts = (value, empty = 'Unknown') => Object.entries(value || {}).sort(([a], [b]) => a === 'usd' ? -1 : b === 'usd' ? 1 : a.localeCompare(b)).map(([c, n]) => money(n, c)).join(' + ') || empty;
  const unknown = value => h('span', {class: value === 'Unknown' ? 'muted' : '', text: value});
  const button = (text, onclick, attrs = {}) => h('button', {type: 'button', class: 'btn', text, onclick, ...attrs});
  const option = (value, text, selected) => h('option', {value, text, selected: value === selected});
  const select = (values, value, attrs = {}) => h('select', attrs, values.map(([k, text]) => option(k, text, value)));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('clients.view') || '{}') || {}; } catch {}
  const view = {segment: ['all', 'paying', 'leads'].includes(saved.segment) ? saved.segment : 'all',
    tag: ['', 'none', ...TAGS.map(([k]) => k)].includes(saved.tag) ? saved.tag : '', plan: PLANS.includes(saved.plan) ? saved.plan : '',
    search: typeof saved.search === 'string' ? saved.search.slice(0, 200) : '', sort: SORTS.some(([k]) => k === saved.sort) ? saved.sort : 'action',
    focus: ['paying', 'mrr', 'due', 'overdue', 'follow', 'risk', 'deal'].includes(saved.focus) ? saved.focus : ''};
  const remember = () => { try { localStorage.setItem('clients.view', JSON.stringify(view)); } catch {} };
  const host = h('div', {class: 'cl'});
  const phoneFilters = matchMedia('(max-width: 699px)');
  let data, list, count, tags, kpiHost;
  phoneFilters.addEventListener('change', () => { if (data) render(); });
  const isFocus = p => !view.focus || ({paying: p.paying, mrr: p.status === 'active' || p.cancelling && !p.overdue_since, due: p.due_soon, overdue: p.overdue_since, follow: p.follow_up_due || p.deal_ending, deal: Boolean(p.deal), risk: p.at_risk}[view.focus]);
  const displayTag = p => p.tag || (p.paying ? 'customer' : p.status === 'canceled' ? 'lost' : 'none');
  const stripeMissing = () => data.mode === 'error' || Boolean(data.stale);
  const absent = text => stripeMissing() ? 'Unknown' : text;
  const peopleCount = n => `${n} ${n === 1 ? 'person' : 'people'}`;
  const filtered = () => data.people.filter(p => (view.segment === 'all' || (view.segment === 'paying' ? p.paying : !p.customer && !p.paying)) &&
    (!view.tag || displayTag(p) === view.tag) && (!view.plan || planOf(p) === view.plan) && isFocus(p) &&
    [p.name, p.email, p.phone, p.company, p.notes].some(s => String(s || '').toLowerCase().includes(view.search.toLowerCase())));
  function sortPeople(rows) {
    const action = (a, b) => a.action_rank - b.action_rank || String(a.follow_up || '9999').localeCompare(b.follow_up || '9999') || (a.overdue_since || Infinity) - (b.overdue_since || Infinity);
    return rows.sort((a, b) => {
      let diff = 0;
      if (view.sort === 'action') diff = action(a, b);
      if (view.sort === 'payment') diff = (a.overdue_since || a.next_due || Infinity) - (b.overdue_since || b.next_due || Infinity);
      // Mixed currencies have no comparable total, so put them after USD-only totals.
      if (view.sort === 'lifetime') diff = usdLifetime(b) - usdLifetime(a);
      if (view.sort === 'margin') diff = (b.margin ?? -Infinity) - (a.margin ?? -Infinity);
      if (view.sort === 'newest') diff = (b.created_at || 0) - (a.created_at || 0);
      return diff || a.name.localeCompare(b.name);
    });
  }
  const usdLifetime = p => Object.keys(p.lifetime).every(c => c === 'usd') ? p.lifetime.usd || 0 : -Infinity;
  const write = (action, p, fields = {}) => api('/api/clients/' + action, {method: 'POST', body: {id: p.id, ...fields}});
  // A connected server is a Private client, whatever Stripe calls the price. Before the first payment Stripe knows nothing, so the plan state speaks.
  const onServer = p => Boolean(p.billing?.connected);
  const planOf = p => onServer(p) ? 'Private' : p.plan;
  const SERVER_RUNNING = ['requested', 'awaiting', 'active', 'past_due', 'paused', 'free'];
  const amountOf = (p, empty) => Object.keys(p.amount || {}).length || !onServer(p) || !p.billing.amount || !SERVER_RUNNING.includes(p.billing.state) ? amounts(p.amount, empty) : money(p.billing.amount);
  const SERVER_STATUS = {requested: ['pending', 'Request sent'], awaiting: ['pending', 'Asked to pay'], paused: ['overdue', 'Stopped'], free: ['overdue', 'On Free'], retired: ['overdue', 'Ready to retire'], stopped: ['off', 'Billing stopped']};
  const statusBadge = p => { const own = onServer(p) && SERVER_STATUS[p.billing.state]; return own ? badge(...own) : badge(p.overdue_since ? 'overdue' : p.cancelling ? 'cancelling' : p.status, p.status_label); };
  const STATES = {none: 'No plan yet', requested: 'Waiting for the server to deliver the request', awaiting: 'Asked to pay', active: 'Paying',
    past_due: 'Card failed', paused: 'Stopped: out of balance', free: 'On Free limits, server notice sent', retired: 'Ready to retire the server', stopped: 'Billing stopped by you'};
  function billingSection(p, close) {
    const b = p.billing, error = h('p', {class: 'cl-bad', role: 'alert'}), when = at => at ? date(at) + ' ' + clock(at) : '-';
    const act = async (action, fields, done) => {
      error.textContent = '';
      try { await write('billing/' + action, p, fields); toast(done); close(); await load(); }
      catch (e) { error.textContent = e.message; }
    };
    const amount = h('input', {id: 'cl-billing-amount', type: 'number', min: '1', step: '1', value: b.amount ?? '', 'aria-label': 'Monthly amount in US dollars'});
    const days = h('input', {id: 'cl-billing-days', type: 'number', min: '1', max: '365', step: '1', value: '3', 'aria-label': 'Extra days'});
    const send = button('Send', () => {
      if (!amount.value) { error.textContent = 'Enter a monthly amount.'; return; }
      if (confirm(`Ask ${p.name} to pay $${amount.value} every month? Their agent sends the message, and they have 24 hours from delivery.`)) void act('send', {amount: Number(amount.value)}, 'Request sent to the server');
    }, {class: 'btn primary'});
    const fact = (label, text) => h('div', {}, h('dt', {text: label}), h('dd', {text}));
    const facts = [fact('Status', STATES[b.state] || b.state), fact('Server', b.server + (b.last_seen ? ', seen ' + ago(new Date(b.last_seen).toISOString()) : ', not seen yet')), fact('Amount', b.amount ? money(b.amount) + ' / month' : '-')];
    if (b.pay_by) facts.push(fact('Pay by', when(b.pay_by)));
    if (b.period_end && b.state === 'active') facts.push(fact('Next charge', when(b.period_end)));
    if (b.retire_at) facts.push(fact('Retire server on', when(b.retire_at)));
    if (b.hold_until) facts.push(fact('Extra days until', when(b.hold_until)));
    if (b.waiting.length) facts.push(fact('Waiting to deliver', b.waiting.join(', ')));
    const running = ['requested', 'awaiting', 'active', 'past_due', 'paused', 'free'].includes(b.state);
    return h('section', {class: 'cl-billing'}, h('h3', {text: 'Monthly plan'}), h('dl', {class: 'cl-facts'}, facts),
      !running || b.state === 'requested' || b.state === 'awaiting' ? h('div', {class: 'btn-row'}, h('label', {for: 'cl-billing-amount', text: '$ a month'}), amount, send) : null,
      running ? h('div', {class: 'btn-row'}, h('label', {for: 'cl-billing-days', text: 'Days'}), days,
        button('Give extra days', () => void act('days', {days: Number(days.value)}, 'Extra days given')),
        button('Stop billing', () => { if (confirm(`Stop billing ${p.name}? The Stripe plan is cancelled and the agent keeps answering.`)) void act('stop', {}, 'Billing stopped'); })) : null,
      error);
  }
  function tagSelect(p) {
    const value = displayTag(p);
    const el = select([['none', 'No tag'], ...TAGS], value,
      {class: 'cl-tag cl-tag-' + value + (p.tag_default ? ' cl-tag-soft' : ''), 'aria-label': 'Tag for ' + p.name, disabled: p.sample});
    el.addEventListener('change', async () => {
      el.disabled = true;
      try { await write('update', p, {tag: el.value === 'none' ? null : el.value}); toast('Tag saved'); await load(); }
      catch (error) { el.value = p.tag_default && value !== 'none' ? '' : value; toast(error.message, {error: true}); }
      finally { el.disabled = Boolean(p.sample); }
    });
    if (p.tag_default && value !== 'none') {
      const soft = h('option', {value: '', text: p.tag_label, selected: true, hidden: true, disabled: true});
      el.prepend(soft); el.value = '';
    }
    return el;
  }
  function nextDate(p, compact = false) {
    const follow = compact && !p.overdue_since && p.follow_up && (p.follow_up_due || !p.next_due && !p.cancelling);
    const label = follow ? 'Follow up' : p.overdue_since ? 'Overdue since' : p.cancelling ? 'Ends' : 'Next payment';
    const at = follow ? p.follow_up : p.overdue_since || (p.cancelling ? p.period_end : p.next_due);
    return h('div', {class: p.overdue_since ? 'cl-next cl-bad' : 'cl-next'}, h('small', {text: label}), unknown(at ? date(at) : absent('-')));
  }
  function llm(p) {
    const cost = p.cost.period ?? p.cost.last_30;
    const text = p.llm_covered === null ? 'Unknown' : p.llm_covered === 0 ? 'Not on us' : cost === null ? 'Unknown' : 'On us, ' + money(cost);
    return unknown(text);
  }
  const margin = p => h('div', {title: p.margin_label}, unknown(p.margin === null ? 'Unknown' : money(p.margin)),
    p.margin_percent !== null && h('small', {class: p.margin < 0 ? 'cl-bad' : 'muted', text: Math.round(p.margin_percent) + '%'}));
  function drawList() {
    remember();
    const rows = sortPeople(filtered());
    count.textContent = `${rows.length} ${rows.length === 1 ? 'person' : 'people'}${data.mode === 'sample' ? ' (includes samples)' : ''}`;
    list.replaceChildren();
    if (!rows.length) { list.append(h('p', {class: 'empty', text: 'No matches. Try clearing filters.'}), button('Clear filters', clear)); return; }
    const columns = ['Name + contact', 'Tag', 'Plan', 'Amount', 'Status', 'Last paid', 'Next due', 'Lifetime', 'LLM', 'Margin', 'Follow-up', 'Deal'];
    const table = h('table', {class: 'cl-table'}, h('caption', {class: 'sr-only', text: 'Clients and leads'}),
      h('thead', {}, h('tr', {}, columns.map(text => h('th', {scope: 'col', text})))));
    const body = h('tbody');
    for (const p of rows) {
      const cells = [h('div', {}, button(p.name || 'Unnamed lead', () => detail(p), {class: 'cl-person'}),
        h('span', {class: 'cl-contact muted', text: p.email || p.phone || p.company || 'No contact'})), tagSelect(p),
      h('div', {}, h('span', {class: 'cl-desktop'}, unknown(planOf(p) || absent('-'))), h('span', {class: 'cl-mobile cl-summary', text: [planOf(p), amountOf(p, absent('-'))].filter(Boolean).join(', ')}), p.plan_detail && h('small', {class: 'muted', text: p.plan_detail})),
      h('div', {}, unknown(amountOf(p, absent('-'))), h('small', {class: 'muted', text: p.plan || amountOf(p, '') ? '/ month' : ''})),
      h('div', {}, statusBadge(p),
        p.discount && h('small', {class: 'cl-warn', text: p.discount})), unknown(p.last_paid ? date(p.last_paid) : absent('None')), h('div', {}, h('div', {class: 'cl-desktop'}, nextDate(p)), h('div', {class: 'cl-mobile'}, nextDate(p, true))), unknown(amounts(p.lifetime, absent('None'))), llm(p), margin(p),
      h('span', {class: p.follow_up_due ? 'cl-warn' : 'muted', text: p.follow_up ? date(p.follow_up) : 'Not set'}), h('span', {class: 'muted', text: p.deal?.label || 'None'})];
      const names = ['name', 'tag', 'plan', 'amount', 'status', 'paid', 'due', 'lifetime', 'llm', 'margin', 'follow', 'deal'];
      body.append(h('tr', {}, cells.map((cell, i) => h('td', {class: 'cl-' + names[i] + (names[i] === 'margin' && p.margin === null ? ' cl-margin-unknown' : ''), 'data-label': columns[i]}, cell))));
    }
    table.append(body); list.append(table);
  }
  function clear() { Object.assign(view, {segment: 'all', tag: '', plan: '', search: '', focus: ''}); render(); }
  function applyFocus(focus) { Object.assign(view, {segment: 'all', tag: '', plan: '', search: '', focus: view.focus === focus ? '' : focus}); render(); }
  function drawTags() {
    tags.replaceChildren(...[['', 'All tags'], ['none', 'No tag'], ...TAGS].map(([key, text]) => {
      const n = data.people.filter(p => (!p.sample || data.mode === 'sample') && (!key || displayTag(p) === key)).length;
      return button(`${text} ${n}`, () => { view.tag = key; drawTags(); drawList(); }, {class: 'chip', 'aria-pressed': String(view.tag === key)});
    }));
  }
  function render() {
    const refresh = button('Refresh', async () => { busy(refresh, true, 'Refreshing'); try { await load(true); } finally { busy(refresh, false); } });
    const updated = data.updated_at ? 'Updated ' + fmtDateTime(data.updated_at) : 'No Stripe update yet';
    const heading = MM.pageHead('Clients',
      h('div', {class: 'cl-toolbar'}, h('div', {class: 'cl-updated'}, badge(data.mode, data.mode.toUpperCase()),
        h('span', {class: 'muted small', text: updated})), h('div', {class: 'fu-controls'}, refresh, button('Add lead', () => detail(null), {class: 'btn primary'}))));
    const alerts = [];
    if (data.mode === 'sample') alerts.push(h('li', {class: 'card cl-sample'}, h('div', {}, h('b', {text: 'Sample data. Stripe is not connected.'}),
      h('p', {text: 'Install a restricted read key for Customers, Subscriptions, and Charges at /etc/mastan-me/stripe-read-key. Sample rows cannot be saved. Totals include samples.'}))));
    if (data.warning) alerts.push(h('li', {class: 'card cl-warn', text: data.stale && data.updated_at ? `${data.warning.split('.')[0]}, showing data from ${clock(data.updated_at)} (Riyadh).` : data.warning}));
    if (data.feed.warning) alerts.push(h('li', {class: 'card cl-warn', role: 'alert', text: data.feed.warning}));
    if (data.feed.state !== 'ready') alerts.push(h('li', {class: 'card cl-warn', text: data.feed.state === 'stale' ? 'Canary data is over 48 hours old. Public LLM costs are Unknown.' : 'Canary unavailable. Private requests and public LLM costs are unavailable.'}));
    if (data.truncated) alerts.push(h('li', {class: 'card cl-warn', text: 'Stripe list limit reached. Some people or payments may be missing.'}));
    const k = data.kpis, unavailable = data.mode === 'error' || data.stale && !data.updated_at;
    kpiHost = h('section', {class: 'fu-kpis cl-kpis', 'aria-label': 'Sales totals'},
      [['paying', 'Paying', unavailable ? 'Unknown' : String(k.paying), 'Active, past due, or cancelling'], ['mrr', 'MRR', unavailable ? 'Unknown' : amounts({usd: 0, ...k.mrr}), 'At risk: ' + (unavailable ? 'Unknown' : amounts({usd: 0, ...k.at_risk.amount}) + ` (${k.at_risk.count})`)],
        ['due', 'Due in 7 days', unavailable ? 'Unknown' : amounts({usd: 0, ...k.due.amount}), unavailable ? 'Stripe unavailable' : peopleCount(k.due.count)], ['overdue', 'Overdue', unavailable ? 'Unknown' : amounts({usd: 0, ...k.overdue.amount}), unavailable ? 'Stripe unavailable' : peopleCount(k.overdue.count)],
        ['follow', 'Follow-ups', String(k.follow_ups), 'Due or deal ending soon'], ['deal', 'Given up each month', money(k.given_up || 0), 'Active deals with known prices']].map(([key, label, value, note]) =>
        button('', () => applyFocus(key), {class: 'card fu-kpi cl-kpi', 'aria-pressed': String(view.focus === key)}).appendChild(h('span', {}, h('span', {class: 'muted small', text: label}), h('b', {class: 'fu-value' + (value === 'Unknown' ? ' muted' : ''), text: value}), h('span', {class: 'fu-faint' + (key === 'paying' ? ' cl-paying-note' : ''), text: note, title: note}))).parentNode));
    const focus = data.people.filter(p => (!p.sample || data.mode === 'sample') && p.action_rank < 6).sort((a, b) => a.action_rank - b.action_rank).slice(0, 5);
    const today = h('section', {class: 'card cl-today'}, h('div', {class: 'fu-head'}, h('h2', {text: 'Today'}),
      button(`At risk ${k.at_risk.count}`, () => applyFocus('risk'), {class: 'btn cl-risk', 'aria-pressed': String(view.focus === 'risk')})),
    focus.length ? h('div', {class: 'cl-focus'}, focus.map(p => button('', () => detail(p), {class: 'cl-focus-person'}).appendChild(h('span', {}, h('b', {text: p.name}), h('small', {class: p.overdue_since ? 'cl-bad' : p.follow_up_due ? 'cl-warn' : '', text: p.action_rank === 1 && p.follow_up && !p.deal_ending ? 'Follow up ' + date(p.follow_up) : p.action_reason}))).parentNode)) : MM.empty('Nothing to chase today. Choose a client below to add a follow-up.'));
    const segment = h('div', {class: 'fu-seg', role: 'group', 'aria-label': 'People'}, [['all', 'All'], ['paying', 'Paying'], ['leads', 'Leads']].map(([key, text]) =>
      button(text, () => { view.segment = key; view.focus = ''; render(); }, {'aria-pressed': String(view.segment === key)})));
    const search = h('input', {type: 'search', placeholder: 'Search people and notes', value: view.search, 'aria-label': 'Search people and notes', maxlength: 200});
    search.addEventListener('input', () => { view.search = search.value; drawList(); });
    const plan = select([['', 'All plans'], ...PLANS.map(p => [p, p])], view.plan, {'aria-label': 'Plan'});
    plan.addEventListener('change', () => { view.plan = plan.value; drawList(); });
    const sort = select(SORTS, view.sort, {'aria-label': 'Sort'});
    sort.addEventListener('change', () => { view.sort = sort.value; drawList(); });
    tags = h('div', {class: 'chips cl-tags', role: 'group', 'aria-label': 'Tags'});
    count = h('p', {class: 'muted small', role: 'status'});
    list = h('div', {class: 'card table-card cl-list'});
    const secondary = phoneFilters.matches ? h('details', {class: 'filter-more'}, h('summary', {text: 'Filters'}),
      h('div', {class: 'filter-row'}, tags, plan, sort)) : null;
    const controls = h('section', {class: 'card cl-controls'},
      h('div', {class: 'filter-row cl-filter-top'}, segment, button('With a deal', () => applyFocus('deal'), {class: 'chip', 'aria-pressed': String(view.focus === 'deal')}), button('Clear filters', clear, {class: 'btn ghost'})),
      phoneFilters.matches ? null : h('div', {class: 'cl-filter-fields'}, tags, search, plan, sort),
      phoneFilters.matches ? h('div', {class: 'filter-search'}, search) : null, secondary,
      view.focus && h('p', {class: 'cl-warn small', text: 'Filtered by ' + ({paying: 'Paying', mrr: 'MRR', due: 'Due in 7 days', overdue: 'Overdue', follow: 'Follow-ups', risk: 'At risk', deal: 'With a deal'}[view.focus])}));
    host.replaceChildren(heading, h('ul', {class: 'fu-alerts'}, alerts), ...(data.mode === 'sample' ? [h('p', {class: 'muted small cl-kpi-caption', text: 'Sample'})] : []), kpiHost, today, controls);
    if (data.mode === 'live' && !data.warning && !data.kpis.paying) host.append(h('p', {class: 'card', text: 'No paying customers yet'}));
    host.append(count, list, h('p', {class: 'muted small cl-footer', text: `All dates use Riyadh time. Canary data from ${data.feed.generated_at ? clock(data.feed.generated_at) : 'Unknown'}. Margin is before Stripe fees and server.`}));
    setMain(host); drawTags(); drawList();
  }
  function peoplePicker(fill) {
    let pool = [], alive = true;
    const error = h('p', {class: 'cl-bad', role: 'alert'}), results = h('div', {class: 'fu-scroll'});
    const dialog = h('dialog', {class: 'cl-dialog', 'aria-label': 'Pick from People'});
    const close = () => { alive = false; pool = []; results.replaceChildren(); dialog.close(); dialog.remove(); };
    const search = h('input', {type: 'search', placeholder: 'Search name or number', 'aria-label': 'Search People'});
    const country = select([['', 'All countries']], '', {'aria-label': 'Country'}), plan = select([['', 'All plans']], '', {'aria-label': 'Plan'});
    const active = select([['', 'Last active, any time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']], '', {'aria-label': 'Last active'});
    const draw = () => {
      const text = search.value.trim().toLowerCase();
      const rows = pool.filter(p => (!country.value || p.country === country.value) && (!plan.value || p.plan === plan.value) && (!active.value || p.last * 1000 >= Date.now() - +active.value * 86400_000) && [p.name, p.id].join(' ').toLowerCase().includes(text));
      results.replaceChildren(h('table', {class: 'fu-table'}, h('thead', {}, h('tr', {}, ['Name', 'Number', 'Country', 'Language', 'Plan', 'Last active', 'Messages'].map(text => h('th', {text})))),
        h('tbody', {}, rows.map(p => h('tr', {}, h('td', {}, button(p.name || 'Unnamed', () => { fill(MM.personFields(p)); close(); })),
          ...[p.id, p.country, p.language, p.plan, p.last ? date(p.last * 1000) : 'Unknown', String((p.messages_in || 0) + (p.messages_out || 0))].map(text => h('td', {text})))))));
      if (!rows.length) results.append(MM.empty('No matches. Try another filter.'));
    };
    for (const el of [search, country, plan, active]) el.addEventListener(el === search ? 'input' : 'change', draw);
    const load = button('Load People', async () => {
      busy(load, true, 'Loading'); error.textContent = '';
      try {
        const rows = await MM.loadPeople(); if (!alive) return;
        pool = rows.filter(MM.pickablePerson);
        for (const [el, key] of [[country, 'country'], [plan, 'plan']]) for (const value of [...new Set(pool.map(p => p[key]).filter(Boolean))].sort()) el.append(option(value, value, ''));
        load.remove(); draw();
      } catch (e) { if (alive) error.textContent = e.message; }
      finally { busy(load, false); }
    }, {class: 'btn primary'});
    dialog.append(h('div', {class: 'cl-dialog-head'}, h('h2', {text: 'Pick from People'}), button('Close', close)),
      h('div', {class: 'cl-dialog-body'}, h('p', {class: 'muted small', text: 'Client-server contacts are not shown.'}), load, error,
        h('div', {class: 'filter-row'}, search, country, plan, active), results));
    dialog.addEventListener('close', close, {once: true}); document.body.append(dialog); dialog.showModal(); load.click();
  }
  function dealSection(p, close) {
    const d = p.deal, error = h('p', {class: 'cl-bad', role: 'alert'}), previewHost = h('div');
    const section = h('section', {}, h('h3', {text: 'Deal'}));
    const fact = (label, text) => h('div', {}, h('dt', {text: label}), h('dd', {text}));
    const states = {waiting: 'Waiting for an account', draft: 'Not applied', queued: 'Waiting for Mastan', link: 'Link ready, waiting for payment', active: 'Active', ending: 'Waiting for Mastan to end it', end_failed: 'Could not end the deal', failed: 'Could not apply the deal'};
    section.append(h('p', {class: 'muted', text: p.account === 'found' ? 'Account found' : p.account === 'none' ? 'No public account found' : 'Account unknown'}));
    if (data.deals?.mode === 'test') section.append(badge('test', 'TEST'));
    const act = async (action, fields = {}) => {
      try { await write('deals/' + action, p, fields); close(); await load(); }
      catch (e) { error.textContent = e.message; }
    };
    function sharing() {
      if (!d || !(d.link || d.state === 'waiting' || d.kind === 'free' && d.state === 'active')) return;
      const controls = h('div', {class: 'btn-row'}), preview = h('div');
      controls.append(button('Copy', async () => {
        try { const m = await write('deals/copy', p, {language: p.language || 'en'}); await navigator.clipboard.writeText([m.text, m.link].filter(Boolean).join('\n\n')); toast('Copied'); }
        catch (e) { error.textContent = e.message; }
      }));
      if (d.target === 'public' && d.state !== 'waiting') controls.append(button('Send through Mastan', async () => {
        try {
          const m = await write('deals/copy', p, {language: p.language || 'en'});
          const text = h('textarea', {maxlength: 1000, 'aria-label': 'Message text', text: m.text});
          const language = select([['en','English'],['az','Azerbaijani'],['ru','Russian'],['ar','Arabic'],['tr','Turkish']], m.language, {'aria-label': 'Language this message was written in'});
          // Switching language loads that language's text, unless Owner already edited it.
          let loaded = m.text;
          language.addEventListener?.('change', async () => {
            if (text.value !== loaded) return;
            try { const next = await write('deals/copy', p, {language: language.value}); text.value = next.text; loaded = next.text; }
            catch (e) { error.textContent = e.message; }
          });
          const send = button('Send', async () => {
            if (!confirm(`Send this message through Mastan to ${p.name}?\n\n${text.value}${m.link ? '\n\n' + m.link : ''}`)) return;
            busy(send, true, 'Sending'); await act('send', {text: text.value, language: language.value}); busy(send, false);
          }, {class: 'btn primary'});
          preview.replaceChildren(...[h('label', {text: 'Message'}), text, h('label', {text: 'Written in'}), language,
            m.link && h('p', {class: 'muted', text: m.link}), send].filter(Boolean));
        } catch (e) { error.textContent = e.message; }
      }, {disabled: p.sample || data.mode === 'sample' || !data.deals?.ready || !['active','link'].includes(d.state)}));
      section.append(controls, preview);
    }
    if (d) {
      section.append(...[h('p', {text: d.label}), h('p', {text: d.state === 'waiting' && p.account === 'found' ? 'Ready to apply' : states[d.state] || d.state}), d.notice && h('p', {class: 'muted', text: d.state === 'waiting' && p.account === 'found' ? 'Account found. Review the deal and press Apply.' : d.notice}),
        h('dl', {class: 'cl-facts'}, fact('Normal price', d.normal_price === null ? 'Unknown' : money(d.normal_price) + ' a month'),
          fact('They pay', d.pay === null ? 'Unknown' : money(d.pay) + ' a month'), fact('Ends', d.ends_at ? date(d.ends_at) : d.duration === 'forever' ? 'Never' : 'Counted from when it starts'),
          fact('Given up each month', d.given_up === null ? 'Unknown' : money(d.given_up))),
        h('p', {text: 'Reason: ' + d.reason}), d.note && h('p', {text: d.note}),
        d.failure_text && h('p', {class: 'cl-bad', text: d.failure_text}),
        d.delivery && h('p', {class: d.delivery.reason ? 'cl-bad' : 'muted', text: d.delivery.state + (d.delivery.reason ? ': ' + d.delivery.reason : '')})].filter(Boolean));
      sharing();
      section.append(button('End deal', async () => { if (confirm(`End ${p.name}'s deal? ${d.target === 'server' ? 'This ends the deal record. Their monthly billing stays as it is.' : 'A paying subscription will keep running at its normal price.'}`)) await act('end'); }, {disabled: p.sample || data.mode === 'sample' || ['queued','ending'].includes(d.state)}));
    }
    if (!d || ['waiting','draft','failed'].includes(d.state)) {
      const own = Boolean(p.billing?.connected);
      const kind = select(own ? [['free','Free'],['custom','Custom price']] : [['free','Free'],['discount_percent','Percent off'],['discount_amount','Dollars off'],['custom','Custom price']], d?.kind || 'free', {'aria-label': 'Deal kind'});
      const plan = select([['plus','Plus'],['pro','Pro']], d?.plan || 'plus', {'aria-label': 'Deal plan'});
      const duration = select([['forever','Forever'],['months','Number of months'],['once','First month']], d?.duration || 'forever', {'aria-label': 'Deal length'});
      const months = h('input', {type: 'number', min: 1, max: 120, value: d?.months || 3, 'aria-label': 'Number of months'});
      const value = h('input', {type: 'number', min: 0.01, step: 0.01, value: d?.value || 20, 'aria-label': 'Percent or dollars'});
      const reason = h('input', {type: 'text', maxlength: 200, required: true, value: d?.reason || '', 'aria-label': 'Reason, required'});
      const note = h('textarea', {maxlength: 1000, text: d?.note || '', 'aria-label': 'Optional note'});
      const fields = () => ({kind: kind.value, plan: plan.value, duration: duration.value, months: +months.value, value: +value.value, reason: reason.value, note: note.value});
      const form = h('div', {class: 'cl-edit-fields'},
        ...[['Kind', kind], ['Plan', plan], ['Length', duration], ['Months', months], ['Percent or dollars', value], ['Reason, required', reason], ['Note, optional', note]].map(([text, el]) => h('label', {}, text, el)));
      const apply = button('Apply', async () => {
        if (!proposal) return;
        const confirmed = fields();
        const price = proposal.pay_cents === null ? 'Unknown' : money(proposal.pay_cents / 100) + ' a month';
        const end = proposal.ends_at ? 'Ends ' + date(proposal.ends_at) : 'No end date';
        const meaning = proposal.notice || (proposal.kind === 'free' ? 'Give them this plan free. No card is needed.' : proposal.cancel_paid ? '' : p.paying ? 'Apply this discount to their current subscription.' : 'Make a personal payment link. Their plan starts after payment.');
        if (!confirm(`${p.name}: ${proposal.label}. They pay ${price}. ${end}.\n${meaning}${proposal.cancel_paid ? '\nTheir paid subscription will be cancelled now after Mastan confirms the free plan, with no refund.' : ''}\nReason: ${proposal.reason}`)) return;
        confirmed.cancel_paid = proposal.cancel_paid === true;
        busy(apply, true, 'Applying'); await act('apply', confirmed); busy(apply, false);
      }, {class: 'btn primary', disabled: true});
      let proposal = null, revision = 0;
      const update = () => {
        proposal = null; apply.disabled = true; const rev = ++revision;
        value.disabled = kind.value === 'free'; months.disabled = duration.value !== 'months';
        for (const [input, off] of [[value, value.disabled], [months, months.disabled]]) { const label = input.closest?.('label'); if (label) label.hidden = off; }
        duration.querySelector('[value="once"]').disabled = ['free','custom'].includes(kind.value);
        if (['free','custom'].includes(kind.value) && duration.value === 'once') duration.value = 'months';
        previewHost.replaceChildren();
        if (!reason.value.trim()) return;
        clearTimeout(update.timer);
        update.timer = setTimeout(async () => {
          try {
            const result = await write('deals/preview', p, fields()); if (rev !== revision || !section.isConnected) return;
            proposal = result; error.textContent = '';
            previewHost.replaceChildren(h('p', {text: result.label}), result.notice && h('p', {class: 'muted', text: result.notice}),
              h('dl', {class: 'cl-facts'}, fact('Normal price', result.list_cents === null ? 'Unknown' : money(result.list_cents / 100) + ' a month'),
                fact('They pay', result.pay_cents === null ? 'Unknown' : money(result.pay_cents / 100) + ' a month'), fact('Ends', result.ends_at ? date(result.ends_at) : 'Never'),
                fact('Given up each month', result.given_up === null ? 'Unknown' : money(result.given_up)), fact('LLM cost so far', result.llm_cost === null ? 'Unknown' : money(result.llm_cost))));
            apply.disabled = Boolean(p.sample || data.mode === 'sample' || result.target === 'public' && result.state !== 'waiting' && !result.connected);
          } catch (e) { if (rev === revision) error.textContent = e.message; }
        }, 250);
      };
      form.addEventListener('input', update); form.addEventListener('change', update);
      section.append(form, previewHost, apply); setTimeout(update, 0);
    }
    if (!data.deals?.ready) section.append(h('p', {class: 'muted', text: 'Public Mastan is not connected yet'}));
    for (const past of p.deal_history || []) section.append(h('p', {class: 'muted', text: 'Ended: ' + past.label + '. Reason: ' + past.reason}));
    section.append(error); return section;
  }

  function detail(person) {
    const p = person, editable = !p?.sample, manual = !p || p.manual, controls = {}, isNew = !p;
    let pickedId = p?.person_id || '', pickedOrigin = p?.people_origin || '';
    const error = h('p', {class: 'cl-bad', role: 'alert'}), timeline = h('ol', {class: 'cl-timeline'});
    const dialog = h('dialog', {class: 'cl-dialog', 'aria-labelledby': 'cl-detail-title'});
    const close = () => { dialog.close(); dialog.remove(); };
    const title = h('h2', {id: 'cl-detail-title', text: p?.name || 'Add lead'});
    const body = h('div', {class: 'cl-dialog-body'});
    const field = (key, label, el) => { controls[key] = el; return h('div', {class: key === 'notes' ? 'cl-wide' : ''}, h('label', {for: 'cl-edit-' + key, text: label}), el); };
    const input = (key, type = 'text', max = 200) => h('input', {id: 'cl-edit-' + key, type, value: p?.[key] || '', maxlength: max});
    const fact = (label, value) => h('div', {}, h('dt', {text: label}), h('dd', {}, typeof value === 'string' ? unknown(value) : value));
    if (p) {
      const links = h('div', {class: 'btn-row'});
      if (p.stripe_customer_id) links.append(h('a', {class: 'btn', target: '_blank', rel: 'noreferrer', href: `https://dashboard.stripe.com/${data.mode === 'test' ? 'test/' : ''}customers/${encodeURIComponent(p.stripe_customer_id)}`, text: 'Open in Stripe'}));
      if (p.email) links.append(h('a', {class: 'btn', href: 'mailto:' + encodeURIComponent(p.email), text: 'Email'}));
      if (p.phone && /^[+\d ()-]+$/.test(p.phone)) {
        const digits = p.phone.replace(/\D/g, '');
        links.append(h('a', {class: 'btn', href: 'tel:' + (p.phone.startsWith('+') ? '+' : '') + digits, text: 'Call'}));
        if (digits) links.append(h('a', {class: 'btn', target: '_blank', rel: 'noreferrer', href: 'https://wa.me/' + digits, text: 'WhatsApp'}));
      }
      body.append(h('p', {class: 'muted cl-detail-contact', text: [p.email, p.phone, p.country].filter(Boolean).join(' · ')}), links,
        ...(onServer(p) ? [billingSection(p, close)] : []),
        h('dl', {class: 'cl-facts', hidden: !p.plan && !p.stripe_customer_id}, fact('Plan', [p.plan || absent('-'), p.plan_detail].filter(Boolean).join(': ')), fact('Status', badge(p.overdue_since ? 'overdue' : p.cancelling ? 'cancelling' : p.status, p.status_label)), fact('Monthly list price', amounts(p.amount, absent('-'))),
          fact('Discount', p.discount || 'None'), fact('Last paid', p.last_paid ? date(p.last_paid) : absent('None')), fact('Lifetime paid', amounts(p.lifetime, absent('None'))), fact('Payment period', p.period_start && p.period_end ? date(p.period_start) + ' to ' + date(p.period_end) : absent('-')),
          fact('Payment', nextDate(p)), fact('Monthly recurring revenue', amounts(p.mrr, absent('-')))),
        h('dl', {class: 'cl-facts'}, fact('LLM coverage', h('div', {}, unknown(p.llm_covered === null ? 'Unknown' : p.llm_covered ? 'On us' : 'Not on us'), p.llm_default && h('small', {class: 'muted', text: 'Plan default'}))),
          p.server && !(p.period_start && p.period_end) ? fact('LLM cost, last 30 days', p.cost.last_30 === null ? 'Unknown' : money(p.cost.last_30)) : fact('LLM cost this period', p.cost.period === null ? 'Unknown' : money(p.cost.period)),
          !p.server && p.cost.last_30 !== null && fact('LLM cost, last 30 days', money(p.cost.last_30)),
          !p.server && fact('LLM cost, retained history', p.cost.all_time === null ? 'Unknown' : money(p.cost.all_time)),
          fact('Cost source', p.cost.source || 'Unknown'), fact('Margin', margin(p))),
        ...(p.cost.reason ? [h('p', {class: 'muted small', text: p.cost.reason})] : []),
        h('p', {class: 'muted small', text: 'Priced at API list price, not what we actually pay.'}),
        ...(p.cost.monthly_eur !== null ? [h('p', {class: 'muted small', text: 'Server rent, ' + money(p.cost.monthly_eur, 'eur') + ' a month'})] : []),
        h('p', {class: 'muted small', text: p.server ? p.period_start && p.period_end ? `${p.margin_label}. Period cost uses Riyadh days, including the start day and excluding the end day.` : `${p.margin_label}. Last 30 Riyadh days, including today.` : `${p.margin_label}. Cost history is limited to Canary's retained days (up to 400). Period cost uses the matched billing period.`}));
      if (p.period_paid != null) body.append(h('p', {text: 'Paid ' + money(p.period_paid) + ' this period'}));
      if (p.private_request) {
        const r = p.private_request;
        body.append(h('h3', {text: 'Private request'}), h('dl', {class: 'cl-facts'}, fact('Plan interest', r.plan || 'Unknown'), fact('Business', r.business || 'Unknown'), fact('People', String(r.people ?? 'Unknown')),
          fact('Requested', date(r.requested_at)), fact('Ready', date(r.ready_at)), fact('Language', r.language || 'Unknown'), fact('Identity', r.identity || 'Unknown'),
          fact('Contact', r.contact?.channel && r.contact.address_digits ? r.contact.channel + ': ' + r.contact.address_digits : 'Unknown')));
      }
    }
    // Public-account deals mean nothing here: Monthly plan sets the price. An existing deal still shows, so it can be ended.
    if (p && (!onServer(p) || p.deal || p.deal_history?.length)) body.append(dealSection(p, close));
    const drawEvents = events => timeline.replaceChildren(...events.map(e => h('li', {}, h('small', {class: 'muted', text: fmtDateTime(e.at)}), h('p', {text: e.text}))));
    if (editable) {
      const fields = h('div', {class: 'cl-edit-fields'});
      const tag = select([['', p?.tag_default ? p.tag_label : 'No stored tag'], ...TAGS], p?.tag || '', {id: 'cl-edit-tag', class: p?.tag_default ? 'cl-tag-soft' : ''});
      const servers = [['', 'None'], ...data.servers.map(s => [s.name, `${s.name} (${s.client})`])];
      if (p?.server && !data.servers.some(s => s.name === p.server)) servers.push([p.server, p.server]);
      tag.addEventListener('change', () => tag.classList.remove('cl-tag-soft'));
      if (isNew) body.append(button('Pick from People', () => peoplePicker(fields => {
        pickedId = fields.person_id; pickedOrigin = fields.people_origin;
        for (const [key, value] of Object.entries(fields)) if (controls[key]) controls[key].value = value;
      })));
      if (manual) fields.append(field('name', 'Name', input('name')), field('email', 'Email', input('email', 'email', 320)), field('phone', 'Phone', input('phone', 'tel')));
      fields.append(field('tag', 'Tag', tag), field('company', 'Company', input('company')),
        field('source', 'Source', input('source')), field('country', 'Country', input('country')), field('language', 'Language', input('language')), field('follow_up', 'Follow-up', input('follow_up', 'date')), field('last_contact', 'Last contact', input('last_contact', 'date')),
        field('llm_covered', 'LLM covered by us', select([['', 'Not set (plan default)'], ['1', 'Yes'], ['0', 'No']], p?.llm_default ? '' : String(p?.llm_covered ?? ''), {id: 'cl-edit-llm_covered'})),
        field('server', 'Server', select(servers, p?.server || '', {id: 'cl-edit-server'})),
        field('notes', 'Notes', h('textarea', {id: 'cl-edit-notes', maxlength: 8000, text: p?.notes || ''})));
      const quick = h('div', {class: 'btn-row'}, [['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([text, n]) => button(text, () => { controls.follow_up.value = addDays(n); })));
      const save = button(isNew ? 'Add lead' : 'Save', async () => {
        error.textContent = ''; busy(save, true, 'Saving');
        const payload = Object.fromEntries(Object.entries(controls).map(([key, el]) => [key, key === 'llm_covered' ? el.value === '' ? null : +el.value : key === 'tag' ? el.value || null : el.value]));
        if (pickedId) payload.person_id = pickedId;
        if (pickedOrigin) payload.people_origin = pickedOrigin;
        try { if (isNew) await api('/api/clients', {method: 'POST', body: payload}); else await write('update', p, payload); toast(isNew ? 'Lead added' : 'Saved'); close(); await load(); }
        catch (e) { error.replaceChildren(document.createTextNode(e.message)); if (e.existing_id) error.append(button('Open existing person', async () => { await load(); const existing = data.people.find(row => row.id === e.existing_id || pickedId && row.person_id === pickedId || row.phone === payload.phone); if (existing) { close(); detail(existing); } })); }
        finally { busy(save, false); }
      }, {class: 'btn primary'});
      const actions = h('div', {class: 'btn-row'}, save);
      if (p?.manual) actions.append(button('Delete lead', async () => {
        if (!confirm('Delete this lead and its contact history?')) return;
        try { await write('delete', p); toast('Lead deleted'); close(); await load(); }
        catch (e) { error.textContent = e.message; }
      }, {class: 'btn bad'}));
      body.append(h('h3', {class: 'cl-edit-heading', text: isNew ? 'Lead details' : 'Your notes'}), fields, quick, error, actions);
      if (p) {
        const note = h('input', {type: 'text', id: 'cl-contact-note', maxlength: 1000, placeholder: 'What happened?'});
        const logError = h('p', {class: 'cl-bad', role: 'alert'});
        const log = button('Log contact', async () => {
          logError.textContent = ''; busy(log, true, 'Saving');
          try {
            await write('log', p, {text: note.value});
            note.value = ''; controls.last_contact.value = day(); toast('Contact logged');
            await load(); const latest = data.people.find(row => row.id === p.id); if (latest) drawEvents(latest.events);
          } catch (e) { logError.textContent = e.message; }
          finally { busy(log, false); }
        });
        body.append(h('h3', {class: 'cl-edit-heading', text: 'Contact history'}), h('label', {for: 'cl-contact-note', text: 'Contact note'}), note, logError, h('div', {class: 'btn-row'}, log), timeline);
        drawEvents(p.events);
      }
    } else body.append(h('p', {class: 'cl-warn', text: 'Sample row. Add a real lead to save notes.'}));
    dialog.append(h('div', {class: 'cl-dialog-head'}, title, button('Close', close)), body);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  }
  async function load(refresh = false) {
    try { data = await api('/api/clients' + (refresh ? '?refresh=1' : '')); render(); }
    catch (error) { if (data) toast(error.message, {error: true}); else setMain(MM.pageHead('Clients'), MM.errorState(error.message, () => load())); }
  }
  load();
})();
