// Atlas: 3D force graph of positions and people (3d-force-graph, vendored), 2D canvas fallback.
// Views: every star, tensions only, new since the last visit, focus on one star and its neighbours.
// The panel confirms, rejects (with a reason), takes notes, and hands a star to the chat ("Ask").
(() => {
  'use strict';
  const {h, api, toast, color, refreshStats, pct, statusLabel, confidence, fmtDate, busy, fill} = window.MM;
  const theme = getComputedStyle(document.documentElement);
  const ink = theme.getPropertyValue('--ink').trim(), accent = theme.getPropertyValue('--accent').trim();
  const PEOPLE = 'People';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const light = document.documentElement.dataset.theme === 'light';
  const LINK_COLORS = light ? {
    tension: '#a93a2a', supports: '#1f6a48', depends: '#24597d', about_person: '#56635b',
    family: '#934a33', friend: '#914666', colleague: '#24597d', works_at: '#465fa1',
    works_on: '#586b22', client: '#7d5610', reports_to: '#71509b', manager: '#71509b',
    partner: '#236b6b', vendor: '#6e6045', owner: '#586b22', related: '#47544c',
  } : {
    tension: 'rgba(255,107,107,0.9)', supports: 'rgba(94,227,125,0.6)', depends: 'rgba(124,196,255,0.6)', about_person: 'rgba(152,163,156,0.7)',
    family: 'rgba(255,138,76,0.8)', friend: 'rgba(255,126,182,0.75)', colleague: 'rgba(79,157,255,0.75)', works_at: 'rgba(160,180,255,0.7)',
    works_on: 'rgba(212,242,90,0.7)', client: 'rgba(255,201,77,0.75)', reports_to: 'rgba(180,140,255,0.8)', manager: 'rgba(180,140,255,0.8)',
    partner: 'rgba(63,224,224,0.7)', vendor: 'rgba(217,167,122,0.7)', owner: 'rgba(212,242,90,0.7)', related: 'rgba(134,174,203,0.65)',
  };
  const LINK_LABELS = {about_person: 'about a person', works_at: 'works at', works_on: 'works on', reports_to: 'reports to', related: 'related'};
  const WIDE = new Set(['family', 'friend', 'colleague', 'works_at', 'works_on', 'client', 'reports_to', 'manager', 'partner', 'vendor', 'owner', 'supports', 'depends']);
  const linkColor = l => LINK_COLORS[l.type] || LINK_COLORS.related;
  const linkLabel = t => LINK_LABELS[t] || String(t || 'related').replace(/_/g, ' ');
  const store = {get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }};

  let data = {nodes: [], links: []}, domains = [], byId = new Map(), hidden = new Set(), hiddenLines = new Set(), selected = null;
  let mode = {kind: 'all'}; // all | tensions | new | focus (id)
  let tensionIds = new Set(), newIds = new Set(), lineCounts = new Map();
  const opened = Date.now();
  let view = null; // {focus(node), refresh(), remove(id), pause(), resume(), kind}

  const wrap = h('div', {class: 'atlas-wrap'});
  const graphEl = h('div', {id: 'graph'});
  const legend = h('aside', {class: 'legend', 'aria-label': 'Legend'});
  const note = h('div', {class: 'atlas-note'});
  const sheet = h('section', {class: 'sheet', 'aria-label': 'Details', 'aria-hidden': 'true'});
  const pending = MM.loading(); pending.classList.add('atlas-state');
  const heading = MM.pageHead('Atlas'); heading.classList.add('atlas-head');
  wrap.append(graphEl, heading, legend, note, pending);
  window.MM.setMain(wrap);
  document.body.append(sheet);

  const groupOf = n => (n.kind === 'position' ? (n.domain || 'Other') : PEOPLE);
  const idOf = end => (typeof end === 'object' && end ? end.id : end);
  const isNew = n => newIds.has(n.id);
  function visible(n) {
    if (hidden.has(groupOf(n))) return false;
    if (mode.kind === 'tensions') return tensionIds.has(n.id);
    if (mode.kind === 'new') return isNew(n);
    if (mode.kind === 'focus') return n.id === mode.id || neighbours(mode.id).has(n.id);
    return true;
  }
  const linkOk = l => !hiddenLines.has(l.type || 'related') && (mode.kind !== 'tensions' || l.type === 'tension');
  function linkVisible() {
    return l => { const s = byId.get(idOf(l.source)), t = byId.get(idOf(l.target)); return !!(s && t && linkOk(l) && visible(s) && visible(t)); };
  }
  const nodeColor = n => {
    const base = color(groupOf(n));
    if (selected && selected !== n.id && !neighbours(selected).has(n.id)) return hexAlpha(base, 0.22);
    if (isNew(n)) return base;
    if (n.kind === 'position' && n.status === 'needs_confirmation') return hexAlpha(base, 0.78);
    return base;
  };
  function hexAlpha(hex, a) {
    const v = hex.replace('#', '');
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  let neighbourCache = new Map();
  function neighbours(id) {
    if (!neighbourCache.has(id)) {
      const set = new Set();
      for (const l of data.links) { const s = idOf(l.source), t = idOf(l.target); if (s === id) set.add(t); if (t === id) set.add(s); }
      neighbourCache.set(id, set);
    }
    return neighbourCache.get(id);
  }
  function nodeVal(n) {
    const base = n.kind === 'position' ? 1.2 + 4 * Math.max(0, Math.min(1, Number(n.confidence) || 0.3)) : 0.5 + Math.min(0.5, neighbours(n.id).size * 0.05);
    return isNew(n) && n.kind === 'position' ? base * 1.7 : base;
  }
  function index() {
    byId = new Map(data.nodes.map(n => [n.id, n]));
    data.links = data.links.filter(l => byId.has(idOf(l.source)) && byId.has(idOf(l.target)));
    neighbourCache = new Map();
    tensionIds = new Set(); lineCounts = new Map();
    for (const l of data.links) {
      const t = l.type || 'related';
      lineCounts.set(t, (lineCounts.get(t) || 0) + 1);
      if (t === 'tension') { tensionIds.add(idOf(l.source)); tensionIds.add(idOf(l.target)); }
    }
  }
  // New = added to the atlas after the last visit. The visit is recorded when the page is left.
  function computeNew() {
    const seen = Number(store.get('mm-atlas-seen')) || 0;
    newIds = new Set(seen ? data.nodes.filter(n => n.added && Date.parse(n.added) > seen).map(n => n.id) : []);
  }
  function markSeen() { store.set('mm-atlas-seen', String(Math.max(Number(store.get('mm-atlas-seen')) || 0, opened))); }
  addEventListener('pagehide', markSeen);
  document.addEventListener('visibilitychange', () => { if (document.hidden) markSeen(); });

  function setMode(next) {
    mode = next;
    renderLegend(); view?.refresh();
  }

  // --- legend
  function renderLegend() {
    const counts = new Map();
    for (const n of data.nodes) counts.set(groupOf(n), (counts.get(groupOf(n)) || 0) + 1);
    const groups = [...new Set([...domains, PEOPLE])].filter(d => counts.get(d));
    for (const g of counts.keys()) if (!groups.includes(g)) groups.push(g);
    const collapsed = store.get('mm-legend') === 'collapsed' || (window.innerWidth < 760 && store.get('mm-legend') !== 'open');
    legend.classList.toggle('collapsed', collapsed);
    const toggle = h('button', {type: 'button', text: collapsed ? 'Show' : 'Hide', onclick: () => {
      const now = !legend.classList.contains('collapsed');
      legend.classList.toggle('collapsed', now); toggle.textContent = now ? 'Show' : 'Hide'; store.set('mm-legend', now ? 'collapsed' : 'open');
    }});
    const total = data.nodes.length;
    const anyFilter = hidden.size || hiddenLines.size || mode.kind !== 'all';
    const modeChip = (kind, label, n) => h('button', {class: 'chip mode', type: 'button', 'aria-pressed': String(mode.kind === kind), disabled: !n,
      onclick: () => setMode(mode.kind === kind ? {kind: 'all'} : {kind})}, label, h('b', {text: n}));
    const focusNode = mode.kind === 'focus' ? byId.get(mode.id) : null;
    const lineTypes = [...lineCounts.entries()].sort((a, b) => b[1] - a[1]);
    const groupRow = g => {
      const dot = h('span', {class: 'dot'}); dot.style.background = color(g); dot.style.color = color(g);
      return h('li', null, h('button', {type: 'button', 'aria-pressed': String(!hidden.has(g)), onclick: () => {
        if (hidden.has(g)) hidden.delete(g);
        else if (!hidden.size) { for (const x of groups) if (x !== g) hidden.add(x); } // first tap isolates one domain
        else hidden.add(g);
        if (hidden.size >= groups.length) hidden.clear();
        renderLegend(); view?.refresh();
      }}, dot, h('span', {class: 'name', text: g}), h('span', {class: 'n', text: counts.get(g)})));
    };
    fill(legend,
      h('h3', null, h('span', {text: `${total} stars`}), h('span', null, anyFilter ? h('button', {type: 'button', text: 'All', onclick: () => { hidden.clear(); hiddenLines.clear(); setMode({kind: 'all'}); }}) : null, ' ', toggle)),
      h('div', {class: 'modes'}, modeChip('tensions', 'Stars in tension', tensionIds.size), modeChip('new', 'New', newIds.size),
        newIds.size ? h('button', {class: 'chip mode', type: 'button', text: 'Mark seen', onclick: () => { markSeen(); newIds = new Set(); setMode(mode.kind === 'new' ? {kind: 'all'} : mode); }}) : null),
      focusNode ? h('div', {class: 'focus-row'}, h('span', {class: 'faint', text: 'Focus: '}), h('span', {text: String(focusNode.label || focusNode.id).slice(0, 40)}),
        h('button', {class: 'x', type: 'button', 'aria-label': 'Clear focus', text: '×', onclick: () => setMode({kind: 'all'})})) : null,
      h('ul', null, groups.filter(g => g !== PEOPLE).map(groupRow)),
      counts.get(PEOPLE) ? h('ul', {class: 'legend-people'}, groupRow(PEOPLE)) : null,
      lineTypes.length ? h('h4', {text: 'Lines'}) : null,
      lineTypes.length ? h('ul', {class: 'lines'}, lineTypes.map(([t, n]) => {
        const sw = h('span', {class: 'swatch'}); sw.style.background = LINK_COLORS[t] || LINK_COLORS.related;
        return h('li', null, h('button', {type: 'button', 'aria-pressed': String(!hiddenLines.has(t)), onclick: () => {
          if (hiddenLines.has(t)) hiddenLines.delete(t); else hiddenLines.add(t);
          renderLegend(); view?.refresh();
        }}, sw, h('span', {class: 'name', text: linkLabel(t)}), h('span', {class: 'n', text: n})));
      })) : null);
  }

  // --- sheet
  function closeSheet() {
    sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true');
    selected = null; view?.refresh(); view?.resume();
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet(); });

  async function openNode(id, {fly = true} = {}) {
    const node = byId.get(id);
    if (!node) return;
    selected = id;
    view?.refresh();
    if (fly) view?.focus(node);
    view?.pause();
    const dot = h('span', {class: 'q-group-dot'}); dot.style.background = color(groupOf(node));
    sheet.replaceChildren(h('div', {class: 'grab'}), closeButton(), h('div', {class: 'kind'}, dot, h('span', {text: groupOf(node)})),
      h('p', {class: 'statement', text: node.label || node.id}), MM.loading());
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
    let detail;
    try { detail = await api('/api/node/' + encodeURIComponent(id)); }
    catch (e) { if (selected === id) sheet.querySelector('.loading')?.replaceWith(MM.errorState(e.message, () => openNode(id, {fly: false}))); return; }
    if (selected !== id) return;
    renderDetail(node, detail, dot);
  }
  function closeButton() { return h('button', {class: 'btn ghost small close', type: 'button', 'aria-label': 'Close', text: 'Close', onclick: closeSheet}); }

  function ask(node, d) {
    const text = d.kind === 'position'
      ? `About my atlas position "${d.statement}" (${node.id}): why do you think this, and what would change it?`
      : `About ${d.name || node.label} in my atlas (${node.id}): `;
    try { sessionStorage.setItem('mm-chat-draft', text); } catch {}
    location.href = '/chat';
  }

  function notesBlock(node, d) {
    const kind = d.kind === 'position' ? 'positions' : 'people';
    const list = h('ul', {class: 'plain notes'});
    const render = notes => fill(list, (notes || []).map(n => h('li', null, h('span', {class: 'faint', text: [fmtDate(n.date), n.by === 'owner' ? 'you' : n.by].filter(Boolean).join(', ') + ': '}), n.text)));
    render(d.notes);
    const area = h('textarea', {rows: 2, maxlength: 2000, placeholder: 'Add a note', 'aria-label': 'Note'});
    const save = h('button', {class: 'btn small', type: 'button', text: 'Save note'});
    save.addEventListener('click', async () => {
      const text = area.value.trim();
      if (!text) { area.focus(); return; }
      busy(save, true, 'Saving');
      try {
        const r = await api(`/api/${kind}/${encodeURIComponent(node.id)}/note`, {method: 'POST', body: {text}});
        d.notes = r.notes; render(r.notes); area.value = ''; toast('Note saved.');
      } catch (e) { toast(e.message, {error: true}); }
      busy(save, false);
    });
    return [h('h4', {text: `Notes${d.notes?.length ? ` (${d.notes.length})` : ''}`}), list, h('div', {class: 'note-form'}, area, save)];
  }

  function linksBlock(node) {
    const links = [...neighbours(node.id)].map(id => byId.get(id)).filter(Boolean);
    if (!links.length) return [];
    const typeOf = other => {
      const l = data.links.find(x => (idOf(x.source) === node.id && idOf(x.target) === other.id) || (idOf(x.target) === node.id && idOf(x.source) === other.id));
      return l?.type || 'related';
    };
    const groups = new Map();
    for (const other of links.slice(0, 60)) { const t = typeOf(other); if (!groups.has(t)) groups.set(t, []); groups.get(t).push(other); }
    const order = [...groups.keys()].sort((a, b) => (a === 'tension' ? -1 : 0) - (b === 'tension' ? -1 : 0) || groups.get(b).length - groups.get(a).length);
    const swatch = type => { const s = h('span', {class: 'swatch'}); s.style.background = LINK_COLORS[type] || LINK_COLORS.related; return s; };
    return [h('h4', {text: `Links (${links.length})`}), ...order.map(type => h('div', {class: 'link-group'},
      h('div', {class: 'link-type'}, swatch(type), h('span', {text: `${linkLabel(type)} (${groups.get(type).length})`})),
      h('div', {class: 'chips'}, groups.get(type).map(other => {
        const dot2 = h('span', {class: 'dot'}); dot2.style.background = color(groupOf(other));
        const label = String(other.label || other.id);
        return h('button', {class: `chip link ${type}`, type: 'button', title: label, onclick: () => openNode(other.id)},
          dot2, h('span', {text: label.length > 48 ? label.slice(0, 47) + '…' : label}));
      }))))];
  }

  function renderDetail(node, d, dot) {
    const parts = [h('div', {class: 'grab'}), closeButton()];
    const focusBtn = h('button', {class: 'btn small', type: 'button', 'aria-pressed': String(mode.kind === 'focus' && mode.id === node.id), text: 'Focus',
      onclick: () => { setMode(mode.kind === 'focus' && mode.id === node.id ? {kind: 'all'} : {kind: 'focus', id: node.id}); focusBtn.setAttribute('aria-pressed', String(mode.kind === 'focus')); }});
    const askBtn = h('button', {class: 'btn small', type: 'button', text: 'Ask', title: 'Open the chat with this star', onclick: () => ask(node, d)});
    if (d.kind === 'position') {
      parts.push(h('div', {class: 'kind'}, dot, h('span', {text: d.domain}), isNew(node) ? h('span', {class: 'badge new', text: 'new'}) : null));
      parts.push(h('p', {class: 'statement', text: d.statement}));
      parts.push(h('div', {class: 'p-meta'}, MM.badge(d.status, statusLabel(d.status)), confidence(d.confidence),
        d.since ? h('span', {text: `since ${fmtDate(d.since)}`}) : null, d.last_confirmed ? h('span', {text: `confirmed ${fmtDate(d.last_confirmed)}`}) : null));
      const actions = h('div', {class: 'btn-row'});
      const rejectForm = h('div', {class: 'reject-form', hidden: true});
      if (d.status !== 'active') actions.append(h('button', {class: 'btn good', type: 'button', text: 'Confirm', onclick: e => act(e.currentTarget, node, 'confirm')}));
      actions.append(h('button', {class: 'btn bad', type: 'button', text: 'Reject', onclick: () => {
        if (!rejectForm.hidden) { rejectForm.hidden = true; return; }
        const area = h('textarea', {rows: 2, maxlength: 600, placeholder: 'Why? Optional. One line is enough.', 'aria-label': 'Reason'});
        const go = h('button', {class: 'btn small bad', type: 'button', text: 'Reject', onclick: e => act(e.currentTarget, node, 'reject', {reason: area.value.trim()})});
        const cancel = h('button', {class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: () => { rejectForm.hidden = true; }});
        fill(rejectForm, area, h('div', {class: 'btn-row'}, go, cancel)); rejectForm.hidden = false; area.focus();
      }}), focusBtn, askBtn);
      parts.push(actions, rejectForm);
      if (d.sources?.length) {
        parts.push(h('h4', {text: `Sources (${d.sources.length})`}));
        parts.push(h('ul', {class: 'plain sources'}, d.sources.map(s => h('li', null,
          s.quote ? h('q', {text: s.quote}) : null, s.quote ? ' ' : null, h('span', {class: 'faint', text: [s.file, fmtDate(s.date)].filter(Boolean).join(', ')})))));
      }
    } else {
      parts.push(h('div', {class: 'kind'}, dot, h('span', {text: [d.kind, d.relationship].filter(Boolean).join(', ')}), isNew(node) ? h('span', {class: 'badge new', text: 'new'}) : null));
      parts.push(h('p', {class: 'statement', text: d.name || node.label}));
      if (d.role) parts.push(h('p', {class: 'muted', text: d.role}));
      if (d.context) parts.push(h('p', {class: 'context', text: d.context}));
      parts.push(h('div', {class: 'btn-row'}, focusBtn, askBtn));
    }
    parts.push(...linksBlock(node));
    parts.push(...notesBlock(node, d));
    if (d.body) parts.push(h('details', null, h('summary', {text: d.kind === 'position' ? 'Reasoning' : 'More'}), h('p', {class: 'body', text: d.body})));
    sheet.replaceChildren(...parts);
  }

  async function act(button, node, action, body = {}) {
    busy(button, true, action === 'confirm' ? 'Confirming' : 'Rejecting');
    try {
      const r = await api(`/api/positions/${encodeURIComponent(node.id)}/${action}`, {method: 'POST', body});
      if (action === 'reject') {
        toast(body.reason ? 'Rejected, reason kept.' : 'Rejected. Removed from the atlas.');
        removeNode(node.id); closeSheet();
      } else {
        Object.assign(node, {status: r.position.status, confidence: r.position.confidence});
        toast('Confirmed.');
        openNode(node.id, {fly: false});
      }
      refreshStats();
    } catch (e) { toast(e.message, {error: true}); busy(button, false); }
  }
  function removeNode(id) {
    data.nodes = data.nodes.filter(n => n.id !== id);
    data.links = data.links.filter(l => idOf(l.source) !== id && idOf(l.target) !== id);
    newIds.delete(id);
    if (mode.kind === 'focus' && mode.id === id) mode = {kind: 'all'};
    index(); view?.remove(id); renderLegend();
  }

  // --- 3D view
  function webglOk() {
    try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); }
    catch { return false; }
  }

  function make3d() {
    if (typeof window.ForceGraph3D !== 'function' || !webglOk()) throw new Error('no webgl');
    const small = window.innerWidth < 760;
    const G = new window.ForceGraph3D(graphEl, {controlType: 'orbit', rendererConfig: {antialias: !small, alpha: true, powerPreference: 'high-performance'}});
    const canvas = G.renderer().domElement;
    if (reduced.matches) canvas.style.visibility = 'hidden';
    G.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.75 : 2));
    G.backgroundColor(theme.getPropertyValue('--bg').trim()).showNavInfo(false)
      .width(graphEl.clientWidth).height(graphEl.clientHeight)
      .nodeId('id').nodeVal(nodeVal).nodeColor(nodeColor).nodeOpacity(0.95).nodeResolution(6).nodeRelSize(4)
      .nodeVisibility(n => visible(n)).nodeLabel(small ? null : n => escapeText((n.label || n.id) + (isNew(n) ? ' (new)' : '')))
      .linkVisibility(linkVisible())
      .linkColor(linkColor).linkOpacity(light ? 0.9 : 0.7).linkWidth(l => (l.type === 'tension' ? 0.6 : WIDE.has(l.type) ? 0.4 : 0.25))
      .enableNodeDrag(false).warmupTicks(reduced.matches ? 230 : 90).cooldownTicks(reduced.matches ? 0 : 140)
      .onNodeClick(n => openNode(n.id))
      .onBackgroundClick(() => { if (sheet.classList.contains('open')) closeSheet(); });
    G.d3Force('charge').strength(-38);
    G.d3Force('link').distance(l => (l.type === 'tension' ? 70 : 42));
    G.graphData(data);
    const controls = G.controls();
    controls.autoRotate = !reduced.matches; controls.autoRotateSpeed = 0.55; controls.enableDamping = !reduced.matches; controls.dampingFactor = 0.12;
    let resumeTimer = null, paused = false;
    reduced.addEventListener('change', () => {
      clearTimeout(resumeTimer); clearTimeout(fitTimer);
      controls.autoRotate = !reduced.matches && !paused; controls.enableDamping = !reduced.matches;
      G.cooldownTicks(reduced.matches ? 0 : 140);
      if (reduced.matches) {
        // End any camera tween and flush orbit inertia before the next settled frame.
        const {x, y, z, lookAt} = G.cameraPosition();
        G.cameraPosition({x, y, z}, lookAt, 0); controls.update();
      }
    });
    controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(resumeTimer); });
    controls.addEventListener('end', () => { clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { if (!paused && !reduced.matches) controls.autoRotate = true; }, 7000); });
    // Reduced motion warms up offscreen and fits once when the engine stops.
    const fitTimer = reduced.matches ? null : setTimeout(() => G.zoomToFit(600, small ? 16 : 60), 300);
    let fitted = false;
    G.onEngineStop(() => {
      if (fitted || selected) return;
      fitted = true;
      // The first render updates node matrices used by zoomToFit's bounds.
      requestAnimationFrame(() => {
        G.scene().updateMatrixWorld(true);
        G.zoomToFit(reduced.matches ? 0 : 900, small ? 16 : 60);
        canvas.style.visibility = '';
      });
    });
    window.addEventListener('resize', () => G.width(graphEl.clientWidth).height(graphEl.clientHeight));
    document.addEventListener('visibilitychange', () => (document.hidden ? G.pauseAnimation() : G.resumeAnimation()));
    return {
      kind: '3d',
      refresh() { G.nodeColor(n => nodeColor(n)).nodeVal(nodeVal).nodeVisibility(n => visible(n)).linkVisibility(linkVisible()); },
      focus(n) {
        if (n.x === undefined) return;
        const dist = 150, r = Math.hypot(n.x, n.y, n.z) || 1, k = 1 + dist / r;
        G.cameraPosition({x: n.x * k, y: n.y * k, z: n.z * k}, {x: n.x, y: n.y, z: n.z}, reduced.matches ? 0 : 900);
      },
      remove() { G.graphData(data); },
      pause() { paused = true; controls.autoRotate = false; clearTimeout(resumeTimer); },
      resume() { paused = false; clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { if (!paused && !reduced.matches) controls.autoRotate = true; }, 4000); },
    };
  }
  function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // --- 2D fallback: own canvas renderer, layout computed once, slow spin, pan and pinch zoom
  function make2d() {
    const canvas = h('canvas', {'aria-label': 'Atlas map'});
    graphEl.replaceChildren(canvas);
    const ctx = canvas.getContext('2d');
    const nodes = data.nodes;
    const pos = new Map();
    const R = Math.sqrt(nodes.length) * 30 + 60;
    nodes.forEach((n, i) => { const a = i * 2.399963, r = R * Math.sqrt((i + 0.5) / nodes.length); pos.set(n.id, {x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0}); });
    function layout(iterations) {
      const list = nodes.map(n => pos.get(n.id));
      for (let it = 0; it < iterations; it++) {
        const alpha = 1 - it / iterations;
        for (let i = 0; i < list.length; i++) {
          const a = list[i];
          for (let j = i + 1; j < list.length; j++) {
            const b = list[j]; let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy + 0.01;
            if (d2 > 90000) continue;
            const f = 900 / d2; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
          }
        }
        for (const l of data.links) {
          const a = pos.get(idOf(l.source)), b = pos.get(idOf(l.target)); if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 50) * 0.02;
          a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
        }
        for (const p of list) { p.vx -= p.x * 0.004; p.vy -= p.y * 0.004; p.x += p.vx * alpha; p.y += p.vy * alpha; p.vx *= 0.6; p.vy *= 0.6; }
      }
    }
    layout(nodes.length > 400 ? 120 : 220);
    let scale = 1, ox = 0, oy = 0, angle = 0, spinning = true, paused = false, dpr = Math.min(window.devicePixelRatio || 1, 2);
    function fit() {
      const w = graphEl.clientWidth, hgt = graphEl.clientHeight;
      canvas.width = w * dpr; canvas.height = hgt * dpr; canvas.style.width = w + 'px'; canvas.style.height = hgt + 'px';
      let max = 1; for (const p of pos.values()) max = Math.max(max, Math.abs(p.x), Math.abs(p.y));
      scale = Math.min(w, hgt) / (2 * max + 80);
    }
    fit();
    window.addEventListener('resize', () => { fit(); repaint(); });
    const screen = p => {
      const c = Math.cos(angle), s = Math.sin(angle);
      return {x: (p.x * c - p.y * s) * scale + ox + canvas.width / dpr / 2, y: (p.x * s + p.y * c) * scale + oy + canvas.height / dpr / 2};
    };
    const radius = n => Math.max(2.2, Math.cbrt(nodeVal(n)) * 4 * Math.sqrt(scale));
    const linkShown = linkVisible();
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const l of data.links) {
        if (!linkShown(l)) continue;
        const a = byId.get(idOf(l.source)), b = byId.get(idOf(l.target));
        const p = screen(pos.get(a.id)), q = screen(pos.get(b.id));
        ctx.lineWidth = l.type === 'tension' ? 1.6 : WIDE.has(l.type) ? 1.2 : 1;
        ctx.strokeStyle = linkColor(l); ctx.globalAlpha = selected && selected !== a.id && selected !== b.id ? 0.15 : 0.9;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
      for (const n of nodes) {
        if (!visible(n) || !pos.has(n.id)) continue;
        const p = screen(pos.get(n.id)), r = radius(n);
        ctx.fillStyle = nodeColor(n);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        if (isNew(n)) { ctx.strokeStyle = accent; ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke(); }
        if (n.id === selected) { ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }
      }
    }
    let raf = null;
    function loop() {
      raf = null;
      if (spinning && !paused && !document.hidden && !reduced.matches) angle += 0.0009;
      draw();
      if (!reduced.matches && spinning && !paused && !document.hidden) raf = requestAnimationFrame(loop);
    }
    function repaint() { if (raf === null) raf = requestAnimationFrame(loop); }
    reduced.addEventListener('change', () => { cancelAnimationFrame(raf); raf = null; repaint(); });
    document.addEventListener('visibilitychange', repaint);
    loop();
    // pointer: one finger pans, two fingers pinch, a short tap selects
    const pointers = new Map(); let start = null, pinch = null, moved = false;
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); start = {x: e.clientX, y: e.clientY, ox, oy}; moved = false; spinning = false; });
    canvas.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!pinch) pinch = {d, scale}; else scale = Math.max(0.05, Math.min(20, pinch.scale * d / pinch.d));
        moved = true;
      } else if (start) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (moved) { ox = start.ox + dx; oy = start.oy + dy; }
      }
      repaint();
    });
    const up = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        if (!moved) {
          const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
          let best = null, bestD = 22 * 22;
          for (const n of nodes) {
            if (!visible(n) || !pos.has(n.id)) continue;
            const p = screen(pos.get(n.id)), d = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d < bestD) { bestD = d; best = n; }
          }
          if (best) openNode(best.id); else if (sheet.classList.contains('open')) closeSheet();
        }
        start = null;
        setTimeout(() => { if (!pointers.size && !paused) { spinning = true; repaint(); } }, 6000);
      }
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { e.preventDefault(); scale = Math.max(0.05, Math.min(20, scale * Math.exp(-e.deltaY * 0.0015))); repaint(); }, {passive: false});
    return {
      kind: '2d',
      refresh: repaint,
      focus(n) { const p = pos.get(n.id); if (!p) return; const c = Math.cos(angle), s = Math.sin(angle); ox = -(p.x * c - p.y * s) * scale; oy = -(p.x * s + p.y * c) * scale + graphEl.clientHeight * 0.18; repaint(); },
      remove(id) { pos.delete(id); repaint(); },
      pause() { paused = true; spinning = false; repaint(); },
      resume() { paused = false; spinning = true; repaint(); },
      stop() { cancelAnimationFrame(raf); },
    };
  }

  function start(viewMode) {
    try { view = viewMode === '2d' ? make2d() : make3d(); }
    catch { view = make2d(); }
    const other = view.kind === '3d' ? '2d' : '3d';
    const selectHint = matchMedia('(pointer: fine)').matches ? 'Click a star' : 'Tap a star';
    fill(note, h('span', {text: view.kind === '3d' ? selectHint : `2D view. ${selectHint}`}), h('br'),
      webglOk() ? h('a', {href: '#', class: 'small', text: `Switch to ${other.toUpperCase()}`, onclick: e => { e.preventDefault(); store.set('mm-atlas-view', other); location.reload(); }}) : null);
    note.style.pointerEvents = 'auto';
  }

  async function load3d() {
    if (typeof window.ForceGraph3D === 'function' || !webglOk()) return;
    const bundle = document.querySelector('[data-graph-bundle]');
    if (!bundle) return;
    // Two frames let the shell paint before the large bundle is evaluated.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => {
      const script = document.createElement('script');
      script.nonce = bundle.nonce;
      script.src = bundle.src;
      script.onload = script.onerror = resolve;
      document.head.append(script);
    });
  }

  (async () => {
    try {
      const g = await api('/api/graph');
      domains = g.domains || [];
      data = {nodes: g.nodes || [], links: (g.links || []).map(l => ({...l}))};
      index();
      computeNew();
      renderLegend();
      if (!data.nodes.length) { wrap.append(h('div', {class: 'atlas-empty'}, MM.empty('The atlas is empty. Add a dump to file positions and people.'))); return; }
      const preferred = store.get('mm-atlas-view') === '2d' ? '2d' : '3d';
      if (preferred === '3d') await load3d();
      start(preferred);
      if (newIds.size) toast(`${newIds.size} new since your last visit.`);
    } catch (e) {
      wrap.append(h('div', {class: 'atlas-empty'}, MM.errorState(e.message || 'Could not load the atlas.', () => location.reload())));
    } finally { pending.remove(); }
  })();
})();
