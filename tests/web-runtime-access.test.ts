import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy.ts';
import { webRuntimeAuthorized } from '../src/server/desktop-access.ts';

const secret = 'a'.repeat(64);
test('web runtime capability fails closed without interfering with desktop or plain local mode', () => {
  assert(webRuntimeAuthorized(new Headers(), {}));
  for (const expected of ['', 'bad', secret]) {
    assert(!webRuntimeAuthorized(new Headers(), { LH_WEB_RUNTIME_SECRET: expected }));
  }
  for (const supplied of ['bad', secret + 'b', secret + ', ' + secret]) {
    assert(!webRuntimeAuthorized(new Headers({ 'x-learnharness-web': supplied }), { LH_WEB_RUNTIME_SECRET: secret }));
  }
  assert(webRuntimeAuthorized(new Headers({ 'x-learnharness-web': secret }), { LH_WEB_RUNTIME_SECRET: secret }));
});

test('hosted proxy guards pages, assets, API methods and event streams with the same tenant capability', () => {
  const original = process.env.LH_WEB_RUNTIME_SECRET;
  process.env.LH_WEB_RUNTIME_SECRET = secret;
  try {
    for (const pathname of ['/', '/chat/private-session', '/_next/static/chunk.js', '/api/events', '/api/settings']) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        assert.equal(proxy(new NextRequest('http://learn.test' + pathname, { method })).status, 403);
        assert.equal(proxy(new NextRequest('http://learn.test' + pathname, { method, headers: { 'x-learnharness-web': secret } })).headers.get('x-middleware-next'), '1');
      }
    }
  } finally {
    if (original === undefined) delete process.env.LH_WEB_RUNTIME_SECRET; else process.env.LH_WEB_RUNTIME_SECRET = original;
  }
});
