// Server-rendered HTML shells. Page content is filled by the page script from /api/*.
// No inline handlers or inline styles; every <script> carries the per-request nonce.
import {readFileSync} from 'node:fs';

export const PAGES = {
  '/': {key: 'atlas', title: 'Atlas', script: 'atlas.js', vendor: true},
  '/chat': {key: 'chat', title: 'Chat', chat: true},
  '/questions': {key: 'questions', title: 'Questions', script: 'questions.js'},
  '/board': {key: 'board', title: 'Board', script: 'board.js'},
  '/positions': {key: 'positions', title: 'Positions', script: 'positions.js'},
  '/dump': {key: 'dump', title: 'Dump', script: 'dump.js'},
  '/settings': {key: 'settings', title: 'Settings', script: 'settings.js'},
  '/clients': {key: 'clients', title: 'Clients', script: 'clients.js'},
  '/requests': {key: 'requests', title: 'Requests', script: 'requests.js'},
  '/mail': {key: 'mail', title: 'Mail', script: 'mail.js', css: 'mail.css', module: true},
  '/fleet': {key: 'fleet', title: 'Fleet', script: 'fleet.js', passkey: true},
  '/stats': {key: 'stats', title: 'Stats', script: 'stats.js'},
  '/traffic': {key: 'traffic', title: 'Traffic', script: 'traffic.js'},
  '/people': {key: 'people', title: 'People', script: 'people.js'},
};
export const NAV = [['/chat', 'Chat'], ['/', 'Atlas'], ['/questions', 'Questions'], ['/board', 'Board'], ['/positions', 'Positions'], ['/dump', 'Dump'], ['/mail', 'Mail'], ['/clients', 'Clients'], ['/fleet', 'Fleet'], ['/stats', 'Stats'], ['/traffic', 'Traffic'], ['/people', 'People'], ['/requests', 'Requests'], ['/settings', 'Settings']];
export const OWNER_ONLY = new Set(['/mail', '/clients', '/requests', '/fleet', '/stats', '/traffic', '/people']);
export const VENDOR_GRAPH = 'vendor/3d-force-graph-1.80.1.min.js';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

// Keep the shared chat client intact and insert the same workspace header.
const CHAT_SHELL = readFileSync(new URL('./chatclient/index.html', import.meta.url), 'utf8');
export function renderChat({nonce, csrf, asset, path = '/chat', stats, operator}) {
  const values = {__NONCE__: nonce, __CSRF__: esc(csrf), __CSS__: asset('chat/app.css'), __APP__: asset('chat/app.js'), __WEBAUTHN__: asset('webauthn.js'), __ICON__: asset('icon-64.png'), __ICON180__: asset('icon-180.png'),
    __THEMEBOOT__: asset('theme-boot.js'), __SHELLCSS__: asset('shell.css'), __SHELLJS__: asset('shell.js'), __SKIN__: asset('chat/me-skin.css'), __SHELL__: renderHeader({path, stats, asset, operator})};
  return CHAT_SHELL.replace(/__[A-Z0-9]+__/g, name => values[name] ?? name)
    .replace('<body>', '<body id="main"><a class="skip" href="#main">Skip to content</a>');
}

function head({title, nonce, asset, csrf = '', css}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0c0f0e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
${csrf ? `<meta name="csrf-token" content="${esc(csrf)}">\n` : ''}<title>${esc(title)}</title>
<link rel="icon" href="${asset('icon-64.png')}" type="image/png">
<link rel="apple-touch-icon" href="${asset('icon-180.png')}">
<script nonce="${nonce}" src="${asset('theme-boot.js')}"></script>
<link rel="stylesheet" href="${asset('shell.css')}" nonce="${nonce}">
<link rel="stylesheet" href="${asset('app.css')}" nonce="${nonce}">
${css ? `<link rel="stylesheet" href="${asset(css)}">` : ''}
</head>`;
}

const STAT_CHIPS = [['open_questions', 'questions'], ['tensions', 'tensions'], ['positions', 'positions'], ['connections', 'links'], ['dumps', 'dumps']];

export function statChips(stats) {
  return STAT_CHIPS.map(([k, label]) => `<${k === 'open_questions' ? 'a href="/questions"' : 'span'} class="chip stat" data-label="${label}" data-stat="${k}"><b>${esc(stats?.[k] ?? 0)}</b><span class="sr-only"> ${k.replaceAll('_', ' ')}</span></${k === 'open_questions' ? 'a' : 'span'}>`).join('');
}

export function renderHeader({path, stats, asset, operator}) {
  const current = path.startsWith('/chat/') ? '/chat' : path;
  const nav = NAV.filter(([href]) => !operator || !OWNER_ONLY.has(href)).map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}${href === '/mail' ? '<span class="mail-unread" aria-label="Unread Inbox messages" hidden></span>' : ''}</a>`).join('');
  return `<header class="topbar">
  <div class="topbar-row">
    <a class="brand" href="/"><img src="${asset('mastan.png')}" alt="" width="22" height="21"><span>mastan</span></a>
    <span class="shell-current">${esc(PAGES[current]?.title || 'Chat')}</span>
    <a class="shell-question" href="/questions" data-stat="open_questions"><b>${esc(stats?.open_questions ?? 0)}</b> questions</a>
    <button class="shell-menu" type="button" aria-expanded="false" aria-controls="shell-sheet">Menu</button>
    <div class="shell-sheet" id="shell-sheet">
      <button class="shell-close" type="button" aria-label="Close navigation">Close</button>
      <nav class="nav" aria-label="Main">${nav}</nav>
      <div class="stats" id="stats">${statChips(stats)}</div>
      <button class="shell-theme" type="button" aria-label="Switch to light mode">light</button>
    </div>
    <time class="shell-clock" aria-label="Riyadh time">--:--</time>
  </div>
  <span class="scanline" aria-hidden="true"></span>
  <button class="shell-scrim" type="button" aria-label="Close navigation" tabindex="-1" hidden></button>
</header>
${operator ? '<p class="operator-banner">Operator session. Expires in 30 minutes. Models are read only.</p>\n' : ''}`;
}

export function renderShell({path, nonce, csrf, stats, asset, operator}) {
  const page = PAGES[path];
  const scripts = [asset('shell.js'), page.vendor ? asset(VENDOR_GRAPH) : null, page.passkey ? asset('webauthn.js') : null, asset('common.js'), ['clients','people'].includes(page.key) ? asset('people-data.js') : null, asset(page.script)].filter(Boolean)
    .map(src => `<script nonce="${nonce}" src="${src}"${page.module && src === asset(page.script) ? ' type="module"' : ''}${page.vendor && src === asset(VENDOR_GRAPH) ? ' type="application/x-mastan-graph" data-graph-bundle' : ''}></script>`).join('\n');
  return `${head({title: `${page.title} | Mastan Me`, nonce, asset, csrf, css: page.css})}
<body class="page-${page.key}" data-page="${page.key}"${operator ? ' data-operator="1"' : ''}>
<a class="skip" href="#main">Skip to content</a>
${renderHeader({path, stats, asset, operator})}<main id="main" class="main main-${page.key}" tabindex="-1"><p class="loading" role="status">loading...</p></main>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
${scripts}
</body>
</html>
`;
}

export function renderLogin({nonce, asset}) {
  return `${head({title: 'Mastan Me', nonce, asset})}
<body class="page-login">
<main class="login">
  <div class="login-card">
    <img class="login-mark" src="${asset('mastan.png')}" alt="" width="80" height="77">
    <h1 id="heading">Mastan Me</h1>
    <p id="intro" class="muted">This page is private.</p>
    <button id="passkey" class="btn primary big" type="button">Sign in with passkey</button>
    <p id="status" class="status" role="status" aria-live="polite"></p>
  </div>
</main>
<script nonce="${nonce}" src="${asset('webauthn.js')}"></script>
<script nonce="${nonce}" src="${asset('login.js')}"></script>
</body>
</html>
`;
}

export function renderNotFound({nonce, asset}) {
  return `${head({title: 'Not found | Mastan Me', nonce, asset})}
<body class="page-login"><main class="login"><div class="login-card not-found"><img class="login-mark" src="${asset('mastan.png')}" alt="" width="80" height="77"><h1>404</h1><p class="muted">This page has wandered off.</p><div class="btn-row"><a class="btn" href="/chat">Chat</a><a class="btn" href="/">Atlas</a></div></div></main></body>
</html>
`;
}
