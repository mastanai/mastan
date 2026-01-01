// Turn what Owner pastes into ids: video URLs and bare ids, channel @handles, URLs and UC ids.
import {badInput} from './errors.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^[\p{L}\p{N}_.\-]{1,100}$/u;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const short = s => (s.length > 80 ? s.slice(0, 80) + '...' : s);

function toUrl(input) {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : /^[\w.-]+\.[a-z]{2,}\//i.test(raw) ? 'https://' + raw : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch { return null; }
}

export function parseVideoId(input) {
  const raw = String(input ?? '').trim();
  if (VIDEO_ID.test(raw)) return raw;
  const u = toUrl(raw);
  const host = u && u.hostname.toLowerCase();
  let id = null;
  if (u && host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (u && YT_HOSTS.has(host)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1];
  }
  if (!id || !VIDEO_ID.test(id)) throw badInput(`Not a YouTube video link or id: "${short(raw)}". Use a watch, youtu.be, shorts, live or embed link, or the 11 character id.`);
  return id;
}

// -> {type: 'id', value: 'UC...'} | {type: 'handle', value: '@name'}
export function parseChannelRef(input) {
  const raw = String(input ?? '').trim();
  const handle = h => HANDLE.test(h) ? {type: 'handle', value: '@' + h} : null;
  if (CHANNEL_ID.test(raw)) return {type: 'id', value: raw};
  if (raw.startsWith('@')) { const h = handle(raw.slice(1)); if (h) return h; }
  const u = toUrl(raw);
  if (u && YT_HOSTS.has(u.hostname.toLowerCase())) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0]?.startsWith('@')) {
      let name = parts[0].slice(1);
      try { name = decodeURIComponent(name); } catch {}
      const h = handle(name); if (h) return h;
    }
    if (parts[0] === 'channel' && CHANNEL_ID.test(parts[1] || '')) return {type: 'id', value: parts[1]};
    if (parts[0] === 'c' || parts[0] === 'user') throw badInput('Old style /c/ and /user/ channel links cannot be looked up. Use the @handle or the /channel/UC... link.');
  }
  throw badInput(`Not a YouTube channel: "${short(raw)}". Use @handle, a youtube.com/@handle or /channel/UC... link, or the UC channel id.`);
}
