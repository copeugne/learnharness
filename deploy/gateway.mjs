import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Accounts, RateLimit } from './accounts.mjs';
import { Runtimes } from './runtimes.mjs';
import { page, authPage, accountPage } from './views.mjs';
import { loadAbout } from './about.mjs';

const COOKIE = '__Host-learn_session';
const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
function cookie(request) {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0].slice(COOKIE.length + 1) : null;
}
function sessionCookie(token, expire = false) {
  return `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${expire ? 0 : 14 * 86400}`;
}
async function form(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new Error('Submit the sign-in form to continue.');
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('The form is too large.');
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (fields.getAll('username').length !== 1 || fields.getAll('password').length !== 1) throw new Error('Provide one username and password.');
  return { username: fields.get('username'), password: fields.get('password') };
}
function html(response, code, body, headers = {}) {
  response.writeHead(code, { ...SAFE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...headers });
  response.end(body);
}
function redirect(response, location, headers = {}) { response.writeHead(303, { ...SAFE_HEADERS, Location: location, ...headers }); response.end(); }
function apiError(response, status, message) {
  response.writeHead(status, { ...SAFE_HEADERS, 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: message }));
}
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
export function createGateway({ origin, accounts, runtimes, sourceFile, aboutDirectory, clientIP = request => request.socket.remoteAddress, logger = console, idleMs = 30 * 60_000 }) {
  const publicURL = new URL(origin);
  if (!['https:', 'http:'].includes(publicURL.protocol) || publicURL.pathname !== '/' || publicURL.search || publicURL.hash || publicURL.username || publicURL.password) throw new Error('LH_PUBLIC_ORIGIN must be a plain HTTP(S) origin.');
  const limit = new RateLimit();
  const about = aboutDirectory ? loadAbout(aboutDirectory) : new Map();
  const pending = new Map();
  const endpoints = new Map();
  const connections = new Map();
  const activity = new Map();
  const suspending = new Map();
  const ready = id => {
    if (suspending.has(id)) return suspending.get(id).then(() => ready(id));
    const cached = endpoints.get(id);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.endpoint);
    if (!pending.has(id)) {
      const work = runtimes.ensure(id).then(endpoint => { endpoints.set(id, { endpoint, until: Date.now() + 5000 }); return endpoint; }).finally(() => pending.delete(id));
      pending.set(id, work);
    }
    return pending.get(id);
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    response.on('error', () => {});
    try {
      if (request.headers.host !== publicURL.host) return apiError(response, 421, 'Unexpected host.');
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || /[\\\x00-\x20]/.test(request.url)) return apiError(response, 400, 'Invalid request path.');
      const url = new URL(request.url, publicURL);
      if (url.origin !== publicURL.origin) return apiError(response, 400, 'Invalid request origin.');
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) return apiError(response, 405, 'Unsupported method.');
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (((mutation || url.pathname.startsWith('/api/')) && request.headers['sec-fetch-site'] === 'cross-site') || (mutation && request.headers.origin !== publicURL.origin)) return apiError(response, 403, 'Use LearnHarness from its own browser tab.');
      const token = cookie(request);
      const account = accounts.authenticate(token);
      if (url.pathname === '/about') return redirect(response, '/about/');
      const asset = about.get(url.pathname);
      if (asset) {
        if (!['GET', 'HEAD'].includes(request.method)) return apiError(response, 405, 'Unsupported method.');
        const headers = { 'Cache-Control': 'public, max-age=3600', ETag: asset.etag, 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
        if (request.headers['if-none-match'] === asset.etag) { response.writeHead(304, headers); return response.end(); }
        response.writeHead(200, { ...headers, 'Content-Length': asset.body.length });
        return response.end(request.method === 'HEAD' ? undefined : asset.body);
      }
      if (url.pathname === '/api/host-runtime') return apiError(response, 404, 'Not found.');
      if (url.pathname === '/source') {
        if (!['GET', 'HEAD'].includes(request.method)) return apiError(response, 405, 'Unsupported method.');
        if (!sourceFile) return apiError(response, 503, 'Corresponding source is unavailable.');
        const stat = fs.statSync(sourceFile);
        response.writeHead(200, { ...SAFE_HEADERS, 'Content-Type': 'application/gzip', 'Content-Length': stat.size, 'Content-Disposition': 'attachment; filename="learnharness-source.tar.gz"' });
        if (request.method === 'HEAD') return response.end();
        const stream = fs.createReadStream(sourceFile);
        stream.on('error', error => { logger.error('Source download failed:', error.message); response.destroy(); });
        response.on('close', () => stream.destroy());
        return stream.pipe(response);
      }
      if (url.pathname === '/auth/login' || url.pathname === '/auth/register') {
        const registration = url.pathname.endsWith('register');
        if (request.method === 'GET') return account ? redirect(response, '/') : html(response, 200, authPage(registration));
        if (request.method !== 'POST') return apiError(response, 405, 'Unsupported method.');
        if (account) return redirect(response, '/');
        const ip = clientIP(request);
        if (!limit.take(`auth:${ip}`, 20, 15 * 60_000) || (registration && !limit.take(`register:${ip}`, 3, 3600_000))) return html(response, 429, authPage(registration, 'Too many attempts. Please try again later.'), { 'Retry-After': '900' });
        let fields;
        try { fields = await form(request); } catch (error) { return html(response, 400, authPage(registration, error.message)); }
        if (!limit.take(`user:${fields.username.trim().toLowerCase()}`, 20, 15 * 60_000)) return html(response, 429, authPage(registration, 'Too many attempts. Please try again later.'), { 'Retry-After': '900' });
        let user;
        try {
          user = registration ? await accounts.register(fields.username, fields.password) : await accounts.login(fields.username, fields.password);
        } catch (error) {
          // Only validation/capacity messages are safe to show; storage errors stay server-side.
          const allowed = /^(Use |That username |Registration is |Sign-in is )/.test(error.message);
          if (!allowed) logger.error('Account operation failed:', error.message);
          return html(response, allowed ? 400 : 503, authPage(registration, allowed ? error.message : 'Account storage is unavailable. Please try again later.', fields.username));
        }
        if (!user) return html(response, 401, authPage(false, 'The username or password is incorrect.', fields.username));
        return redirect(response, '/', { 'Set-Cookie': sessionCookie(accounts.session(user)) });
      }
      if (!account) {
        if (url.pathname.startsWith('/api/')) return apiError(response, 401, 'Sign in to continue.');
        return redirect(response, '/auth/login');
      }
      if (url.pathname === '/auth/logout') {
        if (request.method !== 'POST') return apiError(response, 405, 'Use the sign-out button.');
        accounts.logout(token);
        for (const connection of connections.get(token) ?? []) connection.destroy();
        connections.delete(token);
        return redirect(response, '/auth/login', { 'Set-Cookie': sessionCookie(null, true) });
      }
      if (url.pathname === '/auth/account') {
        if (request.method !== 'GET') return apiError(response, 405, 'Unsupported method.');
        return html(response, 200, accountPage(account));
      }
      if (url.pathname.startsWith('/auth/')) return apiError(response, 404, 'Unknown account action.');
      if (!limit.take(`requests:${account.id}`, 600, 60_000)) return apiError(response, 429, 'Too many requests. Please try again shortly.');
      const currentActivity = activity.get(account.id) ?? { last: 0, open: 0 };
      currentActivity.last = Date.now(); currentActivity.open++;
      activity.set(account.id, currentActivity);
      response.on('close', () => { currentActivity.open--; currentActivity.last = Date.now(); });
      const endpoint = await ready(account.id);
      if (response.destroyed || request.destroyed) return;
      if (accounts.authenticate(token)?.id !== account.id) return apiError(response, 401, 'Sign in to continue.');
      const connectionHeaders = new Set(String(request.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()));
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP.has(name) && !connectionHeaders.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('x-middleware-') && !name.startsWith('x-learnharness-') && !name.startsWith('x-lh-') && !['forwarded', 'authorization', 'cookie'].includes(name)));
      // The subscription control's fixed marker is a CSRF guard, not a secret or tenant identity.
      if (request.headers['x-learnharness-subscriptions'] === '1') headers['x-learnharness-subscriptions'] = '1';
      headers.host = publicURL.host;
      headers['x-forwarded-proto'] = publicURL.protocol.slice(0, -1);
      headers['x-forwarded-host'] = publicURL.host;
      if (endpoint.secret) headers['x-learnharness-web'] = endpoint.secret;
      const upstream = http.request({ hostname: '127.0.0.1', port: endpoint.port, method: request.method, path: request.url, headers }, incoming => {
        const incomingConnection = new Set(String(incoming.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()));
        const outgoing = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP.has(name) && !incomingConnection.has(name) && name !== 'set-cookie'));
        if (!/^\/_next\/static\/[a-zA-Z0-9_./-]+$/.test(url.pathname)) outgoing['cache-control'] = 'private, no-store';
        response.writeHead(incoming.statusCode ?? 502, { ...outgoing, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      const active = connections.get(token) ?? new Set();
      active.add(upstream); connections.set(token, active);
      upstream.on('close', () => { active.delete(upstream); if (active.size === 0) connections.delete(token); });
      upstream.on('error', error => {
        endpoints.delete(account.id);
        logger.error('Learning space proxy failed:', error.code ?? error.message);
        if (!response.headersSent) apiError(response, 502, 'The learning space is restarting. Please retry.');
        else response.destroy();
      });
      response.on('close', () => upstream.destroy());
      request.on('aborted', () => upstream.destroy());
      // SSE may live for hours. Cap stalled non-streaming requests, not event streams.
      if (url.pathname !== '/api/events' && !url.pathname.endsWith('/stream') && url.pathname !== '/api/chat') upstream.setTimeout(120000, () => upstream.destroy(new Error('Learning space request timed out.')));
      request.pipe(upstream);
    } catch (error) {
      logger.error('Gateway request failed:', error.message);
      if (!response.headersSent) {
        if (request.url?.startsWith('/api/')) apiError(response, 503, 'The learning space is unavailable. Please try again shortly.');
        else html(response, 503, page('Please try again', '<h1>Your learning space is unavailable</h1><p>It may be starting or the server may be busy. Please retry shortly.</p><nav><a href="/">Retry</a><a href="/auth/account">Account</a></nav>'), { 'Retry-After': '5' });
      } else response.destroy();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.sweepIdle = async () => {
    if (!runtimes.suspend) return;
    for (const id of await runtimes.runningIDs?.() ?? []) {
      if (!activity.has(id)) activity.set(id, { last: Date.now(), open: 0 });
    }
    for (const [id, state] of activity) {
      if (state.open || Date.now() - state.last < idleMs || pending.has(id) || suspending.has(id)) continue;
      const stop = runtimes.suspend(id).then(stopped => {
        if (stopped) { endpoints.delete(id); if (state.open === 0) activity.delete(id); }
      }).finally(() => suspending.delete(id));
      suspending.set(id, stop);
      await stop;
    }
  };
  const sweeper = setInterval(() => server.sweepIdle().catch(error => logger.error('Idle runtime check failed:', error.message)), 60_000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href) {
  const directory = process.env.LH_GATEWAY_STATE;
  const origin = process.env.LH_PUBLIC_ORIGIN;
  if (!directory || !origin) throw new Error('Set LH_GATEWAY_STATE and LH_PUBLIC_ORIGIN before starting.');
  const gateway = createGateway({
    origin,
    accounts: new Accounts(directory, { maxAccounts: Number(process.env.LH_MAX_ACCOUNTS ?? 12) }),
    runtimes: new Runtimes({ image: process.env.LH_TENANT_IMAGE, maxActive: Number(process.env.LH_MAX_ACTIVE ?? 8) }),
    sourceFile: process.env.LH_SOURCE_ARCHIVE,
    aboutDirectory: process.env.LH_ABOUT_DIRECTORY,
    // Only the loopback Nginx listener can supply this header. Never publish this port.
    clientIP: request => String(request.headers['x-lh-client-ip'] ?? request.socket.remoteAddress),
  });
  const port = Number(process.env.LH_GATEWAY_PORT ?? 3310);
  gateway.listen(port, '127.0.0.1', () => console.log(`LearnHarness gateway listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    gateway.closeAllConnections();
    gateway.close(() => process.exit(0));
  });
}
