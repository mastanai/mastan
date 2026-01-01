import {h, icon} from './ui.js';
import {t} from './strings.js';
const copiedCode = new Map();
let highlighter;
const clipping = new ResizeObserver(entries => { for (const {target} of entries) { if (target.isConnected) updateClip(target); else clipping.unobserve(target); } });
function updateClip(node) {
  const left = getComputedStyle(node).direction === 'rtl' ? node.scrollWidth - node.clientWidth + node.scrollLeft : node.scrollLeft;
  node.classList.toggle('clipped-left', left > 1); node.classList.toggle('clipped-right', node.scrollWidth - node.clientWidth - left > 1);
}
function scrollEdges(node) { clipping.observe(node); node.addEventListener('scroll', () => updateClip(node), {passive: true}); return node; }
function copyButton(text) {
  const label = h('span', {text: t('copy')}), button = h('button', {class: 'code-copy'}, icon('copy'), label);
  const feedback = until => {
    if (until <= Date.now()) return;
    label.textContent = t('copied');
    setTimeout(() => { const next = copiedCode.get(text) || 0; if (next > Date.now()) return feedback(next); copiedCode.delete(text); label.textContent = t('copy'); }, Math.max(1, until - Date.now()));
  };
  feedback(copiedCode.get(text) || 0);
  button.onclick = () => { void navigator.clipboard.writeText(text).then(() => { const until = Date.now() + 2000; copiedCode.set(text, until); feedback(until); }).catch(() => {}); };
  return button;
}
// Text goes through DOM text nodes only. Raw HTML and non-HTTP links are never interpreted.
function inline(text) {
  const out = [], regex = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>()]+)|(\*[^*\n]+\*)/g;
  let match, last = 0;
  while ((match = regex.exec(text))) {
    out.push(text.slice(last, match.index));
    if (match[1]) out.push(h('code', {text: match[1].slice(1, -1)}));
    else if (match[2]) out.push(h('strong', {text: match[2].slice(2, -2)}));
    else if (match[3]) { const m = match[3].match(/^\[([^\]]+)\]\((.+)\)$/); out.push(h('a', {text: m[1], href: m[2], target: '_blank', rel: 'noopener noreferrer'})); }
    else if (match[4]) { const link = match[4].replace(/[.,;!?]+$/, ''); out.push(h('a', {text: link, href: link, target: '_blank', rel: 'noopener noreferrer'}), match[4].slice(link.length)); }
    else out.push(h('em', {text: match[5].slice(1, -1)}));
    last = match.index + match[0].length;
  }
  out.push(text.slice(last)); return out;
}
export function markdown(text, {streaming = false} = {}) {
  const frag = document.createDocumentFragment();
  const plain = part => {
    const lines = part.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; if (!line.trim()) continue;
      if (line.includes('|') && /^\s*\|?[ :|-]+\|[ :|-]*$/.test(lines[i + 1] || '')) {
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(v => v.trim());
        const columns = cells(line).length;
        const table = h('table', null, h('thead', null, h('tr', null, cells(line).map(v => h('th', null, inline(v)))))); const body = h('tbody'); i++;
        while (lines[i + 1]?.includes('|')) { body.append(h('tr', null, Array.from({length: columns}, (_, col) => h('td', null, inline(cells(lines[i + 1])[col] || ''))))); i++; }
        table.append(body); frag.append(scrollEdges(h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table'}, table))); continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { frag.append(h(heading[1].length <= 2 ? 'h2' : 'h3', null, inline(heading[2]))); continue; }
      const list = /^\s*(?:[-*•]|\d+[.)])\s+/.exec(line);
      if (list) {
        const ordered = /^\s*\d/.test(line), ul = h(ordered ? 'ol' : 'ul');
        do { ul.append(h('li', null, inline(lines[i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')))); i++; } while (/^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i] || ''));
        i--; frag.append(ul); continue;
      }
      if (line.startsWith('> ')) { frag.append(h('blockquote', null, inline(line.slice(2)))); continue; }
      const p = h('p', null, inline(line));
      while (lines[i + 1]?.trim() && !/^(?:[#>|]|[-*•] |\d+[.)] )/.test(lines[i + 1]) && !lines[i + 1].includes('|')) { p.append(h('br'), ...inline(lines[++i])); }
      frag.append(p);
    }
  };
  const source = String(text || ''), fences = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0, match;
  while ((match = fences.exec(source))) {
    plain(source.slice(last, match.index));
    const language = match[1].trim().slice(0, 32), codeText = match[2].trimEnd();
    const code = h('code', {text: codeText});
    frag.append(h('div', {class: 'code-wrap'}, h('div', {class: 'code-headbar'}, h('span', {class: 'code-language', text: language || t('code')}), copyButton(codeText)), scrollEdges(h('pre', {tabindex: '0', role: 'region', 'aria-label': t('code')}, code))));
    // Plain streamed text avoids half-token flashes; completed fences can be colored immediately.
    if (!streaming || match[0].endsWith('```')) {
      highlighter ||= import('./highlight.js');
      void highlighter.then(({highlight}) => { if (code.isConnected) highlight(code, codeText, language); }).catch(() => {});
    }
    last = fences.lastIndex;
  }
  plain(source.slice(last)); return frag;
}
