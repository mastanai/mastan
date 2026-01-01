// What each command needs from the API, as plain data. No printing here.
import {YouTubeError} from './errors.js';

export const COMMENTS_DEFAULT = 300;
export const COMMENTS_HARD_MAX = 2000;
export const LIST_DEFAULT = 10;
export const LIST_HARD_MAX = 50;
export const REPLIES_PER_THREAD = 5;
const MAX_PAGES = 30;

const num = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// "&#39;" and friends: search.list returns titles HTML-escaped.
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return m; }
  });
}

// PT1H2M3S -> 1:02:03
export function formatDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
  if (!m) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map(x => Number(x) || 0);
  const hours = d * 24 + h;
  const pad = n => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

export async function getVideo(client, id) {
  const body = await client.call('videos', {part: 'snippet,contentDetails,statistics', id});
  const v = body.items?.[0];
  if (!v) throw new YouTubeError('not_found', 'Video not found (wrong id, private or deleted).');
  const st = v.statistics || {};
  return {
    id: v.id || id,
    title: v.snippet?.title ?? '',
    channel: v.snippet?.channelTitle ?? '',
    channel_id: v.snippet?.channelId ?? '',
    published: v.snippet?.publishedAt ?? '',
    duration: formatDuration(v.contentDetails?.duration),
    views: num(st.viewCount),
    likes: num(st.likeCount),
    comments: num(st.commentCount),
    description: String(v.snippet?.description ?? ''),
  };
}

const commentOf = s => ({
  author: s?.authorDisplayName ?? '',
  text: s?.textDisplay ?? s?.textOriginal ?? '',
  likes: num(s?.likeCount) ?? 0,
  published: s?.publishedAt ?? '',
});

// Pages through commentThreads (100 per page) until `max` top-level comments or the last page.
// Returns {comments, pages, stopped: 'max' | 'last_page' | 'error', error?}. A failure after the first
// page keeps what was fetched; a failure on the first page is thrown.
export async function fetchComments(client, {videoId, max, order = 'relevance', replies = false}) {
  const comments = [];
  const seen = new Set();
  let pageToken;
  let pages = 0;
  while (pages < MAX_PAGES) {
    let body;
    try {
      body = await client.call('commentThreads', {part: replies ? 'snippet,replies' : 'snippet', videoId, maxResults: 100, order, textFormat: 'plainText', pageToken});
    } catch (error) {
      if (!pages) throw error;
      return {comments, pages, stopped: 'error', error};
    }
    pages++;
    let dropped = false;
    for (const item of Array.isArray(body.items) ? body.items : []) {
      if (comments.length >= max) { dropped = true; break; }
      const c = {id: item.id ?? '', ...commentOf(item.snippet?.topLevelComment?.snippet), reply_count: num(item.snippet?.totalReplyCount) ?? 0};
      if (replies) c.replies = (item.replies?.comments ?? []).slice(0, REPLIES_PER_THREAD).map(r => commentOf(r.snippet));
      comments.push(c);
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (comments.length >= max) return {comments, pages, stopped: dropped || pageToken ? 'max' : 'last_page'};
    if (!pageToken || seen.has(pageToken) || !body.items?.length) return {comments, pages, stopped: 'last_page'};
    seen.add(pageToken);
  }
  return {comments, pages, stopped: 'last_page'};
}

export async function getChannelUploads(client, ref, max = LIST_DEFAULT) {
  const body = await client.call('channels', {part: 'snippet,contentDetails', ...(ref.type === 'id' ? {id: ref.value} : {forHandle: ref.value})});
  const ch = body.items?.[0];
  if (!ch) throw new YouTubeError('not_found', 'Channel not found (wrong handle or id).');
  const playlistId = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new YouTubeError('not_found', 'This channel has no uploads playlist.');
  const list = await client.call('playlistItems', {part: 'snippet,contentDetails', playlistId, maxResults: max});
  const videos = (list.items ?? [])
    .filter(i => !['Private video', 'Deleted video'].includes(i.snippet?.title))
    .map(i => ({
      id: i.contentDetails?.videoId ?? i.snippet?.resourceId?.videoId ?? '',
      title: i.snippet?.title ?? '',
      published: i.contentDetails?.videoPublishedAt ?? i.snippet?.publishedAt ?? '',
    }));
  return {channel: {id: ch.id, title: ch.snippet?.title ?? '', handle: ch.snippet?.customUrl ?? ''}, videos};
}

export async function searchVideos(client, query, max = LIST_DEFAULT) {
  const body = await client.call('search', {part: 'snippet', type: 'video', q: query, maxResults: max, order: 'relevance'});
  return (body.items ?? []).map(i => ({
    id: i.id?.videoId ?? '',
    title: decodeEntities(i.snippet?.title),
    channel: decodeEntities(i.snippet?.channelTitle),
    published: i.snippet?.publishedAt ?? '',
  })).filter(v => v.id);
}
