/* Apply the browser preference before any stylesheet can paint. */
(() => {
  let theme = 'dark';
  try { if (localStorage.getItem('mm-theme') === 'light') theme = 'light'; } catch {}
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.dataset.darkThemeColor = meta.content;
    if (theme === 'light') meta.content = '#eef0ec';
  }
})();
