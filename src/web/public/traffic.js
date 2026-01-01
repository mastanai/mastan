(() => {
  'use strict';
  const {h, api, setMain, fmtDate, fmtDateTime} = MM;
  // mastan.ai visits from Umami, refreshed every 5 minutes. Everything here is drawn from one list of visits, so any
  // country, page or source can filter the whole page. Visitors can write to the tracker, so nothing goes in as HTML.
  const whole = n => Math.round(n || 0).toLocaleString('en-US');
  const percent = n => Math.round(n * 100) + '%';
  const duration = s => s === null || s === undefined ? '-' : s < 60 ? Math.round(s) + 's' : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  const riyadh = t => new Date(t * 1000 + 3 * 3600e3);
  const dayOf = t => riyadh(t).toISOString().slice(0, 10);
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  const named = (type, code) => { try { return code ? new Intl.DisplayNames(['en'], {type}).of(code) || code : ''; } catch { return code; } };
  const country = code => named('region', code) || 'Unknown';
  const language = code => named('language', code) || 'Unknown';
  const CAPITAL = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const BROWSERS = {ios: 'Safari (iPhone)', crios: 'Chrome (iPhone)', 'ios-webview': 'App (iPhone)', 'edge-chromium': 'Edge', 'edge-ios': 'Edge (iPhone)', fxios: 'Firefox (iPhone)', 'chromium-webview': 'App (Android)', 'samsung': 'Samsung Internet', 'facebook': 'Facebook app', 'instagram': 'Instagram app'};
  const browser = code => BROWSERS[code] || CAPITAL(code) || 'Unknown';
  // Towns that are almost only data centers. Umami catches bots that say they are bots, not these.
  const SERVER_TOWNS = new Set(['Council Bluffs', 'Ashburn', 'Boardman', 'The Dalles', 'Falkenstein', 'Prineville', 'Forest City', 'Lenoir', 'Quincy']);
  const serverTown = v => SERVER_TOWNS.has(v.city);
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

  // A click, or 10 active seconds. Only tracked pages have a scroll depth, so the older estimates from page gaps do not count.
  const ENGAGED_SECONDS = 10;
  const engaged = v => v.clicks.length > 0 || v.pages.reduce((a, p) => a + (p.d === null ? 0 : p.s || 0), 0) >= ENGAGED_SECONDS;
  const RANGES = [['1', 'Today'], ['7', '7d'], ['30', '30d'], ['90', '90d'], ['0', 'All']];
  const METRICS = {
    visitors: {label: 'Visitors', of: list => new Set(list.map(v => v.visitor)).size},
    visits: {label: 'Visits', of: list => list.length},
    views: {label: 'Page views', of: list => list.reduce((a, v) => a + v.pages.length, 0)},
    clicks: {label: 'Clicks', of: list => list.reduce((a, v) => a + v.clicks.length, 0)},
    engaged: {label: 'Engaged', of: list => new Set(list.filter(engaged).map(v => v.visitor)).size},
  };
  const FILTERS = {
    engaged: ['Only', () => 'engaged visits'], day: ['Day', v => fmtDate(v)], country: ['Country', country], city: ['City', v => v || 'Unknown'], page: ['Page', v => v], channel: ['Channel', v => v], source: ['Source', v => v],
    campaign: ['Campaign', v => v], device: ['Device', CAPITAL], browser: ['Browser', browser], os: ['System', v => v], language: ['Language', language], screen: ['Screen', v => v], click: ['Clicked', v => v],
  };
  const CHAT = new Set(['whatsapp', 'telegram', 'chat']);
  const KINDS = {whatsapp: 'WhatsApp', telegram: 'Telegram', chat: 'Web chat', email: 'Email', phone: 'Phone', outbound: 'Other site', link: 'On site', button: 'Button'};

  const initial = stored('traffic.range');
  const view = {range: RANGES.some(([k]) => k === initial) ? +initial : 30, metric: 'visitors', servers: stored('traffic.servers') === 'show', filters: {}, tabs: {pages: 'all', sources: 'channel', places: 'country', tech: 'device', when: 'hour', clicks: 'all'}, more: {}};
  let data = null, host = null, redrawChart = () => {};

  const visitDay = v => dayOf(v.t);
  const today = () => dayOf(Date.now() / 1000);
  function bounds() {
    if (view.filters.day) return {start: view.filters.day, end: view.filters.day, previous: null};
    if (!view.range) return {start: data.visits.length ? visitDay(data.visits[0]) : today(), end: today(), previous: null};
    const end = today(), start = addDays(end, -(view.range - 1));
    return {start, end, previous: {start: addDays(start, -view.range), end: addDays(start, -1)}};
  }
  const passes = v => Object.entries(view.filters).every(([key, value]) =>
    key === 'day' ? true : key === 'engaged' ? engaged(v) : key === 'page' ? v.pages.some(p => p.p === value) : key === 'click' ? v.clicks.some(c => c.l === value) : v[key] === value);
  const inDays = ({start, end}, v) => { const d = visitDay(v); return d >= start && d <= end; };
  const within = range => data.visits.filter(v => inDays(range, v) && passes(v) && (view.servers || !serverTown(v)));
  const filter = (key, value) => { view.filters = {...view.filters, [key]: value}; draw(); };
  const unfilter = key => { const next = {...view.filters}; delete next[key]; view.filters = next; draw(); };

  // Left after one page, with no click.
  const bounced = v => v.pages.length <= 1 && !v.clicks.length;
  const summary = list => {
    const tracked = list.filter(v => v.t >= data.tracked_since);
    return {
    engaged: METRICS.engaged.of(tracked), share: METRICS.visitors.of(tracked) ? METRICS.engaged.of(tracked) / METRICS.visitors.of(tracked) : null,
    visitors: METRICS.visitors.of(list), visits: list.length, views: METRICS.views.of(list), clicks: METRICS.clicks.of(list),
    chats: list.reduce((a, v) => a + v.clicks.filter(c => CHAT.has(c.k)).length, 0), perVisit: list.length ? METRICS.views.of(list) / list.length : 0,
    time: mean(list.filter(v => v.seconds !== null).map(v => v.seconds)), bounce: list.length ? list.filter(bounced).length / list.length : 0,
    };
  };

  function tile(label, value, now, before, fixed) {
    let note = fixed || 'All time';
    if (!fixed && before !== undefined) {
      if (before === null || now === null) note = 'No earlier numbers';
      else if (!before) note = now ? 'None the period before' : 'Same as the period before';
      else { const change = Math.round((now - before) / before * 100); note = change ? `${change > 0 ? '+' : ''}${change}% on the period before` : 'Same as the period before'; }
    }
    return h('div', {class: 'card fu-kpi'}, h('div', {class: 'muted small', text: label}), h('div', {class: 'fu-value', text: value}), h('div', {class: 'fu-faint', text: note}));
  }

  function seg(options, value, pick, label) {
    return h('div', {class: 'fu-seg', role: 'group', 'aria-label': label}, options.map(([k, text]) =>
      h('button', {type: 'button', text, 'aria-pressed': String(String(k) === String(value)), onclick: () => pick(k)})));
  }
  const panel = (title, control, ...body) => h('section', {class: 'card fu-panel'}, h('div', {class: 'fu-head'}, h('h2', {text: title}), control || null), ...body);
  const tabs = (key, options) => seg(options, view.tabs[key], k => { view.tabs[key] = k; draw(); }, key);
  const nothing = text => MM.empty(text);

  function countBy(list, keys) {
    const groups = new Map();
    for (const v of list) for (const key of keys(v)) {
      const group = groups.get(key) || {key, visits: 0, visitors: new Set()};
      group.visits++; group.visitors.add(v.visitor); groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.visitors.size - a.visitors.size || b.visits - a.visits);
  }
  // Rows of name, bar and number. A row with a filter key narrows the whole page to it.
  function barList(id, rows, {filterKey, name = r => r.key, value = r => r.visitors.size, show = whole, unit}) {
    if (!rows.length) return nothing('Nothing in this period.');
    const top = Math.max(...rows.map(value), 1), limit = view.more[id] ? rows.length : 10;
    const list = rows.slice(0, limit).map(r => {
      const content = [h('span', {class: 'fu-name', text: name(r)}), h('div', {class: 'fu-track'}, h('div', {class: 'fu-fill', style: {width: Math.max(value(r) / top * 100, 1) + '%'}})), h('span', {class: 'fu-v', text: show(value(r))})];
      return filterKey ? h('button', {type: 'button', class: 'fu-hbar tr-pick', title: 'Filter by ' + name(r), onclick: () => filter(filterKey, r.key)}, content) : h('div', {class: 'fu-hbar'}, content);
    });
    return h('div', {}, unit ? h('p', {class: 'muted small tr-unit', text: unit}) : null, list, showAll(id, rows.length, limit));
  }
  const showAll = (id, total, limit) => total > limit || view.more[id] && total > 10
    ? h('button', {type: 'button', class: 'btn tr-more', text: view.more[id] ? 'Show fewer' : `Show all ${whole(total)}`, onclick: () => { view.more[id] = !view.more[id]; draw(); }}) : null;
  const scrollTable = (label, head, rows) => h('div', {class: 'fu-scroll', tabindex: 0, role: 'region', 'aria-label': label},
    h('table', {class: 'fu-table tr-table'}, h('thead', {}, h('tr', {}, head.map(text => h('th', {text})))), h('tbody', {}, rows)));

  function dailyChart(rows, metric) {
    const box = h('div', {class: 'fu-chart'}), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), tip = h('div', {class: 'fu-tip', hidden: true});
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${METRICS[metric].label} per day`);
    box.append(svg, tip);
    redrawChart = () => {
      const series = rows.map(r => METRICS[metric].of(r.visits)), max = Math.max(...series, 1);
      const step = 10 ** Math.floor(Math.log10(max)), nice = [.25, .5, 1, 2, 2.5, 5, 10].map(k => k * step).find(v => v * 4 >= max && (v >= 1)) || step * 10, top = nice * 4;
      const W = svg.clientWidth || 800, H = svg.clientHeight || 280, L = 40, R = 4, T = 8, B = 24, pw = W - L - R, ph = H - T - B, slot = pw / Math.max(rows.length, 1), bw = Math.max(Math.min(slot - 2, 28), 2);
      const y = v => T + ph - v / top * ph, every = Math.ceil(rows.length / Math.max(Math.floor(pw / 56), 1));
      let s = '';
      for (let i = 0; i <= 4; i++) s += `<line class="fu-grid" x1="${L}" x2="${W - R}" y1="${y(nice * i)}" y2="${y(nice * i)}"/><text class="fu-axis" x="${L - 6}" y="${y(nice * i) + 4}" text-anchor="end">${+(nice * i).toFixed(1)}</text>`;
      rows.forEach((r, i) => {
        const v = series[i];
        if (v > 0) s += `<rect class="fu-s0" x="${L + i * slot + (slot - bw) / 2}" y="${y(v)}" width="${bw}" height="${Math.max(v / top * ph, .5)}"/>`;
        s += `<rect class="fu-hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/>`;
        if ((rows.length - 1 - i) % every === 0) s += `<text class="fu-axis" x="${L + i * slot + slot / 2}" y="${H - 7}" text-anchor="middle">${r.day.slice(5)}</text>`;
      });
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = s;
      svg.querySelectorAll('.fu-hit').forEach(el => {
        const i = +el.dataset.i;
        el.addEventListener('mousemove', e => {
          tip.replaceChildren(h('b', {text: fmtDate(rows[i].day)}), h('div', {}, h('span', {text: METRICS[metric].label}), h('span', {text: whole(series[i])})));
          tip.hidden = false;
          const bx = box.getBoundingClientRect();
          tip.style.left = Math.max(0, Math.min(e.clientX - bx.left + 12, bx.width - tip.offsetWidth)) + 'px';
        });
        el.addEventListener('mouseleave', () => { tip.hidden = true; });
        el.addEventListener('click', () => filter('day', rows[i].day));
      });
    };
    return box;
  }

  function perDay(list, {start, end}) {
    const rows = [];
    for (let day = start; day <= end; day = addDays(day, 1)) rows.push({day, visits: []});
    const index = new Map(rows.map(r => [r.day, r]));
    for (const v of list) index.get(visitDay(v))?.visits.push(v);
    return rows;
  }

  function pagesPanel(list) {
    const stats = new Map();
    const of = p => stats.get(p) || stats.set(p, {p, views: 0, visitors: new Set(), secs: [], depth: [], entries: 0, exits: 0, title: ''}).get(p);
    for (const v of list) v.pages.forEach((page, i) => {
      const row = of(page.p);
      row.views++; row.visitors.add(v.visitor); row.title = row.title || page.title;
      if (page.s !== null) row.secs.push(page.s);
      if (page.d !== null) row.depth.push(page.d);
      if (i === 0) row.entries++;
      if (i === v.pages.length - 1) row.exits++;
    });
    const by = {all: r => r.views, entry: r => r.entries, exit: r => r.exits}[view.tabs.pages];
    const rows = [...stats.values()].filter(r => by(r) > 0).sort((a, b) => by(b) - by(a) || a.p.localeCompare(b.p));
    const limit = view.more.pages ? rows.length : 12;
    const control = tabs('pages', [['all', 'Most viewed'], ['entry', 'First page'], ['exit', 'Last page']]);
    if (!rows.length) return panel('Pages', control, nothing('Nothing in this period.'));
    return panel('Pages', control, scrollTable('Pages', ['Page', 'Views', 'Visitors', 'Avg time', 'Scrolled', 'First page', 'Last page'], rows.slice(0, limit).map(r => h('tr', {},
      h('td', {class: 'tr-cell'}, h('button', {type: 'button', class: 'tr-link', text: r.p, title: r.title, onclick: () => filter('page', r.p)})),
      h('td', {text: whole(r.views)}), h('td', {text: whole(r.visitors.size)}), h('td', {text: duration(mean(r.secs))}), h('td', {text: r.depth.length ? Math.round(mean(r.depth)) + '%' : '-'}),
      h('td', {text: whole(r.entries)}), h('td', {text: whole(r.exits)})))), showAll('pages', rows.length, limit));
  }

  function clicksPanel(list) {
    const groups = new Map(), want = {all: () => true, chat: c => CHAT.has(c.k), outbound: c => c.k === 'outbound' || c.k === 'email' || c.k === 'phone', site: c => c.k === 'link' || c.k === 'button'}[view.tabs.clicks];
    for (const v of list) for (const c of v.clicks) if (want(c)) {
      const key = [c.l, c.k, c.to].join('\n'), group = groups.get(key) || {...c, count: 0, visitors: new Set(), pages: new Map()};
      group.count++; group.visitors.add(v.visitor); group.pages.set(c.p, (group.pages.get(c.p) || 0) + 1); groups.set(key, group);
    }
    const rows = [...groups.values()].sort((a, b) => b.count - a.count), limit = view.more.clicks ? rows.length : 12;
    const control = tabs('clicks', [['all', 'All'], ['chat', 'Start a chat'], ['outbound', 'Leave the site'], ['site', 'On site']]);
    const anyEver = data.visits.some(v => v.clicks.length);
    if (!rows.length) return panel('Clicks', control, nothing(anyEver ? 'No clicks here in this period.' : 'Click counting starts when the new tracker goes live. Older visits have no clicks.'));
    return panel('Clicks', control, scrollTable('Clicks', ['Clicked', 'Type', 'Goes to', 'Mostly on', 'Clicks', 'Visitors'], rows.slice(0, limit).map(r => h('tr', {},
      h('td', {class: 'tr-cell'}, h('button', {type: 'button', class: 'tr-link', text: r.l || '(no text)', onclick: () => filter('click', r.l)})), h('td', {text: KINDS[r.k] || r.k}), h('td', {class: 'tr-left', text: r.to}),
      h('td', {class: 'tr-left', text: [...r.pages].sort((a, b) => b[1] - a[1])[0][0]}), h('td', {text: whole(r.count)}), h('td', {text: whole(r.visitors.size)})))), showAll('clicks', rows.length, limit));
  }

  function whenPanel(list) {
    const control = tabs('when', [['hour', 'Hour'], ['weekday', 'Weekday']]), names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const slots = view.tabs.when === 'hour' ? Array.from({length: 24}, (_, i) => ({key: i, name: String(i).padStart(2, '0') + ':00', n: 0})) : names.map((name, i) => ({key: i, name, n: 0}));
    for (const v of list) slots[view.tabs.when === 'hour' ? riyadh(v.t).getUTCHours() : riyadh(v.t).getUTCDay()].n++;
    view.more.when = true;
    return panel('When they visit', control, barList('when', slots, {name: r => r.name, value: r => r.n, unit: 'Visits, Riyadh time'}));
  }

  function latestPanel(list) {
    const rows = list.slice(-25).reverse();
    if (!rows.length) return panel('Latest visits', null, nothing('Nothing in this period.'));
    return panel('Latest visits', null, scrollTable('Latest visits', ['When', 'From', 'Source', 'Device', 'Pages', 'Time', 'Clicks'], rows.map(v => h('tr', {},
      h('td', {class: 'tr-left', text: fmtDateTime(v.t * 1000)}), h('td', {class: 'tr-left', text: [v.city, country(v.country)].filter(Boolean).join(', ')}), h('td', {class: 'tr-left', text: v.source}),
      h('td', {class: 'tr-left', text: CAPITAL(v.device)}), h('td', {class: 'tr-left tr-path', text: v.pages.map(p => p.p).join(' > ')}), h('td', {text: duration(v.seconds)}), h('td', {text: whole(v.clicks.length)})))));
  }

  function dayTable(rows) {
    const shown = rows.slice().reverse().filter(r => r.visits.length);
    if (!shown.length) return null;
    return panel('Each day', null, scrollTable('Each day', ['Day', 'Engaged', 'Visitors', 'Visits', 'Page views', 'Avg time', 'Bounce', 'Clicks'], shown.map(r => {
      const s = summary(r.visits);
      return h('tr', {}, h('td', {class: 'tr-cell'}, h('button', {type: 'button', class: 'tr-link', text: fmtDate(r.day), onclick: () => filter('day', r.day)})), h('td', {text: r.day < dayOf(data.tracked_since) ? '-' : whole(s.engaged)}), h('td', {text: whole(s.visitors)}), h('td', {text: whole(s.visits)}),
        h('td', {text: whole(s.views)}), h('td', {text: duration(s.time)}), h('td', {text: percent(s.bounce)}), h('td', {text: whole(s.clicks)}));
    })));
  }

  function notes(list) {
    const gap = data.gaps?.[0], timed = list.filter(v => v.seconds !== null).length;
    return panel('How we count', null, h('ul', {class: 'muted small fu-notes'},
      h('li', {text: 'Visitor: one browser in one calendar month. Umami changes its id every month and keeps no cookie, so one person across two months counts twice.'}),
      h('li', {text: 'Visit: pages from one visitor within the same hour. Bounce: one page and no click.'}),
      h('li', {text: `Engaged: a visit with a click or at least ${ENGAGED_SECONDS} active seconds, counted since ${fmtDate(data.tracked_since * 1000)}. Active means the tab is in front and someone did something in the last minute. This is the number to quote; a basic bot rarely passes it, a careful one could, and a person who reads for 5 seconds and leaves is missed. Your own visits count unless the device is opted out.`}),
      h('li', {text: `Time: active seconds on the page with the new tracker. Older visits only have the gap between two pages, ten minutes at most, and one-page visits have no time, so the average uses ${whole(timed)} of ${whole(list.length)} visits here.`}),
      gap ? h('li', {text: `Nothing was counted from ${fmtDate(gap[0])} to ${fmtDate(gap[1])}, when the tracker was broken.`}) : null,
      h('li', {text: `Likely servers: visits from ${[...SERVER_TOWNS].join(', ')}. These towns are almost only data centers. A real person there would be hidden too, so the button shows them again.`}),
      h('li', {text: 'Visitors who block scripts and known bots are not here. Paid clicks, UTM links and referrers set the source; many apps send no referrer, so they look Direct.'}),
      h('li', {}, 'Your own visits count too. To stop that on a device, open ', h('a', {href: 'https://mastan.ai/#dont-count-me', target: '_blank', rel: 'noopener', text: 'this link'}), ' once on it (', h('a', {href: 'https://mastan.ai/#count-me', target: '_blank', rel: 'noopener', text: 'undo'}), ').')));
  }

  function draw() {
    const range = bounds(), list = within(range), s = summary(list), before = range.previous ? summary(within(range.previous)) : null;
    const prior = key => before ? before[key] : undefined;
    // Compare engaged numbers only when the period before was tracked too.
    const trackedDay = dayOf(data.tracked_since), fullyTracked = !!range.previous && range.previous.start >= trackedDay, since = `Since ${fmtDate(data.tracked_since * 1000)}`;
    const days = perDay(list, range), chart = dailyChart(days, view.metric);
    const chips = Object.entries(view.filters).map(([key, value]) => h('button', {type: 'button', class: 'chip tr-chip', title: 'Remove filter', onclick: () => unfilter(key)},
      `${FILTERS[key][0]}: ${FILTERS[key][1](value)} ×`));
    const age = Date.now() / 1000 - data.generated_at;
    const sources = {channel: ['channel', v => v.channel], source: ['source', v => v.source], campaign: ['campaign', v => v.campaign || null]}[view.tabs.sources];
    const places = {country: ['country', v => v.country, r => country(r.key)], city: ['city', v => v.city || null, r => r.key]}[view.tabs.places];
    const tech = {device: v => v.device, browser: v => v.browser, os: v => v.os, language: v => v.language, screen: v => v.screen}[view.tabs.tech];
    // A reload is not a step.
    const paths = countBy(list, v => { const steps = v.pages.map(p => p.p).filter((p, i, all) => p !== all[i - 1]); return steps.length > 1 ? [steps.slice(0, 4).join(' > ')] : []; });
    const hidden = view.servers ? 0 : data.visits.filter(v => inDays(range, v) && passes(v) && serverTown(v)).length;
    host.replaceChildren(
      h('div', {class: 'filter-row tr-controls'}, seg(RANGES, view.range, k => { view.range = +k; store('traffic.range', k); unfilter('day'); }, 'Date range'), chips,
        h('button', {type: 'button', class: 'chip tr-chip', 'aria-pressed': String(view.servers), title: 'Visits from towns that are almost only data centers', text: view.servers ? 'Hide likely servers' : `${whole(hidden)} likely server${hidden === 1 ? '' : 's'} hidden`, onclick: () => { view.servers = !view.servers; store('traffic.servers', view.servers ? 'show' : 'hide'); draw(); }}),
        view.filters.engaged ? null : h('button', {type: 'button', class: 'chip tr-chip', title: 'Show only visits with a click or 10 active seconds', text: 'Engaged only', onclick: () => filter('engaged', true)}),
        h('span', {class: age > 1800 ? 'badge bad' : 'muted small', text: `Updated ${age < 90 ? 'just now' : age < 5400 ? Math.round(age / 60) + ' min ago' : Math.round(age / 3600) + ' h ago'}`})),
      h('section', {class: 'fu-kpis tr-kpis', 'aria-label': 'Summary'},
        tile('Engaged visitors', whole(s.engaged), s.engaged, before && fullyTracked ? before.engaged : undefined, fullyTracked ? null : since),
        tile('Engaged share', s.share === null ? '-' : percent(s.share), s.share, before && fullyTracked ? before.share : undefined, fullyTracked ? null : 'Of visitors in that time'),
        tile('Visitors', whole(s.visitors), s.visitors, prior('visitors')), tile('Visits', whole(s.visits), s.visits, prior('visits')), tile('Page views', whole(s.views), s.views, prior('views')),
        tile('Pages per visit', s.perVisit.toFixed(1), s.perVisit, prior('perVisit')), tile('Avg time', duration(s.time), s.time, prior('time')), tile('Bounce', percent(s.bounce), s.bounce, prior('bounce')),
        tile('Clicks', whole(s.clicks), s.clicks, prior('clicks')), tile('Chat clicks', whole(s.chats), s.chats, prior('chats'))),
      panel(`${METRICS[view.metric].label} per day`, seg(Object.entries(METRICS).map(([k, m]) => [k, m.label]), view.metric, k => { view.metric = k; draw(); }, 'Metric'), chart),
      pagesPanel(list),
      h('div', {class: 'fu-two'},
        panel('Sources', tabs('sources', [['channel', 'Channel'], ['source', 'Site'], ['campaign', 'Campaign']]), barList('sources', countBy(list, v => sources[1](v) ? [sources[1](v)] : []), {filterKey: sources[0], unit: 'Visitors'})),
        panel('Places', tabs('places', [['country', 'Country'], ['city', 'City']]), barList('places', countBy(list, v => places[1](v) ? [places[1](v)] : []), {filterKey: places[0], name: places[2], unit: 'Visitors'}))),
      clicksPanel(list),
      h('div', {class: 'fu-two'},
        panel('Devices and browsers', tabs('tech', [['device', 'Device'], ['browser', 'Browser'], ['os', 'System'], ['language', 'Language'], ['screen', 'Screen']]),
          barList('tech', countBy(list, v => tech(v) ? [tech(v)] : []), {filterKey: view.tabs.tech, name: {language: r => language(r.key), device: r => CAPITAL(r.key), browser: r => browser(r.key)}[view.tabs.tech] || (r => r.key), unit: 'Visitors'})),
        whenPanel(list)),
      panel('Paths through the site', null, barList('paths', paths, {name: r => r.key, value: r => r.visits, unit: 'Visits that saw more than one page, first four steps, reloads left out'})),
      dayTable(days), latestPanel(list), notes(list));
    redrawChart();
  }

  async function start() {
    setMain(MM.pageHead('Traffic', h('span', {class: 'muted small', text: 'mastan.ai visitors'})), host = h('div', {class: 'fu'}, MM.loading ? MM.loading() : null));
    try { data = await api('/api/traffic'); }
    catch (error) { host.replaceChildren(MM.errorState ? MM.errorState(error.message) : MM.empty(error.message)); return; }
    if (!data.available) { host.replaceChildren(MM.empty('No traffic numbers yet. The export runs every 5 minutes.')); return; }
    draw();
    let width = innerWidth;
    addEventListener('resize', () => { if (innerWidth !== width) { width = innerWidth; redrawChart(); } });
  }
  start();
})();
