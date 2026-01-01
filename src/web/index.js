// Web entry: createWeb(ctx) returns the request handler that src/server.js mounts for
// everything except /healthz. Passkey auth (Topic Board pattern), CSRF, host check,
// security headers, static assets from memory, pages and /api/*.
// Logs never contain request bodies, tokens, URLs with ids, or atlas text.
import {readFileSync, existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse} from '@simplewebauthn/server';
import * as A from './auth.js';
import {PAGES, VENDOR_GRAPH, renderShell, renderChat, renderLogin, renderNotFound} from './pages.js';
import {createApi} from './api.js';
import {createMailRoutes} from './mail-routes.js';
import {createChatRoutes} from './chat-routes.js';
import {createFleetRoutes, fleetCall, LEASE_COOKIE, LEASE_MAX_AGE} from './fleet.js';
import {createSessionRoutes, SESSION_ROUTE} from './session-routes.js';
import {createClientsRoutes} from './clients.js';
import {createCapabilityRequests} from '../clients/capability-requests.js';
import {agentInfo as requestAgentInfo, refOf} from '../clients/request-prs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const COOKIE = '__Host-mastan_me';
export const CEREMONY = '__Host-mastan_me_ceremony';
const AUTH_HEADER = 'x-mastan-me';
const SMALL_BODY = 16 * 1024;
// These bundled CSS injectors would violate style-src 'self'. Their rules live in app.css.
const GRAPH_STYLE_INJECTOR = '!function(e,t){void 0===t&&(t={});var n=t.insertAt;if("undefined"!=typeof document){var i=document.head||document.getElementsByTagName("head")[0],r=document.createElement("style");r.type="text/css","top"===n&&i.firstChild?i.insertBefore(r,i.firstChild):i.appendChild(r),r.styleSheet?r.styleSheet.cssText=e:r.appendChild(document.createTextNode(e))}}';

// name -> [source, content type, public before sign-in]
function assetTable(codeDir) {
  const pub = join(HERE, 'public');
  return {
    'theme-boot.js': [join(pub, 'theme-boot.js'), 'text/javascript', true],
    'shell.css': [join(pub, 'shell.css'), 'text/css', true],
    'shell.js': [join(pub, 'shell.js'), 'text/javascript', false],
    'app.css': [join(pub, 'app.css'), 'text/css', true],
    'mastan.png': [join(pub, 'mastan.png'), 'image/png', true],
    'icon-64.png': [join(pub, 'icon-64.png'), 'image/png', true],
    'icon-180.png': [join(pub, 'icon-180.png'), 'image/png', true],
    'login.js': [join(pub, 'login.js'), 'text/javascript', true],
    'webauthn.js': [join(codeDir, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'), 'text/javascript', true],
    'common.js': [join(pub, 'common.js'), 'text/javascript', false],
    'atlas.js': [join(pub, 'atlas.js'), 'text/javascript', false],
    ...Object.fromEntries(['app.js', 'approvals.js', 'ui.js', 'strings.js', 'markdown.js', 'highlight.js', 'media.js', 'audio.js', 'emoji.js', 'emoji-data.js', 'sync.js', 'theme.js', 'install.js']
      .map(f => [`chat/${f}`, [join(HERE, 'chatclient', f), 'text/javascript', false]])),
    'chat/app.css': [join(HERE, 'chatclient', 'app.css'), 'text/css', false],
    'chat/me-skin.css': [join(HERE, 'chatclient', 'me-skin.css'), 'text/css', false],
    'chat/pattern.svg': [join(HERE, 'chatclient', 'pattern.svg'), 'image/svg+xml', false],
    'chat/manifest.json': [join(HERE, 'chatclient', 'manifest.json'), 'application/manifest+json', true],
    'questions.js': [join(pub, 'questions.js'), 'text/javascript', false],
    'board.js': [join(pub, 'board.js'), 'text/javascript', false],
    'positions.js': [join(pub, 'positions.js'), 'text/javascript', false],
    'dump.js': [join(pub, 'dump.js'), 'text/javascript', false],
    'settings.js': [join(pub, 'settings.js'), 'text/javascript', false],
    'mail.js': [join(pub, 'mail.js'), 'text/javascript', false],
    'mail-compose.js': [join(pub, 'mail-compose.js'), 'text/javascript', false],
    'mail-helpers.js': [join(pub, 'mail-helpers.js'), 'text/javascript', false],
    'mail.css': [join(pub, 'mail.css'), 'text/css', false],
    'fleet.js': [join(pub, 'fleet.js'), 'text/javascript', false],
    'clients.js': [join(pub, 'clients.js'), 'text/javascript', false],
    'stats.js': [join(pub, 'stats.js'), 'text/javascript', false],
    'traffic.js': [join(pub, 'traffic.js'), 'text/javascript', false],
    'requests.js': [join(pub, 'requests.js'), 'text/javascript', false],
    'people-data.js': [join(pub, 'people-data.js'), 'text/javascript', false],
    'people.js': [join(pub, 'people.js'), 'text/javascript', false],
    [VENDOR_GRAPH]: [join(pub, VENDOR_GRAPH), 'text/javascript', false],
  };
}

function loadAssets(codeDir) {
  const out = new Map();
  for (const [name, [file, type, isPublic]] of Object.entries(assetTable(codeDir))) {
    if (!existsSync(file)) { console.error(`[web] asset missing: ${name}`); continue; }
    const source = readFileSync(file);
    const body = name === VENDOR_GRAPH ? Buffer.from(source.toString().replaceAll(GRAPH_STYLE_INJECTOR, 'void')) : source;
    const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
    const gz = !type.startsWith('image/') || type === 'image/svg+xml' ? gzipSync(body, {level: 9}) : null;
    out.set(name, {body, gz: gz && gz.length < body.length ? gz : null, type, isPublic, version});
  }
  return out;
}

function cookieValue(req, name) {
  const values = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
const cookie = (name, value, maxAge, sameSite = 'Lax') => `${name}=${value}; HttpOnly; Secure; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}`;

export async function readJson(req, limit = SMALL_BODY) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw A.fail(415);
  if (req.headers['transfer-encoding'] || !/^\d{1,9}$/.test(req.headers['content-length'] || '')) throw A.fail(411);
  if (Number(req.headers['content-length']) > limit) throw A.fail(413);
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > limit) throw A.fail(413); parts.push(part); }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw A.fail(400); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw A.fail(400);
  return value;
}
export function onlyKeys(value, allowed) { if (Object.keys(value).some(k => !allowed.includes(k))) throw A.fail(400); }

export function createWeb(ctx, {verification = {}, fleetTransport, stripeTransport, canaryFetch, now, capabilityNotify} = {}) {
  const {config, db} = ctx;
  if (!config || !db) throw new Error('createWeb needs ctx.config and ctx.db');
  A.ensureAuthTables(db);
  A.prune(db);
  const verify = {verifyRegistrationResponse, verifyAuthenticationResponse, ...verification};
  const assets = loadAssets(config.codeDir || join(HERE, '..', '..'));
  const asset = name => `/static/${name}?v=${assets.get(name)?.version || '0'}`;
  let lastPrune = Date.now();

  const loopbackHost = req => `127.0.0.1:${req.socket.localPort}`;
  const hostOk = req => req.headers.host === config.host || req.headers.host === loopbackHost(req) || req.headers.host === `127.0.0.1:${config.port}`;
  const expectedOrigin = req => (req.headers.host === config.host ? config.origin : `http://${req.headers.host}`);
  const clientIp = req => {
    const remote = req.socket.remoteAddress || '';
    const loop = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    return (loop && typeof req.headers['x-real-ip'] === 'string' && req.headers['x-real-ip'].slice(0, 64)) || remote;
  };

  function sameOrigin(req) {
    if (req.headers.origin !== expectedOrigin(req)) throw A.fail(403);
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') throw A.fail(403);
  }
  function csrf(req, session) {
    sameOrigin(req);
    if (!session || !A.safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) throw A.fail(403);
  }

  const json = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
  const redirect = (res, location) => { res.writeHead(303, {Location: location}); res.end(); };
  const text = (res, status, body) => { res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8'}); res.end(body); };

  function setSession(res, session, ttl) {
    res.setHeader('Set-Cookie', [cookie(COOKIE, session.value, Math.floor(ttl / 1000)), cookie(CEREMONY, '', 0, 'Strict')]);
  }

  // Auto-approve lease: HttpOnly in Owner's browser, a hash in the gate, never on this server's disk.
  const leaseOf = req => { const value = cookieValue(req, LEASE_COOKIE); return A.TOKEN_RE.test(value) ? value : null; };
  const setLease = (res, value) => res.appendHeader('Set-Cookie', cookie(LEASE_COOKIE, value, value ? LEASE_MAX_AGE : 0, 'Strict'));
  const gate = (request, timeout = 3000) => (fleetTransport || fleetCall)(request, {socketPath: ctx.fleetSocket || '/run/mastan-fleet.sock', timeout});

  async function authRoute(req, res, path) {
    if (req.method !== 'POST') throw A.fail(405);
    sameOrigin(req);
    if (req.headers[AUTH_HEADER] !== '1') throw A.fail(403);
    A.rateLimit(db, clientIp(req));
    const input = await readJson(req);
    if (path === '/auth/login/options') {
      onlyKeys(input, []);
      // The gate's challenge when it answers: the same one passkey signature then also opens the auto-approve lease.
      const gateChallenge = await gate({op: 'lease_challenge'}, 1500).then(r => r.ok ? r.challenge : null, () => null);
      const options = await generateAuthenticationOptions({rpID: config.rpId, userVerification: 'required', ...(gateChallenge ? {challenge: Buffer.from(gateChallenge, 'base64url')} : {})});
      res.setHeader('Set-Cookie', cookie(CEREMONY, A.saveChallenge(db, 'login', options.challenge), 300, 'Strict'));
      return json(res, 200, options);
    }
    if (path === '/auth/login/verify') {
      onlyKeys(input, ['response']);
      const expected = A.takeChallenge(db, cookieValue(req, CEREMONY), 'login');
      if (!expected) throw A.fail(401);
      const id = typeof input.response?.id === 'string' ? input.response.id : '';
      const row = id && db.prepare('SELECT * FROM credentials WHERE id=?').get(id);
      if (!row) throw A.fail(401);
      let checked;
      try {
        checked = await verify.verifyAuthenticationResponse({response: input.response, expectedChallenge: expected.challenge,
          expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true,
          credential: {id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports)}});
      } catch { throw A.fail(401); }
      if (!checked?.verified) throw A.fail(401);
      const session = A.transaction(db, () => {
        if (!db.prepare('UPDATE credentials SET counter=? WHERE id=? AND counter=?').run(checked.authenticationInfo.newCounter, row.id, row.counter).changes) throw A.fail(401);
        return A.createSession(db, row.id);
      });
      setSession(res, session, A.SESSION_TTL);
      // Sign-in never depends on the gate. Without a lease the chat shows auto-approve as off, one tap away.
      const lease = await gate({op: 'lease_open', assertion: input.response, challenge: expected.challenge}).then(r => r.ok ? r.lease : null, () => null);
      if (lease) setLease(res, lease);
      return json(res, 200, {ok: true});
    }
    if (path === '/auth/register/options') {
      onlyKeys(input, ['enrollment']);
      if (typeof input.enrollment !== 'string' || !A.TOKEN_RE.test(input.enrollment)) throw A.fail(401);
      const enrollment = A.hash(input.enrollment);
      const row = db.prepare('SELECT expires FROM enrollments WHERE hash=? AND expires>?').get(enrollment, Date.now());
      if (!row) throw A.fail(401);
      // Own user id, so a new passkey never replaces the Topic Board one on the device.
      // Exclude only passkeys registered here: an imported board passkey must not block the fallback.
      const options = await generateRegistrationOptions({rpName: 'Mastan Me', rpID: config.rpId,
        userName: 'Owner (Mastan Me)', userDisplayName: 'Owner',
        userID: new Uint8Array(Buffer.from(A.hash('mastan-me-owner'), 'hex')), attestationType: 'none',
        excludeCredentials: db.prepare("SELECT id, transports FROM credentials WHERE origin='local'").all().map(c => ({id: c.id, transports: JSON.parse(c.transports)})),
        authenticatorSelection: {residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform'}});
      res.setHeader('Set-Cookie', cookie(CEREMONY, A.saveChallenge(db, 'register', options.challenge, enrollment, Math.min(row.expires, Date.now() + A.CHALLENGE_TTL)), 300, 'Strict'));
      return json(res, 200, options);
    }
    if (path === '/auth/register/verify') {
      onlyKeys(input, ['response']);
      const expected = A.takeChallenge(db, cookieValue(req, CEREMONY), 'register');
      if (!expected) throw A.fail(401);
      let checked;
      try {
        checked = await verify.verifyRegistrationResponse({response: input.response, expectedChallenge: expected.challenge,
          expectedOrigin: config.origin, expectedRPID: config.rpId, requireUserVerification: true});
      } catch { throw A.fail(401); }
      if (!checked?.verified || !checked.registrationInfo) throw A.fail(401);
      const c = checked.registrationInfo.credential;
      const session = A.transaction(db, () => {
        if (!A.consumeEnrollment(db, expected.enrollment)) throw A.fail(401);
        A.addCredential(db, {id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports || [], origin: 'local'});
        return A.createSession(db, c.id);
      });
      setSession(res, session, A.SESSION_TTL);
      return json(res, 200, {ok: true});
    }
    if (path === '/auth/operator') {
      onlyKeys(input, ['token']);
      const session = A.transaction(db, () => {
        if (!A.consumeOperatorLink(db, input.token)) throw A.fail(401);
        return A.createSession(db, A.OPERATOR, {ttl: A.OPERATOR_SESSION_TTL});
      });
      setSession(res, session, A.OPERATOR_SESSION_TTL);
      return json(res, 200, {ok: true});
    }
    throw A.fail(404);
  }

  const api = createApi(ctx, {readJson, onlyKeys, fail: A.fail, json});
  const mailApi = createMailRoutes(ctx, {readJson, onlyKeys, fail: A.fail, json});
  const chatApi = createChatRoutes(ctx, {readJson, onlyKeys, fail: A.fail, json});
  const sessionApi = createSessionRoutes(ctx, {readJson, onlyKeys, fail: A.fail, json, leaseOf});
  const fleetApi = createFleetRoutes(ctx, {readJson, onlyKeys, fail: A.fail, json, leaseOf, setLease}, fleetTransport ? {transport: fleetTransport} : {});
  const clientsApi = createClientsRoutes(ctx, {readJson, onlyKeys, fail: A.fail, json}, {stripeTransport, canaryFetch, now});
  const capabilityRequests = createCapabilityRequests(ctx, {...(now ? {now} : {}), ...(capabilityNotify ? {notify: capabilityNotify} : {})});
  capabilityRequests.start();
  ctx.capabilityRequests = capabilityRequests;

  function serveAsset(req, res, name, session) {
    const a = assets.get(name);
    if (!a) throw A.fail(404);
    if (!a.isPublic && !session) throw A.fail(401);
    const v = new URL(req.url, 'http://x').searchParams.get('v');
    res.setHeader('Cache-Control', v === a.version ? 'private, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    const gzip = a.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, {'Content-Type': a.type + (a.type.startsWith('image/') && a.type !== 'image/svg+xml' ? '' : '; charset=utf-8'),
      ...(gzip ? {'Content-Encoding': 'gzip'} : {}), 'Content-Length': (gzip ? a.gz : a.body).length});
    res.end(req.method === 'HEAD' ? undefined : gzip ? a.gz : a.body);
  }

  return async function handle(req, res) {
    const nonce = A.token();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`);
    let route = 'other';
    try {
      if (!hostOk(req)) { route = 'host'; throw A.fail(403); }
      const now = Date.now();
      if (now - lastPrune > 600_000) { lastPrune = now; A.prune(db, now); }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // A permanent redirect to /fleet/ once went out and browsers keep it, so a redirect back would loop.
      const path = ['/fleet/', '/stats/', '/traffic/', '/people/', '/clients/', '/requests/', '/mail/'].includes(pathname) ? pathname.slice(0, -1) : pathname;

      if (path.startsWith('/static/')) {
        route = 'static';
        if (req.method !== 'GET' && req.method !== 'HEAD') throw A.fail(405);
        const name = path.slice('/static/'.length);
        const a = assets.get(name);
        return serveAsset(req, res, name, a && !a.isPublic ? A.findSession(db, cookieValue(req, COOKIE)) : null);
      }
      if (path.startsWith('/auth/')) { route = 'auth'; return await authRoute(req, res, path); }
      // Client plans: a server's own token, and the unguessable link in a client's payment message. Neither uses a session.
      if (path === '/api/client-deals/sync') {
        route = 'client-deals';
        if (req.method !== 'POST') throw A.fail(405);
        const result = await clientsApi.deals.sync(req.headers.authorization, await readJson(req, 16 * 1024));
        if (!result) throw A.fail(401);
        return json(res, 200, result);
      }
      if (path === '/api/client-billing/sync') {
        route = 'client-billing';
        if (req.method !== 'POST') throw A.fail(405);
        const result = clientsApi.billing.sync(req.headers.authorization, await readJson(req, 16 * 1024));
        if (!result) throw A.fail(401);
        return json(res, 200, result);
      }
      // A server's own token, which can do nothing else. Ten requests at their longest fit well inside this body limit.
      if (path === '/api/capability-requests/sync') {
        route = 'capability-requests';
        if (req.method !== 'POST') throw A.fail(405);
        const result = capabilityRequests.sync(req.headers.authorization, await readJson(req, 64 * 1024));
        if (!result) throw A.fail(401);
        return json(res, 200, result);
      }
      if (path.startsWith('/pay/')) {
        route = 'pay';
        if (req.method !== 'GET' && req.method !== 'HEAD') throw A.fail(405);
        const [token, done] = path.slice('/pay/'.length).split('/');
        const note = text => { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Mastan</title><body style="font:18px/1.5 system-ui;max-width:32em;margin:15vh auto;padding:0 20px;text-align:center"><p>${text}</p></body>`); };
        if (done === 'done') return note('Thank you. If you completed the payment, Mastan will confirm it in your chat within a few minutes.');
        try {
          // A random monthly plan token can start with d_ too, so a closed deal is not the final answer.
          let result = token.startsWith('d_') ? await clientsApi.deals.payRedirect(token.slice(2)) : null;
          if (!result || result.page === 'closed') result = await clientsApi.billing.payRedirect(token);
          if (result.redirect) { res.writeHead(303, {Location: result.redirect, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}); return res.end(); }
          return note(result.page === 'paid' ? 'This plan is already paid. Thank you.' : 'This payment link is no longer active. Please write to hello@mastan.ai.');
        } catch { return note('Payment is unavailable for a moment. Please try this link again in a few minutes.'); }
      }

      const session = A.findSession(db, cookieValue(req, COOKIE));
      const html = page => { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(page); };

      // Mail is invisible to signed-out and operator sessions.
      if ((path === '/mail' || path === '/api/mail' || path.startsWith('/api/mail/')) && (!session || session.operator)) throw A.fail(404);
      if (path === '/mail') res.setHeader('Content-Security-Policy', res.getHeader('Content-Security-Policy') + "; frame-src 'self'");

      // Owner pages go to sign-in when signed out; operators never see them.
      if ((path === '/api/fleet' || path.startsWith('/api/fleet/') || path.startsWith('/api/clients') || path.startsWith('/api/capability-requests') || path === '/api/numbers' || path === '/api/traffic') && (!session || session.operator) || ['/fleet', '/stats', '/traffic', '/people', '/clients', '/requests'].includes(path) && session?.operator) throw A.fail(404);

      if (path === '/login') {
        route = 'login';
        if (req.method !== 'GET' && req.method !== 'HEAD') throw A.fail(405);
        // Served even with a session: a #enrol= or #operator= fragment must reach login.js (fragments survive redirects).
        return html(renderLogin({nonce, asset}));
      }
      if (path.startsWith('/api/')) {
        route = 'api';
        if (!session) throw A.fail(401);
        if (path === '/api/logout') {
          if (req.method !== 'POST') throw A.fail(405);
          csrf(req, session);
          onlyKeys(await readJson(req), []);
          A.deleteSession(db, session.hash);
          res.setHeader('Set-Cookie', cookie(COOKIE, '', 0));
          const lease = leaseOf(req);
          if (lease) { setLease(res, ''); await gate({op: 'lease_close', lease}).catch(() => {}); }
          return json(res, 200, {ok: true});
        }
        if (path.startsWith('/api/mail/') && !/^\/api\/mail\/[a-f0-9]{24}\/open$/.test(path)) {
          if (req.method === 'POST') csrf(req, session);
          else if (req.method !== 'GET' && req.method !== 'HEAD') throw A.fail(405);
          return await mailApi(req, res, path, session);
        }
        if (SESSION_ROUTE.test(path)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') csrf(req, session);
          return await sessionApi(req, res, path, session);
        }
        if (req.method === 'POST') csrf(req, session);
        else if (req.method !== 'GET' && req.method !== 'HEAD') throw A.fail(405);
        if (path.startsWith('/api/chat/')) return await chatApi(req, res, path, session);
        if (path === '/api/fleet' || path.startsWith('/api/fleet/')) return await fleetApi(req, res, path, session);
        if (path === '/api/clients' || path.startsWith('/api/clients/')) return await clientsApi(req, res, path, session);
        if (path === '/api/capability-requests' && req.method !== 'POST') {
          // What the request-PR flow did with each request, when it has run (src/clients/request-prs.js).
          const listed = capabilityRequests.list(), agent = requestAgentInfo(db);
          for (const g of listed.groups) { g.ref = refOf(g.key); g.agent = agent[g.key] || null; }
          return json(res, 200, listed);
        }
        if (path === '/api/capability-requests/status' && req.method === 'POST') {
          const input = await readJson(req);
          onlyKeys(input, ['key', 'status']);
          capabilityRequests.setStatus(input.key, input.status);
          return json(res, 200, {ok: true});
        }
        if (path.startsWith('/api/capability-requests')) throw A.fail(404);
        if (path === '/api/numbers' && req.method !== 'POST') {
          // Aggregates only, uploaded hourly from the Mac by mastan-stats.
          try { return json(res, 200, JSON.parse(await readFile(ctx.statsFile || '/var/www/mastan-stats/stats.json', 'utf8'))); }
          catch { return json(res, 200, {available: false}); }
        }
        if (path === '/api/traffic' && req.method !== 'POST') {
          // mastan.ai visits with no IP or session id, copied every 5 minutes from Umami.
          try { return json(res, 200, JSON.parse(await readFile(ctx.trafficFile || '/var/www/mastan-stats/traffic.json', 'utf8'))); }
          catch { return json(res, 200, {available: false}); }
        }
        return await api(req, res, path, session);
      }
      route = 'page';
      if (req.method !== 'GET' && req.method !== 'HEAD') throw A.fail(405);
      if (!session) return redirect(res, /^\/chat\/mail\/[a-f0-9]{24}$/.test(path) ? `/login?next=${path}` : '/login');
      const chatPage = path === '/chat' || /^\/chat\/(s\/\d{1,9}|mail\/[a-f0-9]{24})$/.test(path);
      if (chatPage) {
        let stats = null;
        try { stats = ctx.atlas?.stats(); } catch { stats = null; }
        return html(renderChat({path, nonce, csrf: session.csrf, stats, asset, operator: session.operator}));
      }
      if (!PAGES[path]) { res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8'}); return res.end(renderNotFound({nonce, asset})); }
      let stats = null;
      try { stats = ctx.atlas?.stats(); } catch { stats = null; }
      return html(renderShell({path, nonce, csrf: session.csrf, stats, asset, operator: session.operator}));
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[web] ${req.method} ${route} ${status} ${error.code || error.name || 'Error'}`);
      if (res.headersSent) { res.end(); return; }
      if (route === 'host') return text(res, 403, 'Forbidden');
      if (route === 'page' && status === 401) return redirect(res, '/login');
      const messages = {401: 'Please sign in again.', 403: 'Request refused.', 404: 'Not found.', 409: error.message && error.expose ? error.message : 'Changed elsewhere. Reload and try again.',
        413: 'Too long.', 429: 'Too many attempts. Wait five minutes.'};
      json(res, status, {error: error.expose ? error.message : messages[status] || 'Request failed. Please try again.'});
    }
  };
}
