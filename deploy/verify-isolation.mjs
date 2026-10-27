import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Accounts } from './accounts.mjs';
import { Runtimes } from './runtimes.mjs';
import { createGateway } from './gateway.mjs';
const execute = promisify(execFile);
const root = process.env.LH_QA_STATE;
assert(root?.startsWith('/var/lib/learnharness-gateway/qa-'), 'Use a dedicated disposable QA state directory.');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const accounts = new Accounts(root, { maxAccounts: 2 });
const runtimes = new Runtimes({ image: process.env.LH_TENANT_IMAGE });
const origin = 'https://learn.nix.zone';
const gateway = createGateway({ origin, accounts, runtimes, idleMs: 0 });
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
const port = gateway.address().port;
const report = { host: os.hostname(), image: process.env.LH_TENANT_IMAGE, checks: [], accounts: [] };
let canary;
function progress(name) { report.checks.push(name); console.log(`[isolation] ${Math.round(report.checks.length / 12 * 100)}% (${report.checks.length}/12) ${name}`); }
async function request(route, { token, method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { host: 'learn.nix.zone', ...(token ? { cookie: `__Host-learn_session=${token}` } : {}), ...(body ? { origin, 'content-type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json() { return JSON.parse(text); } }); });
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
}
async function command(name, source, args = []) {
  const { stdout } = await execute('docker', ['exec', name, 'node', '--input-type=module', '-e', source, ...args], { timeout: 30000, maxBuffer: 16384 });
  return stdout.trim();
}
try {
  assert.equal((await request('/api/chats')).status, 401);
  progress('Unauthenticated API requests refused');
  const identities = [];
  for (const username of ['isolation_alice', 'isolation_bob']) {
    let account = accounts.state.accounts.find(user => user.username === username);
    if (!account) account = await accounts.register(username, 'Synthetic fixture password, never a real provider key.');
    const token = accounts.session(account);
    const endpoint = await runtimes.ensure(account.id);
    identities.push({ account, token, endpoint });
    report.accounts.push({ id: account.id, name: endpoint.name });
  }
  const [alice, bob] = identities;
  progress('Two real private ARM64 application containers started');
  for (const user of identities) {
    assert.equal((await fetch(`http://127.0.0.1:${user.endpoint.port}/`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${user.endpoint.port}/api/keys`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${user.endpoint.port}/api/settings`, { headers: { 'x-learnharness-web': identities.find(other => other !== user).endpoint.secret } })).status, 403);
    assert.equal((await request('/', { token: user.token })).status, 200);
  }
  progress('Direct and wrong-account runtime capabilities refused on pages and APIs');
  const chatA = await request('/api/chats', { token: alice.token, method: 'POST', body: JSON.stringify({ title: 'Alice private teaching record' }) });
  const chatB = await request('/api/chats', { token: bob.token, method: 'POST', body: JSON.stringify({ title: 'Bob private practice record', kind: 'practice' }) });
  assert.equal(chatA.status, 200); assert.equal(chatB.status, 200);
  const aID = chatA.json().id ?? chatA.json().chat?.id;
  const bID = chatB.json().id ?? chatB.json().chat?.id;
  assert(aID && bID);
  assert(!(await request('/api/chats', { token: bob.token })).text.includes('Alice private'));
  assert(!(await request('/api/chats', { token: alice.token })).text.includes('Bob private'));
  assert.equal((await request(`/api/chats/${aID}`, { token: bob.token })).status, 404);
  assert.equal((await request(`/api/chats/${bID}`, { token: alice.token })).status, 404);
  progress('Teaching/practice records and guessed chat IDs isolated');
  const setting = await request('/api/settings/general', { token: alice.token, method: 'PUT', body: '{"autoUpdate":false}' });
  assert.equal(setting.status, 200);
  assert((await request('/api/settings', { token: alice.token })).text.includes('autoUpdate'));
  assert(!(await request('/api/settings', { token: bob.token })).text.includes('autoUpdate'));
  const status = await request('/api/subscriptions', { token: alice.token, headers: { 'x-learnharness-subscriptions': '1' } });
  assert.equal(status.status, 200);
  progress('Private settings and web subscription same-origin controls work through gateway');
  await command(alice.endpoint.name, 'import fs from "node:fs";fs.writeFileSync(process.env.HOME+"/alice-only.txt","private Alice fixture");console.log("written")');
  const inaccessible = await command(bob.endpoint.name, 'import fs from "node:fs";const paths=[process.env.HOME+"/alice-only.txt", process.argv[1], "/var/run/docker.sock", "/var/lib/learnharness-gateway/accounts.json"];for(const p of paths){try{fs.readFileSync(p);throw Error("Unexpected access: "+p)}catch(e){if(!["ENOENT","EACCES"].includes(e.code))throw e}}console.log("isolated")', [`/srv/learnharness/tenants/${alice.account.id}/alice-only.txt`]);
  assert.equal(inaccessible, 'isolated');
  progress('Other learner files, host credential store and Docker socket inaccessible');
  canary = http.createServer((_request, response) => response.end('private host canary'));
  canary.listen(0, '172.30.88.1'); await once(canary, 'listening');
  const canaryURL = `http://172.30.88.1:${canary.address().port}/`;
  assert.equal(await (await fetch(canaryURL)).text(), 'private host canary');
  const network = await command(alice.endpoint.name, 'const hosts=["http://169.254.169.254/", process.argv[2], "http://10.0.0.1/", process.argv[1]];for(const url of hosts){let failed=false;try{await fetch(url,{signal:AbortSignal.timeout(1500)})}catch{failed=true}if(!failed)throw Error("Private network reachable: "+url)}const r=await fetch("https://example.com",{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error("Public egress failed");console.log("isolated; public HTTPS works")', [`http://learn-user-${bob.account.id}:3000/`, canaryURL]);
  assert.equal(network, 'isolated; public HTTPS works');
  progress('Metadata, host, private network and sibling traffic blocked; public HTTPS works');
  const quota = await command(alice.endpoint.name, 'import fs from "node:fs";import {constants} from "node:os";const p=process.env.HOME+"/quota-test.bin";let limited=false;const fd=fs.openSync(p,"w");try{const block=Buffer.alloc(1024*1024);for(let i=0;i<100;i++)fs.writeSync(fd,block)}catch(e){if(e.code!=="EDQUOT" && e.errno!==-constants.errno.EDQUOT)throw e;limited=true}finally{fs.closeSync(fd);fs.unlinkSync(p)}if(!limited)throw Error("Disk quota was not enforced");console.log("EDQUOT enforced")');
  assert.equal(quota, 'EDQUOT enforced');
  progress('96 MiB per-user disk quota enforced by real kernel writes');
  const chromium = await command(alice.endpoint.name, 'import puppeteer from "puppeteer-core";const b=await puppeteer.launch({executablePath:"/usr/bin/chromium",headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});try{const p=await b.newPage();await p.setContent("<h1>Verified demo</h1><script>document.body.dataset.ready=String(6*7)</script>");if(await p.evaluate(()=>document.body.dataset.ready)!=="42")throw Error("Demo script failed");const png=await p.screenshot();if(png.length<1000)throw Error("No screenshot");console.log("Chromium executes and screenshots demos")}finally{await b.close()}');
  assert.equal(chromium, 'Chromium executes and screenshots demos');
  await execute('docker', ['restart', alice.endpoint.name], { timeout: 60000 });
  await runtimes.ensure(alice.account.id);
  assert((await request('/api/chats', { token: alice.token })).text.includes('Alice private'));
  progress('Real Chromium demo execution succeeds; private records survive runtime restart');
  const boundary = 'learn-isolation-boundary';
  const fixture = 'Private uploaded notes: λ and exact bytes.\n';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n${fixture}\r\n--${boundary}--\r\n`);
  const upload = await request('/api/files', { token: alice.token, method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(upload.status, 200);
  const file = upload.json().uploaded[0];
  assert.equal((await request(`/api/files/${file.id}`, { token: alice.token })).text, fixture);
  assert.equal((await request(`/api/files/${file.id}`, { token: bob.token })).status, 404);
  assert(!(await request('/api/files', { token: bob.token })).text.includes(file.id));
  const read = await command(alice.endpoint.name, 'import fs from "node:fs";console.log(fs.readFileSync(process.argv[1],"utf8"))', [file.path]);
  assert.equal(read, fixture.trim());
  progress('Private uploads preserve exact bytes and tool-readable paths; sibling IDs refused');
  assert.equal((await request('/api/host-runtime', { token: alice.token })).status, 404);
  await gateway.sweepIdle();
  const stopped = await execute('docker', ['inspect', '--format', '{{.State.Running}}', alice.endpoint.name]);
  assert.equal(stopped.stdout.trim(), 'false');
  assert.equal((await request(`/api/files/${file.id}`, { token: alice.token })).text, fixture);
  assert.equal((await request(`/api/files/${file.id}`, { token: alice.token, method: 'DELETE', headers: { origin } })).status, 200);
  assert.equal((await request(`/api/files/${file.id}`, { token: alice.token })).status, 404);
  progress('Gateway idle suspension and authenticated resume preserve records and uploads');
  accounts.logout(alice.token);
  assert.equal((await request('/api/chats', { token: alice.token })).status, 401);
  assert.equal((await request('/api/chats', { token: bob.token })).status, 200);
  progress('Logout revokes access without affecting the other account');
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
  canary?.closeAllConnections();
  if (canary) await new Promise(resolve => canary.close(resolve));
}
