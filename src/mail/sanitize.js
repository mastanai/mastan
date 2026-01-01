// Reconstruct a small HTML vocabulary. Never pass an input tag or attribute through.
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decode = s => String(s).replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n) => { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : +n; return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : ''; }).replace(/&(amp|quot|apos|lt|gt|colon|tab|newline);/gi, (_, n) => ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',colon:':',tab:'\t',newline:'\n'}[n.toLowerCase()]));
const text = s => escape(decode(s)).replace(/&amp;([a-zA-Z][a-zA-Z0-9]{1,31};)/g, '&$1');
const allowed = new Set('a p div span br hr b strong i em u s blockquote pre code ul ol li table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 img center font small sup sub'.split(' '));
const discard = new Set('script style iframe object embed form template svg math noscript textarea title xmp plaintext'.split(' '));
const voids = new Set(['br','hr','img','embed']);
const properties = /^(?:color|background|background-color|font|font-family|font-size|font-weight|font-style|letter-spacing|text-align|text-decoration|text-transform|line-height|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|border(?:-(?:top|right|bottom|left))?(?:-(?:color|width|style))?|border-radius|border-collapse|border-spacing|width|min-width|max-width|height|min-height|max-height|vertical-align|white-space|display|overflow|opacity|table-layout|word-break)$/;
const displays = /^(?:none|block|inline|inline-block|table|table-row|table-cell|list-item)$/;
function css(value) {
  // Newsletters hide preheaders with display:none or max-height:0 and lean on !important.
  return value.split(';').map(rule => rule.replace(/\s*!\s*important\s*$/i, '')).filter(rule => {
    const i = rule.indexOf(':'); if (i <= 0) return false;
    const name = rule.slice(0,i).trim().toLowerCase(), v = rule.slice(i+1).trim();
    return properties.test(name) && /^[#(),.%\w\s"'-]+$/.test(v) && !/url|expression|import|\\|behavior|image|element|var\(|attr\(/i.test(rule) && (name !== 'display' || displays.test(v.toLowerCase()));
  }).join(';').slice(0,2000);
}
const layout = {width: /^\d{1,4}%?$/, height: /^\d{1,4}%?$/, align: /^(?:left|right|center|justify)$/i, valign: /^(?:top|middle|bottom|baseline)$/i,
  bgcolor: /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i, cellpadding: /^\d{1,3}$/, cellspacing: /^\d{1,3}$/, border: /^\d{1,2}$/};
export function sanitizeHtml(input, {inlineUrl = () => '', remote = false} = {}) {
  let hiddenImages = false, suppressed = [], output = '', pos = 0;
  const source = String(input || '').slice(0, 2 * 1024 * 1024);
  const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of source.matchAll(tokens)) {
    if (!suppressed.length) output += text(source.slice(pos, match.index));
    pos = match.index + match[0].length;
    const raw = match[0], m = /^<(\/)?([a-zA-Z0-9:-]+)/.exec(raw);
    if (!m) continue;
    const tag = m[2].toLowerCase(), closing = !!m[1];
    if (suppressed.length) { if (closing && tag === suppressed.at(-1)) suppressed.pop(); else if (!closing && discard.has(tag) && !voids.has(tag)) suppressed.push(tag); continue; }
    if (discard.has(tag)) { if (!closing && !voids.has(tag)) suppressed.push(tag); continue; }
    if (!allowed.has(tag)) continue;
    if (closing) { if (!voids.has(tag)) output += `</${tag}>`; continue; }
    const attrs = {};
    for (const a of raw.slice(m[0].length, -1).matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = a[1].toLowerCase(); if (!(name in attrs)) attrs[name] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    }
    const safe = [];
    for (const k of ['title','alt','colspan','rowspan','dir']) if (attrs[k] && (k !== 'dir' || /^(ltr|rtl|auto)$/.test(attrs[k]))) safe.push(`${k}="${escape(attrs[k].slice(0,500))}"`);
    for (const [k, pattern] of Object.entries(layout)) if (attrs[k] && pattern.test(attrs[k].trim())) safe.push(`${k}="${escape(attrs[k].trim())}"`);
    const style = css(attrs.style || ''); if (style) safe.push(`style="${escape(style)}"`);
    if (tag === 'a') {
      const url = (attrs.href || '').trim();
      if (/^(https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i.test(url)) safe.push(`href="${escape(url)}" target="_blank" rel="noopener noreferrer"`);
    }
    if (tag === 'img') {
      let url = (attrs.src || '').trim();
      if (/^cid:/i.test(url)) url = inlineUrl(url.slice(4).replace(/^<|>$/g,''));
      else if (/^https?:\/\//i.test(url)) { hiddenImages = true; if (!remote) url = ''; }
      else if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(url)) url = '';
      if (url && !/[\u0000-\u001f]/.test(url)) safe.push(`src="${escape(url)}" referrerpolicy="no-referrer"`);
    }
    output += `<${tag}${safe.length ? ' ' + safe.join(' ') : ''}>`;
  }
  if (!suppressed.length) output += text(source.slice(pos));
  return {html: output, hiddenImages};
}
export function htmlDocument(html) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:light}body{background:#f6f7f4;color:#1d2823;font:15px/1.5 system-ui;margin:16px;overflow-wrap:anywhere}img,table{max-width:100%}img{height:auto}pre{white-space:pre-wrap}a{color:#1f6a48}blockquote{margin:12px;border-left:2px solid #b6bfb6;padding-left:12px}</style></head><body>${html}</body></html>`;
}
