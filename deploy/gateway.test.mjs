import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Accounts, RateLimit } from './accounts.mjs';
import { createGateway } from './gateway.mjs';

const temporary = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-gateway-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function request(port, route, { method = 'GET', token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { host: 'learn.test', ...(token ? { cookie: `__Host-learn_session=${token}` } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
const form = (username, password = 'correct horse battery staple') => ({ method: 'POST', headers: { origin: 'https://learn.test', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }).toString() });
const tokenOf = reply => reply.headers['set-cookie'][0].split(';')[0].split('=')[1];

test('accounts persist private credentials and hashed sessions, reject wrong passwords and expire sessions', async t => {
  let time = 1000;
  const dir = temporary(t);
  const accounts = new Accounts(dir, { now: () => time });
  const user = await accounts.register('Alice', 'correct horse battery staple');
  assert.equal(user.username, 'alice');
  assert.equal(await accounts.login('alice', 'bad password'), null);
  assert.equal((await accounts.login('ALICE', 'correct horse battery staple')).id, user.id);
  const token = accounts.session(user);
  accounts.session(user);
  assert.equal(accounts.authenticate(token).id, user.id, 'a second device does not revoke an existing session');
  const disk = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.ok(!disk.includes(token)); assert.ok(!disk.includes('correct horse'));
  assert.equal(fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777, 0o600);
  const reopened = new Accounts(dir, { now: () => time });
  assert.equal(reopened.authenticate(token).id, user.id);
  reopened.logout(token); assert.equal(reopened.authenticate(token), null);
  const next = reopened.session(user); time += 15 * 86400_000;
  assert.equal(reopened.authenticate(next), null);
  await assert.rejects(accounts.register('<script>', 'correct horse battery staple'), /username/);
  await assert.rejects(accounts.register('short', 'short'), /at least 12/);
});

test('parallel registration cannot duplicate a username or exceed account capacity', async t => {
  const accounts = new Accounts(temporary(t), { maxAccounts: 1 });
  const results = await Promise.allSettled([accounts.register('alice', 'correct horse battery staple'), accounts.register('alice', 'another long password')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(accounts.state.accounts.length, 1);
  await assert.rejects(accounts.register('other', 'another long password'), /capacity/);
});

test('corrupt accounts fail closed and rate-limit storage is bounded', t => {
  const dir = temporary(t); fs.writeFileSync(path.join(dir, 'accounts.json'), '{bad');
  assert.throws(() => new Accounts(dir));
  let now = 0;
  const limits = new RateLimit({ now: () => now, maxEntries: 2 });
  assert.equal(limits.take('a', 1, 100), true); assert.equal(limits.take('a', 1, 100), false);
  assert.equal(limits.take('b', 1, 100), true); assert.equal(limits.take('c', 1, 100), false);
  now = 101; assert.equal(limits.take('c', 1, 100), true);
});

test('real HTTP gateway isolates two accounts, rejects spoofing, persists routing and revokes logout', async t => {
  const dir = temporary(t);
  const servers = [];
  t.after(async () => { for (const server of servers.reverse()) await close(server); });
  const seen = [];
  const endpoints = new Map();
  const runtime = { async ensure(id) {
    if (!endpoints.has(id)) {
      const tenant = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        seen.push({ id, headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (req.url === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
          res.end(`data: ${JSON.stringify({ account: id })}\n\n`); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=100', 'Set-Cookie': 'untrusted=secret' });
        res.end(JSON.stringify({ account: id, path: req.url, body: Buffer.concat(chunks).toString() }));
      });
      servers.push(tenant); endpoints.set(id, { port: await listen(tenant) });
    }
    return endpoints.get(id);
  } };
  const accounts = new Accounts(dir);
  const source = path.join(dir, 'source.tar.gz'); fs.writeFileSync(source, 'exact corresponding source');
  const errors = [];
  const gateway = createGateway({ origin: 'https://learn.test', accounts, runtimes: runtime, sourceFile: source, logger: { error: (...args) => errors.push(args) } });
  servers.push(gateway); const port = await listen(gateway);
  assert.equal((await request(port, '/')).headers.location, '/auth/login');
  assert.equal((await request(port, '/', { headers: { 'sec-fetch-site': 'cross-site' } })).headers.location, '/auth/login', 'external links can navigate to the sign-in screen');
  assert.equal((await request(port, '/api/keys')).status, 401);
  assert.equal((await request(port, '/api/events')).status, 401);
  assert.equal((await request(port, '/', { headers: { host: 'evil.test' } })).status, 421);
  assert.equal((await request(port, '/auth/register', { ...form('alice'), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' } })).status, 403);
  const registration = await request(port, '/auth/register', form('alice'));
  assert.equal(registration.status, 303);
  assert.match(registration.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
  const aliceToken = tokenOf(registration);
  const bobToken = tokenOf(await request(port, '/auth/register', form('bobby')));
  const alice = JSON.parse((await request(port, '/api/settings', { token: aliceToken, headers: { 'x-lh-account': accounts.authenticate(bobToken).id, 'x-forwarded-host': 'evil.test', authorization: 'Bearer private-gateway-token' } })).text);
  const bob = JSON.parse((await request(port, '/api/settings', { token: bobToken })).text);
  assert.notEqual(alice.account, bob.account);
  assert.equal(alice.account, accounts.authenticate(aliceToken).id);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers['x-lh-account'], undefined);
  assert.equal(seen[0].headers['x-forwarded-host'], 'learn.test');
  assert.equal(seen[0].headers['x-forwarded-proto'], 'https');
  const privateReply = await request(port, '/chat/alice', { token: aliceToken });
  assert.equal(privateReply.headers['cache-control'], 'private, no-store');
  assert.equal(privateReply.headers['set-cookie'], undefined);
  const stream = await request(port, '/api/events', { token: bobToken });
  assert.match(stream.headers['content-type'], /text\/event-stream/); assert.ok(stream.text.includes(bob.account)); assert.ok(!stream.text.includes(alice.account));
  const saved = await request(port, '/api/settings/models', { method: 'PUT', token: aliceToken, headers: { origin: 'https://learn.test', 'content-type': 'application/json', 'x-learnharness-subscriptions': '1' }, body: '{"model":"my choice"}' });
  assert.equal(JSON.parse(saved.text).body, '{"model":"my choice"}');
  assert.equal(seen.at(-1).headers['x-learnharness-subscriptions'], '1');
  assert.equal((await request(port, '/api/settings', { method: 'PUT', token: bobToken, body: '{}' })).status, 403);
  assert.equal((await request(port, '/api/settings', { token: aliceToken, headers: { cookie: `__Host-learn_session=${aliceToken}; __Host-learn_session=${bobToken}` } })).status, 401);
  assert.equal((await request(port, '/source')).text, 'exact corresponding source');
  const account = await request(port, '/auth/account', { token: aliceToken }); assert.match(account.text, /alice/);
  assert.equal((await request(port, '/auth/logout', { token: aliceToken })).status, 405);
  assert.equal((await request(port, '/auth/logout', { method: 'POST', token: aliceToken, headers: { origin: 'https://learn.test' } })).status, 303);
  assert.equal((await request(port, '/api/settings', { token: aliceToken })).status, 401);
  assert.equal((await request(port, '/api/settings', { token: bobToken })).status, 200);
  const login = await request(port, '/auth/login', form('alice'));
  assert.equal(accounts.authenticate(tokenOf(login)).id, alice.account);
  assert.equal((await request(port, '/auth/login', form('alice', 'wrong'))).status, 401);
  assert.deepEqual(errors, []);
});

test('gateway rejects oversized forms and limits public registrations', async t => {
  const accounts = new Accounts(temporary(t));
  const gateway = createGateway({ origin: 'https://learn.test', accounts, runtimes: { ensure() { throw new Error('must not start'); } } });
  const port = await listen(gateway); t.after(() => close(gateway));
  const large = { ...form('large'), body: `username=large&password=${'x'.repeat(9000)}` };
  assert.equal((await request(port, '/auth/register', large)).status, 400);
  assert.equal((await request(port, '/auth/register', form('one'))).status, 303);
  assert.equal((await request(port, '/auth/register', form('two'))).status, 303);
  assert.equal((await request(port, '/auth/register', form('three'))).status, 429);
});

test('idle suspension reclaims quiescent runtimes and resumes on the next request', async t => {
  const accounts = new Accounts(temporary(t));
  const account = await accounts.register('idle_user', 'correct horse battery staple');
  const token = accounts.session(account);
  const tenant = http.createServer((_request, response) => response.end('private app'));
  const tenantPort = await listen(tenant); t.after(() => close(tenant));
  const ensured = [], suspended = [];
  const gateway = createGateway({ origin: 'https://learn.test', accounts, idleMs: 0, runtimes: {
    async ensure(id) { ensured.push(id); return { port: tenantPort }; },
    async suspend(id) { suspended.push(id); return true; },
  } });
  const port = await listen(gateway); t.after(() => close(gateway));
  assert.equal((await request(port, '/api/host-runtime', { token })).status, 404);
  assert.equal((await request(port, '/', { token })).text, 'private app');
  await gateway.sweepIdle();
  assert.deepEqual(suspended, [account.id]);
  assert.equal((await request(port, '/', { token })).text, 'private app');
  assert.deepEqual(ensured, [account.id, account.id]);
});

test('an open event stream prevents idle suspension and logout closes that stream', async t => {
  const accounts = new Accounts(temporary(t));
  const account = await accounts.register('stream_user', 'correct horse battery staple');
  const token = accounts.session(account);
  let tenantClosed;
  const closed = new Promise(resolve => { tenantClosed = resolve; });
  const tenant = http.createServer((_request, response) => { response.on('close', tenantClosed); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); });
  const tenantPort = await listen(tenant); t.after(() => close(tenant));
  let stops = 0;
  const gateway = createGateway({ origin: 'https://learn.test', accounts, idleMs: 0, logger: { error() {} }, runtimes: {
    async ensure() { return { port: tenantPort }; }, async suspend() { stops++; return true; },
  } });
  const port = await listen(gateway); t.after(() => close(gateway));
  const stream = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events', headers: { host: 'learn.test', cookie: `__Host-learn_session=${token}` } }, resolve);
    req.on('error', reject);
  });
  stream.resume();
  await gateway.sweepIdle(); assert.equal(stops, 0);
  const ended = new Promise(resolve => stream.on('close', resolve));
  await request(port, '/auth/logout', { token, method: 'POST', headers: { origin: 'https://learn.test' } });
  await ended;
  await closed;
  await new Promise(resolve => setImmediate(resolve));
  await gateway.sweepIdle(); assert.equal(stops, 1);
});

test('operator password recovery revokes old sessions while retaining account identity', async t => {
  const accounts = new Accounts(temporary(t));
  const account = await accounts.register('recover_user', 'correct horse battery staple');
  const token = accounts.session(account);
  await accounts.resetPassword('recover_user', 'a different long replacement password');
  assert.equal(accounts.authenticate(token), null);
  assert.equal(await accounts.login('recover_user', 'correct horse battery staple'), null);
  assert.equal((await accounts.login('recover_user', 'a different long replacement password')).id, account.id);
});

test('release symlink entrypoint starts and shuts down cleanly', async t => {
  const directory = temporary(t);
  const link = path.join(directory, 'current-gateway.mjs');
  fs.symlinkSync(new URL('./gateway.mjs', import.meta.url), link);
  const child = spawn(process.execPath, [link], { env: { ...process.env, LH_GATEWAY_STATE: path.join(directory, 'accounts'), LH_PUBLIC_ORIGIN: 'https://learn.test', LH_GATEWAY_PORT: '0', LH_TENANT_IMAGE: 'learnharness:test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway symlink entrypoint did not start.')), 5000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('gateway listening')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Gateway exited before listening: ${code}`)); });
    child.once('error', reject);
  });
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
});
