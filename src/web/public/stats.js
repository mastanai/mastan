(() => {
  'use strict';
  const {h, api, setMain, fmtDate, fmtDateTime, toast} = MM;
  // Aggregates from the hourly mastan-stats counter, drawn with the Fleet usage styles.
  const whole = n => Math.round(n).toLocaleString('en-US');
  const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e5 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'K' : String(+n.toFixed(1));
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const riyadhDay = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const title = s => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
  const STALE_HOURS = 6;
  const METRICS = {
    messages: {label: 'Messages', title: 'Messages per day', series: [['Received', 'fu-s0', d => d.messages_in], ['Sent', 'fu-s2', d => d.messages_out]]},
    people: {label: 'People', title: 'People per day', series: [['Returning', 'fu-s0', d => Math.max(d.people_active - d.new_people, 0)], ['New', 'fu-s3', d => Math.min(d.new_people, d.people_active)]]},
    conversations: {label: 'Conversations', title: 'Conversations per day', series: [['Conversations', 'fu-s0', d => d.conversations]]},
  };
  const TOTALS = {messages: 'Total messages since launch', people: 'Total people since launch'};
  const RANGES = [['7', '7d'], ['14', '14d'], ['30', '30d'], ['90', '90d'], ['0', 'All']];
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const view = {metric: METRICS[stored('stats.metric')] ? stored('stats.metric') : 'messages',
    range: RANGES.some(([k]) => k === stored('stats.range')) ? +stored('stats.range') : 30,
    total: TOTALS[stored('stats.total')] ? stored('stats.total') : 'messages'};
  const host = h('div', {class: 'fu'});
  const SERVERS = {mac: 'Mac mini', 'prod-01': 'Canary', 'dev-01': 'dev-01', 'client-a-01': 'Client A', 'client-c-01': 'Client C', 'client-d-01': 'Client D', 'client-b-01': 'Client B (old)'};
  let everything = null, stats = null, drawn = '', server = stored('stats.server') || 'all';
  const q = id => host.querySelector(`#fu-${id}`);
  const applyWidths = root => root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  const sum = (rows, of) => rows.reduce((a, r) => a + of(r), 0);
  const hbar = (name, pct, value) => `<div class="fu-hbar"><span class="fu-name">${esc(name)}</span><div class="fu-track"><div class="fu-fill" data-w="${Math.max(pct, 1).toFixed(1)}"></div></div><span class="fu-v">${esc(value)}</span></div>`;

  const chart = (id, label) => `<div class="fu-chart" id="fu-${id}"><svg id="fu-${id}Svg" role="img" aria-label="${label}"></svg><div class="fu-tip" id="fu-${id}Tip" hidden></div></div>`;
  function shell() {
    host.innerHTML = `
      <ul class="fu-alerts card" id="fu-alerts" aria-label="Alerts" hidden></ul>
      <div class="filter-row"><div class="fu-seg fu-switch" id="fu-server" role="group" aria-label="Server"></div></div>
      <section class="fu-kpis" id="fu-totals" aria-label="All time"></section>
      <section class="fu-kpis" id="fu-recent" aria-label="Recent"></section>
      <section class="card fu-panel">
        <div class="fu-head"><h2 id="fu-dailyTitle"></h2><div class="fu-controls filter-row"><div class="fu-seg" id="fu-metric" role="group" aria-label="Metric"></div><div class="fu-seg" id="fu-range" role="group" aria-label="Date range"></div></div></div>
        ${chart('daily', 'Stacked bars per day')}
        <div class="fu-legend" id="fu-dailyLegend"></div>
      </section>
      <section class="card fu-panel">
        <div class="fu-head"><h2 id="fu-totalTitle"></h2><div class="fu-controls filter-row"><div class="fu-seg" id="fu-total" role="group" aria-label="Total"></div></div></div>
        ${chart('cumulative', 'Running total since launch')}
      </section>
      <section class="card fu-panel"><h2>People per week</h2>${chart('weekly', 'Stacked bars of people per week')}<div class="fu-legend" id="fu-weeklyLegend"></div></section>
      <div class="fu-two">
        <section class="card fu-panel"><div class="fu-head"><h2>Countries</h2><span class="muted small">by people</span></div><div id="fu-countries"></div></section>
        <section class="card fu-panel fu-language"><div class="fu-head"><h2>Languages</h2><span class="muted small">share of conversations</span></div><div id="fu-languages"></div><p class="muted small fu-note" id="fu-languagesNote"></p></section>
      </div>
      <section class="card fu-panel"><div class="fu-head"><h2>Channels</h2><span class="muted small">by messages</span></div><div id="fu-channels"></div></section>
      <section class="card fu-panel"><div class="fu-head"><h2>When people write</h2><span class="muted small">Riyadh time</span></div>${chart('hours', 'Messages by hour of day')}</section>
      <section class="card fu-panel"><h2 id="fu-tableTitle"></h2><div class="fu-scroll" tabindex="0" role="region" aria-label="Counts by day"><table class="fu-table" id="fu-table"></table></div></section>
      <section class="card fu-panel"><h2>How we count</h2><ul class="muted small fu-notes" id="fu-notes"></ul>
        <details class="fleet-output"><summary>All definitions</summary><ul class="muted small fu-notes" id="fu-definitions"></ul></details></section>`;
    const seg = (id, options, key, draw) => {
      const el = q(id);
      el.innerHTML = options.map(([k, label]) => `<button type="button" data-k="${k}">${label}</button>`).join('');
      el.addEventListener('click', e => {
        const k = e.target.dataset?.k;
        if (k === undefined) return;
        view[key] = key === 'range' ? +k : k;
        store('stats.' + key, k);
        draw();
      });
    };
    q('server').addEventListener('click', e => {
      const k = e.target.dataset?.k;
      if (k === undefined) return;
      server = k; store('stats.server', k);
      pick(); drawn = ''; draw();
    });
    seg('metric', Object.entries(METRICS).map(([k, v]) => [k, v.label]), 'metric', drawDaily);
    seg('range', RANGES, 'range', drawDaily);
    seg('total', Object.keys(TOTALS).map(k => [k, METRICS[k].label]), 'total', drawTotal);
  }

  const press = (id, value) => q(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === value)));
  const legend = series => series.map(([name, cls]) => `<span><span class="fu-swatch ${cls}"></span>${name}</span>`).join('');

  // One chart for every panel: rows are the bars, series the stacked parts of each bar.
  function bars(id, rows, series, {label, tipTitle}) {
    const svg = q(id + 'Svg'), tip = q(id + 'Tip'), box = q(id);
    const totals = rows.map(r => sum(series, ([, , of]) => of(r)));
    const max = Math.max(...totals, 1);
    const step = 10 ** Math.floor(Math.log10(max));
    const nice = [.25, .5, 1, 2, 2.5, 5, 10].map(k => k * step).find(v => v * 4 >= max) || step * 10;
    const top = nice * 4;
    const W = svg.clientWidth || 800, H = svg.clientHeight || 280, L = 48, R = 4, T = 8, B = 24;
    const pw = W - L - R, ph = H - T - B, slot = pw / rows.length, bw = Math.max(Math.min(slot - 2, 28), 2);
    const y = v => T + ph - v / top * ph;
    let s = '';
    for (let i = 0; i <= 4; i++) s += `<line class="fu-grid" x1="${L}" x2="${W - R}" y1="${y(nice * i)}" y2="${y(nice * i)}"/><text class="fu-axis" x="${L - 6}" y="${y(nice * i) + 4}" text-anchor="end">${fmtN(nice * i)}</text>`;
    const labelEvery = Math.ceil(rows.length / Math.max(Math.floor(pw / 56), 1));
    rows.forEach((r, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      let base = 0;
      for (const [, cls, of] of series) {
        const v = of(r);
        if (v <= 0) continue;
        s += `<rect class="${cls}" x="${x}" y="${y(base + v)}" width="${bw}" height="${Math.max(v / top * ph, .5)}"/>`;
        base += v;
      }
      s += `<rect class="fu-hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/>`;
      if ((rows.length - 1 - i) % labelEvery === 0) s += `<text class="fu-axis" x="${L + i * slot + slot / 2}" y="${H - 7}" text-anchor="middle">${esc(label(r))}</text>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    tip.hidden = true;
    const show = (el, cx) => {
      const i = +el.dataset.i, r = rows[i];
      const parts = series.length > 1 ? series.map(([name, , of]) => `<div><span>${name}</span><span>${whole(of(r))}</span></div>`).join('') : '';
      tip.innerHTML = `<b>${esc(tipTitle(r))}</b>${parts}<div class="${series.length > 1 ? 'fu-tiptotal' : ''}"><span>${series.length > 1 ? 'Total' : series[0][0]}</span><span>${whole(totals[i])}</span></div>`;
      tip.hidden = false;
      const bx = box.getBoundingClientRect();
      tip.style.left = Math.max(0, Math.min(cx - bx.left + 12, bx.width - tip.offsetWidth)) + 'px';
    };
    svg.querySelectorAll('.fu-hit').forEach(el => {
      el.addEventListener('mousemove', e => show(el, e.clientX));
      el.addEventListener('mouseleave', () => { tip.hidden = true; });
      el.addEventListener('click', e => show(el, e.clientX));
    });
  }

  function drawDaily() {
    const m = METRICS[view.metric], end = stats.period.end;
    press('metric', view.metric); press('range', String(view.range));
    const start = view.range ? addDays(end, -(view.range - 1)) : stats.period.start;
    const rows = stats.daily.filter(d => d.date >= start);
    q('dailyTitle').textContent = m.title;
    q('dailyLegend').innerHTML = m.series.length > 1 ? legend(m.series) : '';
    bars('daily', rows, m.series, {label: d => d.date.slice(5), tipTitle: d => fmtDate(d.date) + (d.date === end ? ' (so far)' : '')});
    const add = of => whole(sum(rows, of));
    const head = '<thead><tr><th>Day</th><th>Received</th><th>Sent</th><th>People</th><th>New</th><th>Conversations</th><th>Scheduled</th></tr></thead>';
    const body = rows.slice().reverse().map(d => `<tr><td>${fmtDate(d.date)}</td><td>${whole(d.messages_in)}</td><td>${whole(d.messages_out)}</td><td>${whole(d.people_active)}</td><td>${d.new_people ? whole(d.new_people) : ''}</td><td>${whole(d.conversations)}</td><td>${d.scheduled_deliveries ? whole(d.scheduled_deliveries) : ''}</td></tr>`).join('');
    // Daily active people repeat across days, so that column has no total.
    const foot = `<tfoot><tr><td>Total</td><td>${add(d => d.messages_in)}</td><td>${add(d => d.messages_out)}</td><td></td><td>${add(d => d.new_people)}</td><td>${add(d => d.conversations)}</td><td>${add(d => d.scheduled_deliveries)}</td></tr></tfoot>`;
    q('table').innerHTML = head + body + foot;
    q('tableTitle').textContent = `Day by day, ${RANGES.find(([k]) => k === String(view.range))[1]}`;
  }

  function drawTotal() {
    press('total', view.total);
    q('totalTitle').textContent = TOTALS[view.total];
    bars('cumulative', stats.cumulative, [[METRICS[view.total].label, 'fu-s0', d => d[view.total]]], {label: d => d.date.slice(5), tipTitle: d => fmtDate(d.date)});
  }

  function drawCharts() {
    drawDaily(); drawTotal();
    const weekly = [['Returning', 'fu-s0', w => Math.max(w.people_active - w.new_people, 0)], ['New', 'fu-s3', w => Math.min(w.new_people, w.people_active)]];
    bars('weekly', stats.weekly_people, weekly, {label: w => w.week_start.slice(5), tipTitle: w => `Week of ${fmtDate(w.week_start)}`});
    q('weeklyLegend').innerHTML = legend(weekly);
    bars('hours', stats.hour_of_day, [['Messages', 'fu-s0', r => r.messages]], {label: r => String(r.hour).padStart(2, '0'), tipTitle: r => `${String(r.hour).padStart(2, '0')}:00`});
  }

  function drawKpis() {
    const t = stats.totals, days = stats.daily, week = stats.weekly_people.at(-1);
    const messages = d => d.messages_in + d.messages_out, last = (n, skip = 0) => sum(days.slice(-(n + skip), skip ? -skip : undefined), messages);
    const trend = n => { const now = last(n), before = last(n, n); return before ? `${now >= before ? '+' : ''}${Math.round((now / before - 1) * 100)}% on the ${n} days before` : ''; };
    const tile = ([l, v, n]) => `<div class="card fu-kpi"><div class="muted small">${l}</div><div class="fu-value">${v}</div><div class="fu-faint">${n}</div></div>`;
    q('totals').innerHTML = [
      ['Messages', whole(t.messages), `${whole(t.messages_in)} received, ${whole(t.messages_out)} sent`],
      ['People', whole(t.people), `since ${fmtDate(stats.period.start)}`],
      ['Conversations', whole(t.conversations), `${whole(t.scheduled_deliveries)} scheduled deliveries`],
      ['Countries', whole(t.countries), t.languages == null ? '' : `${whole(t.languages)} languages`],
    ].map(tile).join('');
    q('recent').innerHTML = [
      [stats.period.end === riyadhDay() ? 'Messages today' : `Messages on ${fmtDate(stats.period.end)}`, whole(last(1)), 'latest day counted, partial'],
      ['Messages, 7 days', whole(last(7)), trend(7)],
      ['Messages, 30 days', whole(last(30)), trend(30)],
      ['People this week', whole(week.people_active), `${whole(week.new_people)} new`],
    ].map(tile).join('');
  }

  function drawLists() {
    const countries = stats.countries.slice().sort((a, b) => (a.country === 'unknown') - (b.country === 'unknown') || b.people - a.people);
    const topPeople = Math.max(...countries.map(c => c.people), 1);
    q('countries').innerHTML = countries.map(c => hbar(c.name, c.people / topPeople * 100, whole(c.people))).join('');
    host.querySelector('.fu-language')?.toggleAttribute('hidden', !stats.languages);
    if (stats.languages) { const topShare = Math.max(...stats.languages.map(l => l.share || 0), 1);
    q('languages').innerHTML = stats.languages.map(l => hbar(l.name, (l.share || 0) / topShare * 100, l.share == null ? 'rare' : l.share + '%')).join('');
    q('languagesNote').textContent = stats.languages_note || ''; }
    const channels = stats.channels.slice().sort((a, b) => b.messages - a.messages), topMessages = Math.max(...channels.map(c => c.messages), 1);
    q('channels').innerHTML = channels.map(c => hbar(`${c.channel === 'whatsapp' ? 'WhatsApp' : title(c.channel)}, ${whole(c.people)} ${c.people === 1 ? 'person' : 'people'}`, c.messages / topMessages * 100, whole(c.messages))).join('');
    for (const id of ['countries', 'languages', 'channels']) applyWidths(q(id));
    q('notes').innerHTML = [`Each person counts once in All, so the servers can add up to more. All also includes people whose early conversations were not kept. Languages are in All only. Canary counts real users only, no test accounts, and starts on ${fmtDate('2026-10-30')}.`, ...stats.coverage.map(c => `${fmtDate(c.from)} to ${fmtDate(c.to)}: ${c.note}`), 'Days and hours are Riyadh time. The latest day is partial.'].filter(Boolean).map(n => `<li>${esc(n)}</li>`).join('');
    q('definitions').innerHTML = Object.entries(stats.definitions || {}).map(([k, v]) => `<li><b>${esc(title(k))}.</b> ${esc(v)}</li>`).join('');
  }

  function draw() {
    const key = `${server}|${stats.generated_at}|${stats.checked_at}`;
    if (key === drawn) return;
    if (!host.firstChild) shell();
    drawn = key;
    q('server').innerHTML = [['all', 'All'], ...Object.keys(everything.servers || {}).filter(k => everything.servers[k].totals.messages).map(k => [k, SERVERS[k] || k])]
      .map(([k, label]) => `<button type="button" data-k="${esc(k)}" aria-pressed="${k === server}">${esc(label)}</button>`).join('');
    const old = (Date.now() - Date.parse(stats.generated_at)) / 3600e3 > STALE_HOURS;
    q('alerts').hidden = !old;
    q('alerts').innerHTML = old ? `<li><span class="badge bad">STALE</span><span>Last successful count ${esc(fmtDateTime(stats.generated_at))}. Numbers below are old.</span></li>` : '';
    drawKpis(); drawCharts(); drawLists();
  }

  // One server's numbers replace the charts; period, freshness and definitions stay from the whole.
  function pick() {
    const one = everything.servers?.[server];
    if (!one) server = 'all';
    stats = one ? {...everything, ...one, languages: null} : everything;
  }
  function render() {
    const counted = stats.generated_at ? `Counted ${fmtDateTime(stats.generated_at)}, refreshes hourly` : '';
    setMain(MM.pageHead('Stats', h('span', {class: 'muted small', text: counted})), host);
    draw();
  }
  async function load() {
    try {
      const value = await api('/api/numbers');
      if (value.available === false) { if (!stats) setMain(MM.pageHead('Stats'), MM.empty('No numbers yet. Check after the next hourly count.')); return; }
      everything = value; pick(); render();
    } catch (error) { if (!stats) setMain(MM.pageHead('Stats'), MM.errorState(error.message, load)); else toast(error.message, {error: true}); }
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (drawn) drawCharts(); }, 120); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 300_000);
})();
