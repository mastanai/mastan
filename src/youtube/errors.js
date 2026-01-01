// Classified errors for mastan-me-youtube. The message is always local text written here: Google's own
// message, thrown transport errors and request URLs (which carry the key) never reach the output.
export const ERROR_CODES = ['key_missing', 'quota_cap', 'quota_exceeded', 'comments_disabled', 'not_found', 'bad_input', 'network', 'api_error'];

export class YouTubeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.code = ERROR_CODES.includes(code) ? code : 'api_error';
    Object.assign(this, extra);
  }
}

export const badInput = message => new YouTubeError('bad_input', message);

// One short line for stderr: {"error":"<code>","message":"..."}.
export function errorLine(error, extra = {}) {
  const e = error instanceof YouTubeError ? error : new YouTubeError('api_error', 'unexpected failure');
  return JSON.stringify({error: e.code, message: e.message, ...extra});
}

// Google reply (status + parsed body) to a classified error. Only reason tokens that look like
// plain words are repeated; the free-text message from Google is dropped.
export function classifyResponse(status, body, what = 'resource') {
  const listed = [...(Array.isArray(body?.error?.errors) ? body.error.errors : []), ...(Array.isArray(body?.error?.details) ? body.error.details : [])];
  const reasons = listed.map(e => e?.reason).filter(r => typeof r === 'string' && /^[A-Za-z_]{3,40}$/.test(r));
  const has = (...names) => names.some(n => reasons.includes(n));
  if (has('commentsDisabled')) return new YouTubeError('comments_disabled', 'Comments are turned off for this video.');
  if (has('quotaExceeded', 'dailyLimitExceeded')) {
    return new YouTubeError('quota_exceeded', 'Google says the daily YouTube API quota for this key is used up (the key is shared with other tools). It resets at midnight Pacific time. Try again later.');
  }
  if (status === 404 || has('videoNotFound', 'channelNotFound', 'playlistNotFound', 'commentThreadNotFound', 'notFound')) {
    return new YouTubeError('not_found', `${what} not found (wrong id, private or deleted).`);
  }
  const detail = `HTTP ${status}${reasons.length ? `, reason ${reasons[0]}` : ''}`;
  if (has('keyInvalid', 'API_KEY_INVALID')) return new YouTubeError('api_error', `The YouTube API rejected the key (${detail}). Tell Owner the key in /etc/mastan-me/youtube.env needs checking.`, {status});
  if (status === 429 || has('rateLimitExceeded', 'userRateLimitExceeded')) return new YouTubeError('api_error', `The YouTube API is rate limiting (${detail}). Wait a minute and try again.`, {status});
  return new YouTubeError('api_error', `YouTube API error (${detail}).`, {status});
}

// A thrown fetch error becomes `network`; only a bare error code like ECONNRESET is repeated.
export function networkError(e) {
  const code = [e?.cause?.code, e?.code].find(c => typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,30}$/.test(c));
  const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
  return new YouTubeError('network', `Could not reach the YouTube API (${timeout ? 'timed out' : code || 'network error'}).`);
}
