import {h, api, modal, toast, storage, icon, dismissPrompts, promptsAllowed} from './ui.js';
import {t} from './strings.js';
let installPrompt;
const hints = new Set();
const offers = []; let activeOffer = null, offersDismissed = false;
addEventListener('mastan-prompts-dismissed', () => { offersDismissed = true; offers.length = 0; activeOffer?.remove(); activeOffer = null; });
addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
const installed = () => matchMedia('(display-mode:standalone)').matches || navigator.standalone;
export const installTitle = () => t(/iPhone|iPad|iPod|Android/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 ? 'installTitle' : 'installDesktop');
export async function installation(back) {
  storage.set('install-dismissed', true);
  if (installPrompt) { const prompt = installPrompt; installPrompt = null; await prompt.prompt(); await prompt.userChoice; return; }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const steps = ios ? [['↑', 'iosShare'], ['⊕', 'iosAdd'], ['▣', 'iosOpen']] : [['⋮', 'browserMenu'], ['⊕', 'browserInstall']];
  modal(installTitle(), h('div', {class: 'install-steps'}, installed() ? h('p', {text: t('installed')}) : steps.map(([symbol, key], i) => h('div', {class: 'install-step'}, h('span', {class: 'step-picture', 'aria-hidden': 'true', text: symbol}), h('p', {text: `${i + 1}. ${t(key)}`})))), {back});
}
function nextOffer() {
  if (offersDismissed || !promptsAllowed() || activeOffer || !offers.length) return;
  const offer = offers.shift(); if (storage.get(offer.key)) return nextOffer();
  storage.set(offer.key, 'offered');
  const finish = () => { row.remove(); activeOffer = null; nextOffer(); };
  const row = h('div', {class: 'device-hint'}, h('button', {class: 'hint-action', onclick: async () => { finish(); try { await offer.action(); } catch (e) { toast(e.message); } }}, h('span', {text: offer.text}), h('b', {text: offer.label})),
    h('button', {class: 'icon', 'aria-label': t('close'), onclick: () => { storage.set(offer.key, 'dismissed'); dismissPrompts(); finish(); }}, icon('close')));
  activeOffer = row; document.querySelector(offer.top ? '#notification-hint' : '#session-hints').append(row);
}
export function notificationHint(publicKey, work = false) {
  if (!globalThis.Notification || Notification.permission !== 'default' || storage.get('notification-offered') || offers.some(o => o.key === 'notification-offered')) return;
  offers.unshift({key: 'notification-offered', top: true, text: t(work ? 'workNotificationHint' : 'notificationHint'), label: t('enable'), action: () => notifications(publicKey)}); nextOffer();
}
export function accountHints(accountKey) {
  if (hints.has(accountKey)) return; hints.add(accountKey);
  if (!installed() && !storage.get('install-dismissed') && false) {
    offers.push({key: 'install-dismissed', text: installTitle(), label: t('install'), action: installation});
  }
  nextOffer();
}
export async function notifications(publicKey) {
  if (!('serviceWorker' in navigator) || !('PushManager' in globalThis) || !globalThis.Notification || !publicKey) return toast(t('pushUnavailable'));
  if (await Notification.requestPermission() !== 'granted') return;
  const registration = await navigator.serviceWorker.ready;
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4)), c => c.charCodeAt(0));
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: bytes});
  await api('/api/account/push', {method: 'POST', body: {subscription: subscription.toJSON()}}); toast(t('notificationsOn'));
}
