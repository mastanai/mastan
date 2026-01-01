(() => {
  'use strict';
  const {h, api, setMain, fmtDate, fmtDateTime, badge, toast} = MM;
  let data = null, acting = false, loading = false, scrolled = '';
  const when = fmtDateTime;
  const stateLabel = state => state === 'approved' ? 'approved, running' : state;

  async function act(row, approve) {
    if (acting) return;
    acting = true; render();
    try {
      if (approve) {
        if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) throw new Error('This browser cannot use passkeys.');
        const options = await api(`/api/fleet/challenge/${row.id}`);
        const assertion = await SimpleWebAuthnBrowser.startAuthentication({optionsJSON: options});
        await api(`/api/fleet/approve/${row.id}`, {method: 'POST', body: assertion});
        toast('Approved. The gate is running this command once.');
      } else {
        await api(`/api/fleet/deny/${row.id}`, {method: 'POST'});
        toast('Request denied.');
      }
    } catch (error) {
      toast(error.name === 'NotAllowedError' ? 'Passkey cancelled. Request is still pending.' : error.message, {error: true});
    } finally { acting = false; await load(); }
  }

  function request(row, pending) {
    const timing = pending ? `expires ${fmtDateTime(row.expires)}` : `exit ${row.exit_code ?? 'pending'}`;
    const el = h('article', {class: `fleet-request card fleet-${row.state}${pending ? ' fleet-approval' : ''}`, id: `r${row.id}`}, h('div', {class: 'fleet-request-body'},
      h('div', {class: 'fleet-row'}, h('h3', {text: row.server}), badge(row.state, stateLabel(row.state))),
      h('pre', {class: 'fleet-command'}, h('code', {text: row.command})),
      h('p', {text: row.reason}),
      h('p', {class: 'muted small', text: `${when(row.created)} · ${timing}`})));
    if (pending) el.append(h('div', {class: 'btn-row fleet-request-actions'},
      h('button', {class: 'btn primary', type: 'button', disabled: acting, text: 'Approve with passkey', onclick: () => act(row, true)}),
      h('button', {class: 'btn bad', type: 'button', disabled: acting, text: 'Deny', onclick: () => act(row, false)})));
    if (row.output) el.append(h('details', {class: 'fleet-output'}, h('summary', {text: 'Output'}), h('pre', {text: row.output})));
    return el;
  }

  function scrollToRequest() {
    if (!/^#r[a-f0-9]{32}$/.test(location.hash) || scrolled === location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) { el.scrollIntoView({block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); scrolled = location.hash; }
  }

  // Usage, cost and server data from the fleet-usage collector.
  const SERIES = 8;
  const fmtN = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n));
  const fmtUsd = n => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
  const fmtEur = n => '€' + n.toFixed(2);
  const fmtBytes = n => n >= 1e12 ? (n / 1e12).toFixed(1) + ' TB' : Math.round(n / 1e9) + ' GB';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const riyadhDay = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const whenSeconds = s => fmtDateTime(s * 1000);
  const METRICS = {
    total: {label: 'Total tokens', title: 'Tokens', of: r => r.input + r.output, fmt: fmtN},
    fresh: {label: 'Fresh tokens', title: 'Fresh tokens', of: r => Math.max(r.input - r.cached, 0) + r.output, fmt: fmtN},
    cost: {label: 'Est. cost', title: 'Estimated cost', of: r => r.cost || 0, fmt: fmtUsd},
  };
  const RANGES = [['7', '7d'], ['14', '14d'], ['30', '30d'], ['0', 'All']];
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const view = {metric: METRICS[stored('fleet.metric')] ? stored('fleet.metric') : 'total',
    range: RANGES.some(([k]) => k === stored('fleet.range')) ? +stored('fleet.range') : 30};
  const usageHost = h('div', {class: 'fu'});
  let usage = null, drawn = '';

  const colorClass = s => `fu-s${s.color < SERIES ? s.color : 'x'}`;
  const sum = (rows, of, test) => { let t = 0; for (const r of rows) if (test(r)) t += of(r); return t; };
  const q = id => usageHost.querySelector(`#fu-${id}`);
  // The page's CSP allows no style attributes, so bar widths are set through the DOM.
  const applyWidths = root => root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  function rows() {
    // The public server records its own cost per day, so it joins the priced rows here.
    return usage.usage.concat(usage.daily.filter(d => d.recorded_cost).map(d => ({server: d.server, day: d.day, source: 'recorded', model: 'recorded', requests: 0, input: 0, cached: 0, cache_write: 0, output: 0, reasoning: 0, cost: d.recorded_cost})));
  }

  function shell() {
    usageHost.innerHTML = `
      <ul class="fu-alerts card" id="fu-alerts" aria-label="Alerts" hidden></ul>
      <section class="fu-kpis" id="fu-kpis" aria-label="Summary"></section>
      <section class="card fu-panel">
        <div class="fu-head"><h2 id="fu-chartTitle"></h2><div class="fu-controls filter-row"><div class="fu-seg" id="fu-metric" role="group" aria-label="Metric"></div><div class="fu-seg" id="fu-range" role="group" aria-label="Date range"></div></div></div>
        <div class="fu-chart" id="fu-chart"><svg id="fu-svg" role="img" aria-label="Stacked bars of usage per server per day"></svg><div class="fu-tip" id="fu-tip" hidden></div></div>
        <div class="fu-legend" id="fu-legend"></div>
      </section>
      <section class="card fu-panel"><div class="fu-head"><h2>Hetzner running rate per month</h2><span class="muted small" id="fu-hetznerBasis"></span></div><div class="fu-hero" id="fu-hetznerTotal"></div><div id="fu-hetzner"></div>
        <p class="muted small fu-note">List prices with 23% VAT: server, backups and IPv4. What the servers running now would cost for a full month. Hetzner bills hours used, so an invoice can differ.</p></section>
      <section class="card fu-panel" id="fu-invoicePanel" hidden><div class="fu-head"><h2>Hetzner invoices</h2><span class="muted small" id="fu-invoiceSummary"></span></div><div class="fu-hero" id="fu-invoiceLatest"></div><div id="fu-invoices"></div>
        <p class="muted small fu-note">Actual amounts from Hetzner's invoice emails, for the whole account. Each invoice mostly covers the month before it was issued. Dated by issue date.</p></section>
      <section aria-label="Servers"><div class="fu-head"><h2>Servers</h2><span class="muted small" id="fu-serverCount"></span></div><div class="fleet-servers" id="fu-cards"></div></section>
      <section class="card fu-panel"><h2 id="fu-modelTitle"></h2><div id="fu-models"></div></section>
      <section class="card fu-panel"><h2 id="fu-tableTitle"></h2><div class="fu-scroll" tabindex="0" role="region" aria-label="Usage by day"><table class="fu-table" id="fu-table"></table></div></section>
      <section class="card fu-panel"><h2>How to read this</h2><ul class="muted small fu-notes">
        <li><b>Total tokens</b> = input including cache + output. <b>Fresh tokens</b> leave out cached input, which is most of the total and much cheaper.</li>
        <li><b>Est. cost</b> is what the priced usage would cost at API list prices. Most of it runs on subscriptions today, so it is not a bill. The public server's cost is its own record, which starts on ${fmtDate('2026-11-03')}.</li>
        <li>Days are Riyadh days. Today is partial. Counts only: no message text, file names or user ids reach this page.</li>
        <li>Not counted: the hosted web-search worker on client servers, and the Mac mini, which is not a server here.</li>
      </ul></section>`;
    const seg = (id, options, key) => {
      const el = q(id);
      el.innerHTML = options.map(([k, label]) => `<button type="button" data-k="${k}">${label}</button>`).join('');
      el.addEventListener('click', e => {
        const k = e.target.dataset?.k;
        if (k === undefined) return;
        view[key] = key === 'range' ? +k : k;
        store('fleet.' + key, k);
        drawChart(rows());
      });
    };
    seg('metric', Object.entries(METRICS).map(([k, v]) => [k, v.label]), 'metric');
    seg('range', RANGES, 'range');
  }

  function drawAlerts(all) {
    const out = [], today = riyadhDay();
    if (Date.now() / 1000 - usage.generated_at > 2.5 * 3600) out.push(['bad', 'Stale', `Collector last ran ${whenSeconds(usage.generated_at)}. Numbers below are old.`]);
    for (const s of usage.servers) {
      if (s.discovered) out.push(['warn', 'New server', `${s.name} is on Hetzner but not connected yet (${fmtEur(s.monthly_eur)} a month).`]);
      if (!s.connected) continue;
      if (s.last_error) out.push(['bad', 'Unreachable', `${s.name}: last good read ${s.last_ok ? whenSeconds(s.last_ok) : 'never'}.`]);
      const hl = s.health;
      if (hl) {
        const failed = Object.entries(hl.services).filter(([, v]) => v !== 'active').map(([k]) => k);
        if (failed.length) out.push(['bad', 'Service down', `${s.name}: ${failed.join(', ')}.`]);
        const disk = hl.disk_used / hl.disk_total, mem = hl.mem_used / hl.mem_total;
        if (disk >= .8) out.push([disk >= .9 ? 'bad' : 'warn', 'Disk', `${s.name} is ${Math.round(disk * 100)}% full.`]);
        if (mem >= .9) out.push(['warn', 'Memory', `${s.name} is using ${Math.round(mem * 100)}% of RAM.`]);
        // Off-site backup: `backup` is absent on an old exporter, null when the server has none.
        const bk = hl.backup;
        if (bk === null) out.push(['warn', 'Backup', `${s.name} has no off-site backup.`]);
        else if (bk) {
          const lastGood = bk.last_success ? `last good backup ${whenSeconds(bk.last_success)}` : 'no good backup yet';
          if (!bk.last_success || Date.now() / 1000 - bk.last_success > 26 * 3600) out.push(['bad', 'Backup', `${s.name}: ${lastGood}${bk.error ? ' (' + bk.error + ')' : ''}.`]);
          else if (bk.result === 'failed') out.push(['warn', 'Backup', `${s.name}: latest run failed, ${lastGood}.`]);
          else if (bk.result === 'warning') out.push(['warn', 'Backup', `${s.name}: ${bk.error || 'finished with warnings'}.`]);
        }
      }
      if (s.source_errors?.length) out.push(['warn', 'Partial', `${s.name}: could not read ${s.source_errors.join(', ')}.`]);
      if (s.kind === 'Client') {
        const days = all.filter(r => r.server === s.name && r.input + r.output > 0).map(r => r.day).sort();
        const last = days[days.length - 1];
        if (!last || last < addDays(today, -7)) out.push(['warn', 'Idle', `${s.name}: no tokens since ${last ? fmtDate(last) : 'it was connected'}. Either it is not being used or messages are not reaching it.`]);
      }
    }
    const latest = (usage.invoices || []).at(-1);
    if (latest && latest.issued < addDays(today, -40)) out.push(['warn', 'Invoices', `Latest Hetzner invoice is from ${fmtDate(latest.issued)}. The monthly check may have lost access to the inbox.`]);
    q('alerts').hidden = !out.length;
    const tags = {Stale: 'STALE', Unreachable: 'DOWN', 'Service down': 'DOWN'};
    q('alerts').innerHTML = out.map(([c, t, m]) => `<li><span class="badge ${c}">${tags[t] || (c === 'bad' ? 'ALERT' : 'WARN')}</span><span><b>${esc(t)}</b> ${esc(m)}</span></li>`).join('');
  }

  function drawKpis(all) {
    const today = riyadhDay(), of = METRICS.total.of, inLast = n => r => r.day > addDays(today, -n);
    const t30 = sum(all, of, inLast(30)), fresh30 = sum(all, METRICS.fresh.of, inLast(30));
    const active = new Set(all.filter(r => r.day === today && r.input + r.output > 0).map(r => r.server)).size;
    const kpis = [
      ['Tokens today', fmtN(sum(all, of, r => r.day === today)), `${active} of ${usage.servers.filter(s => s.connected).length} connected servers active`],
      ['Tokens, 7 days', fmtN(sum(all, of, inLast(7))), `${fmtN(sum(all, METRICS.fresh.of, inLast(7)))} fresh`],
      ['Tokens, 30 days', fmtN(t30), `${fmtN(fresh30)} fresh, ${t30 ? Math.round((1 - fresh30 / t30) * 100) : 0}% cached`],
      ['Est. cost, 30 days', fmtUsd(sum(all, r => r.cost || 0, inLast(30))), 'at API prices, not a bill'],
    ];
    q('kpis').innerHTML = kpis.map(([l, v, n]) => `<div class="card fu-kpi"><div class="muted small">${l}</div><div class="fu-value">${v}</div><div class="fu-faint">${n}</div></div>`).join('');
  }

  function drawChart(all) {
    const m = METRICS[view.metric], today = riyadhDay();
    for (const [id, value] of [['metric', view.metric], ['range', String(view.range)]])
      q(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === value)));
    const first = all.length ? all.reduce((a, r) => r.day < a ? r.day : a, today) : today;
    const start = view.range ? addDays(today, -(view.range - 1)) : first;
    const days = [];
    for (let d = start; d <= today; d = addDays(d, 1)) days.push(d);
    const used = new Set(all.filter(r => r.day >= start && m.of(r) > 0).map(r => r.server));
    const servers = usage.servers.filter(s => used.has(s.name));
    const grid = new Map(days.map(d => [d, new Map()]));
    for (const r of all) if (grid.has(r.day)) grid.get(r.day).set(r.server, (grid.get(r.day).get(r.server) || 0) + m.of(r));
    const totals = days.map(d => [...grid.get(d).values()].reduce((a, b) => a + b, 0));
    const max = Math.max(...totals, m === METRICS.cost ? .01 : 1);
    const step = 10 ** Math.floor(Math.log10(max));
    const nice = [1, 2, 2.5, 5, 10].map(k => k * step).find(v => v * 4 >= max) || step * 10;
    const top = nice * 4;
    const svg = q('svg');
    const W = svg.clientWidth || 800, H = svg.clientHeight || 280, L = 48, R = 4, T = 8, B = 24;
    const pw = W - L - R, ph = H - T - B, slot = pw / days.length, bw = Math.max(Math.min(slot - 2, 28), 2);
    const y = v => T + ph - v / top * ph;
    let s = '';
    for (let i = 0; i <= 4; i++) {
      const v = nice * i;
      s += `<line class="fu-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="fu-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${m.fmt(v)}</text>`;
    }
    const labelEvery = Math.ceil(days.length / Math.max(Math.floor(pw / 56), 1));
    days.forEach((d, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      let base = 0;
      const parts = servers.map(sv => [sv, grid.get(d).get(sv.name) || 0]).filter(p => p[1] > 0);
      parts.forEach(([sv, v], j) => {
        const hgt = v / top * ph, gap = j < parts.length - 1 && hgt > 3 ? 2 : 0, yy = y(base + v), r = Math.min(4, bw / 2, hgt);
        s += j === parts.length - 1
          ? `<path class="${colorClass(sv)}" d="M${x} ${yy + hgt}V${yy + r}Q${x} ${yy} ${x + r} ${yy}H${x + bw - r}Q${x + bw} ${yy} ${x + bw} ${yy + r}V${yy + hgt}Z"/>`
          : `<rect class="${colorClass(sv)}" x="${x}" y="${yy + gap}" width="${bw}" height="${Math.max(hgt - gap, .5)}"/>`;
        base += v;
      });
      s += `<rect class="fu-hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/>`;
      if ((days.length - 1 - i) % labelEvery === 0) s += `<text class="fu-axis" x="${L + i * slot + slot / 2}" y="${H - 7}" text-anchor="middle">${d.slice(5)}</text>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    q('legend').innerHTML = servers.map(sv => `<span><span class="fu-swatch ${colorClass(sv)}"></span>${esc(sv.name)}</span>`).join('');
    q('chartTitle').textContent = `${m.title} per server per day`;
    const tip = q('tip'), box = q('chart');
    tip.hidden = true;
    const show = (el, cx) => {
      const i = +el.dataset.i, d = days[i];
      const lines = servers.map(sv => [sv.name, grid.get(d).get(sv.name) || 0]).filter(p => p[1] > 0).sort((a, b) => b[1] - a[1]);
      tip.innerHTML = `<b>${fmtDate(d)}${d === today ? ' (so far)' : ''}</b>` + (lines.length ? lines.map(([n, v]) => `<div><span>${esc(n)}</span><span>${m.fmt(v)}</span></div>`).join('') + `<div class="fu-tiptotal"><span>Total</span><span>${m.fmt(totals[i])}</span></div>` : '<div><span>No usage</span></div>');
      tip.hidden = false;
      const bx = box.getBoundingClientRect();
      tip.style.left = Math.max(0, Math.min(cx - bx.left + 12, bx.width - tip.offsetWidth)) + 'px';
    };
    svg.querySelectorAll('.fu-hit').forEach(el => {
      el.addEventListener('mousemove', e => show(el, e.clientX));
      el.addEventListener('mouseleave', () => { tip.hidden = true; });
      el.addEventListener('click', e => show(el, e.clientX));
    });
    const head = `<thead><tr><th>Day</th>${servers.map(sv => `<th>${esc(sv.name)}</th>`).join('')}<th>Total</th></tr></thead>`;
    const body = days.slice().reverse().map(d => `<tr><td>${fmtDate(d)}</td>${servers.map(sv => `<td>${grid.get(d).get(sv.name) ? m.fmt(grid.get(d).get(sv.name)) : ''}</td>`).join('')}<td>${totals[days.indexOf(d)] ? m.fmt(totals[days.indexOf(d)]) : ''}</td></tr>`).join('');
    const foot = `<tfoot><tr><td>Total</td>${servers.map(sv => `<td>${m.fmt(days.reduce((a, d) => a + (grid.get(d).get(sv.name) || 0), 0))}</td>`).join('')}<td>${m.fmt(totals.reduce((a, b) => a + b, 0))}</td></tr></tfoot>`;
    q('table').innerHTML = head + body + foot;
    q('tableTitle').textContent = `${m.title}, day by server`;
    const models = new Map(), rank = METRICS[view.metric === 'cost' ? 'total' : view.metric];
    for (const r of all) if (r.day >= start && r.source !== 'recorded') {
      const label = r.source === 'public' ? 'Public: ' + r.model.replace('role:', '') : r.model;
      models.set(label, (models.get(label) || 0) + rank.of(r));
    }
    const ranked = [...models].filter(p => p[1] > 0).sort((a, b) => b[1] - a[1]), mm = ranked.length ? ranked[0][1] : 1;
    q('models').innerHTML = ranked.map(([n, v]) => hbar(esc(n), v / mm * 100, fmtN(v))).join('') || '<span class="muted small">No usage in this range.</span>';
    applyWidths(q('models'));
    q('modelTitle').textContent = `By model (${view.metric === 'fresh' ? 'fresh' : 'total'} tokens, ${RANGES.find(([k]) => k === String(view.range))[1]})`;
  }

  const hbar = (name, pct, value) => `<div class="fu-hbar"><span class="fu-name">${name}</span><div class="fu-track"><div class="fu-fill" data-w="${Math.max(pct, 1).toFixed(1)}"></div></div><span class="fu-v">${value}</span></div>`;

  function drawHetzner() {
    const priced = usage.servers.filter(s => s.monthly_eur != null).sort((a, b) => b.monthly_eur - a.monthly_eur);
    const total = priced.reduce((a, s) => a + s.monthly_eur, 0);
    const firm = priced.filter(s => s.cost_basis !== 'estimate').reduce((a, s) => a + s.monthly_eur, 0);
    const top = priced.length ? priced[0].monthly_eur : 1;
    const labels = {live: 'live', list: 'list price', recorded: 'from console', estimate: 'estimate'};
    q('hetznerTotal').textContent = fmtEur(total);
    q('hetznerBasis').textContent = firm === total ? `${priced.length} servers` : `${fmtEur(firm)} firm, ${fmtEur(total - firm)} estimated`;
    q('hetzner').innerHTML = priced.map(s => hbar(`${esc(s.name)} <span class="fu-faint">${labels[s.cost_basis] || ''}</span>`, s.monthly_eur / top * 100, fmtEur(s.monthly_eur))).join('');
    applyWidths(q('hetzner'));
    const all = usage.invoices || [];
    q('invoicePanel').hidden = !all.length;
    if (!all.length) return;
    const recent = all.slice(-12).reverse(), peak = Math.max(...recent.map(i => i.eur));
    q('invoiceLatest').textContent = fmtEur(recent[0].eur);
    q('invoiceSummary').textContent = `Latest, issued ${fmtDate(recent[0].issued)}. Last 12: ${fmtEur(recent.reduce((a, i) => a + i.eur, 0))}`;
    q('invoices').innerHTML = recent.map(i => hbar(esc(fmtDate(i.issued)), i.eur / peak * 100, fmtEur(i.eur))).join('');
    applyWidths(q('invoices'));
  }

  function drawCards(all) {
    const today = riyadhDay(), of = METRICS.total.of;
    const gate = new Map((data?.servers || []).map(s => [s.name, s]));
    const barRow = (label, used, total) => {
      const p = used / total, cls = p >= .9 ? 'bad' : p >= .8 ? 'warn' : '';
      return `<div class="fu-bar"><span>${label}</span><div class="fu-track"><div class="fu-fill ${cls}" data-w="${Math.round(p * 100)}"></div></div><span class="fu-v">${Math.round(p * 100)}% of ${fmtBytes(total)}</span></div>`;
    };
    const cards = usage.servers.map(s => {
      const mine = all.filter(r => r.server === s.name);
      const usedDays = mine.filter(r => r.input + r.output > 0).map(r => r.day).sort(), last = usedDays[usedDays.length - 1];
      const hl = s.health;
      let state = s.discovered ? ['warn', 'Not connected'] : ['off', 'Listed only'];
      if (s.connected) {
        const down = hl && Object.values(hl.services).some(v => v !== 'active');
        state = s.last_error ? ['bad', 'Unreachable'] : !hl ? ['off', 'Waiting'] : down ? ['bad', 'Service down'] : ['ok', 'Healthy'];
      }
      const t = n => fmtN(sum(mine, of, r => r.day > addDays(today, -n)));
      const cost = sum(mine, r => r.cost || 0, r => r.day > addDays(today, -30));
      const pub = usage.daily.filter(d => d.server === s.name && d.public_users != null && d.day > addDays(today, -7));
      const peak = pub.length ? Math.max(...pub.map(d => d.public_users)) : null;
      const metered = s.connected && mine.length;
      const g = gate.get(s.name); gate.delete(s.name);
      return `<article class="card fleet-server">
        <div class="fleet-row"><h3>${metered ? `<span class="fu-swatch ${colorClass(s)}"></span>` : ''}${esc(s.name)}</h3><span class="badge ${state[0]}">${state[1]}</span></div>
        <p class="small">${esc(s.summary)}</p>
        <p class="fu-faint">${esc(s.kind)} · ${esc(s.client)} · ${esc(s.ip)}<br>${esc(s.spec)}${s.since ? ' · since ' + esc(fmtDate(s.since)) : ''}${s.monthly_eur != null ? ` · ${s.cost_basis === 'estimate' ? 'about ' : ''}${fmtEur(s.monthly_eur)} a month` : ''}</p>
        ${metered ? `<div class="fu-nums"><div><b>${t(1)}</b><span>today</span></div><div><b>${t(7)}</b><span>7 days</span></div><div><b>${t(30)}</b><span>30 days</span></div></div>
        <p class="fu-faint">Last tokens ${last ? fmtDate(last) : 'never'}${cost ? ' · est. ' + fmtUsd(cost) + ' in 30 days' : ''}${peak != null ? ' · up to ' + peak + ' users a day this week' : ''}</p>` : (s.connected ? '<p class="fu-faint">No AI usage recorded on this server.</p>' : '')}
        ${hl ? barRow('RAM', hl.mem_used, hl.mem_total) + barRow('Disk', hl.disk_used, hl.disk_total) : ''}
        ${hl && hl.backup !== undefined ? `<p class="fu-gate">Off-site backup: ${hl.backup && hl.backup.last_success ? esc(whenSeconds(hl.backup.last_success)) + (hl.backup.result === 'ok' ? '' : ' · ' + esc(hl.backup.result)) : 'none'}</p>` : ''}
        ${g ? `<p class="fu-gate"><span class="badge fleet-health ${g.reachable ? 'ok reachable' : 'bad unreachable'}">Monitor: ${g.reachable ? 'reachable' : 'unreachable'}</span>${g.health ? ' · ' + esc(g.health) : ''}</p>` : ''}
      </article>`;
    });
    for (const g of gate.values()) cards.push(`<article class="card fleet-server"><div class="fleet-row"><h3>${esc(g.name)}</h3><span class="badge fleet-health ${g.reachable ? 'ok reachable' : 'bad unreachable'}">${g.reachable ? 'Reachable' : 'Unreachable'}</span></div><p class="muted small">${esc(g.client)}</p><p class="small">${esc(g.health)}</p></article>`);
    q('cards').innerHTML = cards.join('');
    applyWidths(q('cards'));
    q('serverCount').textContent = `${usage.servers.length} servers, ${usage.servers.filter(s => s.connected).length} connected`;
  }

  function drawUsage() {
    const key = `${usage.generated_at}|${JSON.stringify(data?.servers || [])}`;
    if (key === drawn) return;
    if (!drawn) shell();
    drawn = key;
    const all = rows();
    drawAlerts(all); drawKpis(all); drawChart(all); drawHetzner(); drawCards(all);
  }
  async function loadUsage() {
    try { const value = await api('/api/fleet/usage'); if (value.available !== false) { usage = value; render(); } }
    catch { /* the approvals still work without it */ }
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (drawn) drawChart(rows()); }, 120); });

  function render() {
    if (!data && !usage) return;
    const open = new Set([...document.querySelectorAll('.fleet-output[open]')].map(el => el.closest('article').id));
    const title = MM.pageHead('Fleet', h('span', {class: 'muted small', text: usage ? `Updated ${whenSeconds(usage.generated_at)}, refreshes hourly` : 'Server health and requests for your approval.'}));
    const gate = data || {installed: true, pending: [], servers: [], requests: []};
    const missing = gate.installed ? null : h('p', {class: 'empty', text: gate.error || 'The fleet gate is not installed.'});
    const pendingIds = new Set((gate.pending || []).map(r => r.id));
    const pending = gate.pending?.length ? h('section', {'aria-label': 'Pending approvals'}, h('h2', {text: `Pending approvals (${gate.pending.length})`}), gate.pending.map(r => request(r, true))) : null;
    const servers = usage ? null : h('section', {'aria-label': 'Servers'}, h('h2', {text: 'Servers'}), h('div', {class: 'fleet-servers'}, (gate.servers || []).map(s =>
      h('article', {class: 'card fleet-server'}, h('div', {class: 'fleet-row'}, h('h3', {text: s.name}),
        h('span', {class: `badge fleet-health ${s.reachable ? 'ok reachable' : 'bad unreachable'}`, text: s.reachable ? 'Reachable' : 'Unreachable'})),
      h('p', {class: 'muted small', text: s.client}), h('p', {class: 'small', text: s.health})))));
    const recent = (gate.requests || []).filter(r => !pendingIds.has(r.id));
    const history = gate.installed ? h('section', {'aria-label': 'Recent requests'}, h('h2', {text: 'Recent requests'}),
      recent.length ? recent.map(r => request(r, false)) : h('p', {class: 'empty', text: 'No recent requests. New approval requests appear here.'})) : null;
    setMain(title, pending, usage ? usageHost : null, servers, missing, history);
    if (usage) drawUsage();
    for (const id of open) document.getElementById(id)?.querySelector('details')?.setAttribute('open', '');
    scrollToRequest();
  }
  async function load() {
    if (loading || acting) return;
    loading = true;
    try { data = await api('/api/fleet'); render(); }
    catch (error) { if (!data && !usage) setMain(MM.pageHead('Fleet'), MM.errorState(error.message, load)); else toast(error.message, {error: true}); }
    finally { loading = false; }
  }
  window.addEventListener('hashchange', () => { scrolled = ''; scrollToRequest(); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 10_000);
  loadUsage();
  setInterval(() => { if (!document.hidden) loadUsage(); }, 300_000);
})();
