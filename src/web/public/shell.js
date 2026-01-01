/* Shared workspace controls. Scroll work only reads the event's scrollTop. */
(() => {
  'use strict';
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  document.querySelector('.skip[href="#main"]')?.addEventListener('click', event => {
    const target = document.querySelector('main');
    if (!target) return;
    event.preventDefault();
    target.tabIndex = -1;
    target.focus({preventScroll: true});
    target.scrollTop = 0;
  });
  const themeButton = bar.querySelector('.shell-theme');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    const changed = document.documentElement.dataset.theme !== next;
    document.documentElement.dataset.theme = next;
    const target = next === 'dark' ? 'light' : 'dark';
    themeButton.textContent = target;
    themeButton.setAttribute('aria-label', `Switch to ${target} mode`);
    if (themeMeta) themeMeta.content = next === 'light' ? '#eef0ec' : (themeMeta.dataset.darkThemeColor || '#0c0f0e');
    window.dispatchEvent(new Event('mastan-theme'));
    if (changed && document.body.dataset.page === 'atlas') location.reload();
  }
  applyTheme(document.documentElement.dataset.theme);
  themeButton.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('mm-theme', next); } catch {}
    applyTheme(next);
  });
  window.addEventListener('storage', event => {
    if (event.key !== 'mm-theme' && event.key !== null) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    applyTheme(event.newValue);
  });
  const sheet = bar.querySelector('.shell-sheet'), menu = bar.querySelector('.shell-menu');
  const scrim = bar.querySelector('.shell-scrim'), nav = [...bar.querySelectorAll('.nav a')];
  const narrow = matchMedia('(max-width:899px)'), reduced = matchMedia('(prefers-reduced-motion:reduce)');
  let previous, outside = [], open = false;
  function toggle(on) {
    open = on && narrow.matches;
    bar.classList.toggle('sheet-open', open);
    menu.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
    if (open) {
      previous = menu;
      sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Navigation');
      outside = [...document.body.children].filter(el => el !== bar).map(el => [el, el.inert]);
      for (const [el] of outside) el.inert = true;
      (sheet.querySelector('[aria-current]') || nav[0]).focus();
    } else {
      sheet.removeAttribute('role'); sheet.removeAttribute('aria-modal'); sheet.removeAttribute('aria-label');
      for (const [el, inert] of outside) el.inert = inert;
      outside = [];
      previous?.focus({preventScroll: true}); previous = null;
    }
  }
  menu.addEventListener('click', () => toggle(!open), {passive: true});
  scrim.addEventListener('click', () => toggle(false), {passive: true});
  bar.querySelector('.shell-close').addEventListener('click', () => toggle(false), {passive: true});
  narrow.addEventListener('change', () => { if (open) toggle(false); }, {passive: true});
  document.addEventListener('keydown', e => {
    if (open && e.key === 'Escape') { e.preventDefault(); toggle(false); return; }
    if (open && e.key === 'Tab') {
      const items = [...sheet.querySelectorAll('a[href], button:not(:disabled)')], i = items.indexOf(document.activeElement);
      e.preventDefault(); items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus'].indexOf(e.code);
    if (nav[index]) { e.preventDefault(); location.assign(nav[index].href); }
  });
  const mailBadge = bar.querySelector('.mail-unread');
  if (mailBadge && typeof fetch === 'function') {
    const unread = async () => {
      try {
        const response = await fetch('/api/mail/accounts', {credentials: 'same-origin'});
        if (!response.ok) return;
        const {accounts} = await response.json();
        const count = accounts.filter(a => a.alerts).reduce((n, a) => n + a.unread, 0);
        mailBadge.textContent = count ? ' ' + count : ''; mailBadge.hidden = !count;
      } catch {}
    };
    void unread(); setInterval(unread, 60_000); window.addEventListener('focus', unread);
  }
  const clock = bar.querySelector('.shell-clock');
  const format = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit'});
  function tick() { clock.textContent = format.format(new Date()); setTimeout(tick, 60000 - Date.now() % 60000); }
  tick();
  const line = bar.querySelector('.scanline'), positions = new WeakMap();
  let distance = 0, travel = 0, frame = 0, timer;
  new ResizeObserver(([entry]) => { travel = Math.max(0, entry.contentRect.width - 72); }).observe(bar);
  document.addEventListener('scroll', event => {
    if (reduced.matches) return;
    const top = event.target.scrollTop;
    if (!Number.isFinite(top)) return;
    distance += Math.abs(top - (positions.get(event.target) || 0)); positions.set(event.target, top);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      const phase = travel ? distance % (2 * travel) : 0;
      line.style.transform = `translateX(${phase > travel ? 2 * travel - phase : phase}px)`;
    });
    bar.classList.add('scrolling'); clearTimeout(timer);
    timer = setTimeout(() => bar.classList.remove('scrolling'), 400);
  }, {capture: true, passive: true});
  reduced.addEventListener('change', () => {
    clearTimeout(timer); cancelAnimationFrame(frame); frame = 0;
    bar.classList.remove('scrolling');
  });
  // The chat's jump button stays above whatever the composer area holds.
  const composer = document.getElementById('composer-wrap');
  if (composer) new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${composer.offsetHeight}px`)).observe(composer);
})();
