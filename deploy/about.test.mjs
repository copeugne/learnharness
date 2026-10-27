import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { loadAbout } from './about.mjs';
import { Accounts } from './accounts.mjs';
import { createGateway } from './gateway.mjs';
const directory = path.resolve(import.meta.dirname, '../public/about-site');

test('original About assets are served publicly without starting a learning runtime', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-about-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const gateway = createGateway({ origin: 'https://learn.test', accounts: new Accounts(temporary), aboutDirectory: directory, runtimes: { ensure() { throw new Error('About must not start a runtime'); } } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); return new Promise(resolve => gateway.close(resolve)); });
  const port = gateway.address().port;
  async function get(route, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: route, headers: { host: 'learn.test', ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      }); request.on('error', reject);
    });
  }
  for (const [route, asset] of loadAbout(directory)) {
    const response = await get(route);
    assert.equal(response.status, 200); assert.deepEqual(response.body, asset.body);
    assert.equal(response.headers['content-type'], asset.type);
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal((await get(route, { 'if-none-match': response.headers.etag })).status, 304);
  }
  assert.equal((await get('/about')).headers.location, '/about/');
  assert.equal((await get('/about-site/../../auth/login')).status, 200);
});

test('About deployment fails if a captured asset differs from its recorded hash', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-about-integrity-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.cpSync(directory, temporary, { recursive: true });
  fs.appendFileSync(path.join(temporary, 'styles.css'), '\n/* unexpected mutation */');
  assert.throws(() => loadAbout(temporary), /hash mismatch/);
});
