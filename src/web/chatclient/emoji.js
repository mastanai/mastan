import {h, menuAt, storage} from './ui.js';
import {t} from './strings.js';
export async function picker({button, area, onInput}) {
  const start = area.selectionStart, end = area.selectionEnd, r = button.getBoundingClientRect();
  const {categories} = await import('./emoji-data.js'), all = categories.flatMap(group => group.emoji);
  const saved = storage.get('emoji-recent', []), recent = Array.isArray(saved) ? [...new Set(saved)].slice(0, 24) : [];
  const search = h('input', {type: 'search', placeholder: t('emojiSearch'), 'aria-label': t('emojiSearch'), autocomplete: 'off'});
  const results = h('div', {class: 'emoji-results'});
  const choose = ([value]) => {
    storage.set('emoji-recent', [value, ...recent.filter(item => item !== value)].slice(0, 24));
    close(); area.focus({preventScroll: true}); area.setRangeText(value, start, end, 'end'); onInput();
  };
  const render = () => {
    const query = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const groups = query.length ? categories : [{name: t('emojiRecent'), emoji: recent.map(value => all.find(item => item[0] === value)).filter(Boolean)}, ...categories];
    results.replaceChildren(...groups.flatMap(group => {
      const matches = group.emoji.filter(([value, name]) => query.every(word => (value + ' ' + name).toLowerCase().includes(word)));
      return matches.length ? [h('section', {'aria-label': group.name}, h('h3', {text: group.name}), h('div', {class: 'emoji-grid'}, matches.map(item => h('button', {type: 'button', text: item[0], title: item[1], 'aria-label': item[1], onclick: () => choose(item)}))))] : [];
    }));
    if (!results.children.length) results.append(h('p', {class: 'emoji-empty', text: t('emojiEmpty')}));
    results.scrollTop = 0;
  };
  search.oninput = render; render();
  const close = menuAt(r.left, r.top - 380, [], {className: 'emoji-picker', role: 'dialog', label: t('emoji'), content: [search, results]});
  results.onkeydown = event => {
    const columns = 6, steps = {ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns}, step = steps[event.key];
    if (!step) return;
    const buttons = [...results.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault(); buttons[(index + step + buttons.length) % buttons.length].focus();
  };
}
