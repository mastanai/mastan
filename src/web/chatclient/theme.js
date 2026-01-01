import {storage} from './ui.js';

export function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
}
export function setTheme(value) {
  storage.set('theme', value);
  if (value === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value;
  dispatchEvent(new Event('mastan-theme'));
}
