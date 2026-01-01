// Thin YouTube Data API v3 client. One call = one ledger reservation, made before the request goes out.
// The key is in the request URL only (that is how the API takes it) and the URL is never printed or put
// in an error. Replies are classified into the codes in errors.js.
import {YouTubeError, classifyResponse, networkError} from './errors.js';
import {SEARCH_COST} from './quota.js';

const API = 'https://www.googleapis.com/youtube/v3/';
const WHAT = {videos: 'Video', commentThreads: 'Video', channels: 'Channel', playlistItems: 'Channel uploads', search: 'Search'};

export function createClient({key, ledger, fetch: fetchFn = globalThis.fetch, timeoutMs = 20_000}) {
  return {
    // endpoint: videos | commentThreads | channels | playlistItems | search
    async call(endpoint, params = {}) {
      if (!key) throw new YouTubeError('key_missing', 'YOUTUBE_API_KEY is not set. Tell Owner the key file /etc/mastan-me/youtube.env is missing or empty.');
      ledger.reserve(endpoint === 'search' ? SEARCH_COST : 1);
      const url = new URL(API + endpoint);
      for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
      url.searchParams.set('key', key);
      let res;
      try { res = await fetchFn(url.toString(), {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(timeoutMs)}); }
      catch (e) { throw networkError(e); }
      let body = null;
      try { body = await res.json(); } catch {}
      if (!res.ok) throw classifyResponse(res.status, body, WHAT[endpoint] || 'Resource');
      if (!body || typeof body !== 'object') throw new YouTubeError('api_error', 'The YouTube API sent a reply that could not be read.');
      return body;
    },
  };
}
