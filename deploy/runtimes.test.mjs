import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Runtimes } from './runtimes.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const name = `learn-user-${id}`;
const secret = 'a'.repeat(64);
async function statusServer(t, reply) {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-learnharness-web'], secret);
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ idle: reply.idle }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
const inspection = (port, image = 'old-image') => [{ State: { Running: true }, Image: image, Config: { Env: [`LH_WEB_RUNTIME_SECRET=${secret}`] }, NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: String(port) }] } } }];

test('runtime suspension requires a positive quiescence response; busy and failed probes stay running', async t => {
  const reply = { idle: false, status: 200 };
  const port = await statusServer(t, reply);
  const runtime = new Runtimes({ image: 'learnharness:test' });
  let stops = 0;
  runtime.command = async args => {
    if (args[0] === 'inspect') return JSON.stringify(inspection(port));
    if (args[0] === 'stop') { stops++; return name; }
    throw new Error('Unexpected command');
  };
  assert.equal(await runtime.suspend(id), false); assert.equal(stops, 0);
  reply.idle = true; reply.status = 503;
  assert.equal(await runtime.suspend(id), false); assert.equal(stops, 0);
  reply.status = 200;
  assert.equal(await runtime.suspend(id), true); assert.equal(stops, 1);
});

test('a stopped old image is replaced while preserving the same private quota directory', async t => {
  const port = await statusServer(t, { idle: true });
  const calls = [];
  let replaced = false;
  const runtime = new Runtimes({ image: 'learnharness:new', provision: async account => ({ uid: 200000, directory: `/srv/learnharness/tenants/${account}` }) });
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === 'ps') return JSON.stringify({ Names: name, State: 'exited' });
    if (args[0] === 'image') return 'new-image';
    if (args[0] === 'rm') return name;
    if (args[0] === 'run') { replaced = true; return 'container-id'; }
    if (args[0] === 'inspect') return JSON.stringify(inspection(port, replaced ? 'new-image' : 'old-image'));
    throw new Error('Unexpected command');
  };
  assert.equal((await runtime.ensure(id)).port, port);
  assert(calls.some(args => args[0] === 'rm' && args[1] === name));
  const run = calls.find(args => args[0] === 'run');
  assert(run.includes(`/srv/learnharness/tenants/${id}:/home/node/learner:Z`));
  for (const flag of ['--read-only', '--cap-drop', '--memory', '--pids-limit', '--user']) assert(run.includes(flag));
  assert(!calls.some(args => args.includes('--volumes')), 'image replacement never removes learner storage');
});

test('runtime controller rejects untrusted image names, IDs and capacities before invoking a command', async () => {
  assert.throws(() => new Runtimes({ image: 'image; shell' }));
  assert.throws(() => new Runtimes({ image: 'valid', maxActive: NaN }));
  const runtime = new Runtimes({ image: 'valid' });
  runtime.command = async () => { throw new Error('Must not invoke Docker'); };
  await assert.rejects(runtime.ensure('../other-user'), /identifier/);
  await assert.rejects(runtime.suspend('not-an-account'), /identifier/);
});

test('a cold readiness wait does not block another tenant and container mutations remain serialized', async () => {
  const runtime = new Runtimes({ image: 'learnharness:test' });
  const other = '00000000-0000-4000-8000-000000000002';
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  let mutations = 0;
  runtime.start = async account => {
    assert.equal(mutations++, 0);
    await Promise.resolve();
    mutations--;
    return { name: account };
  };
  runtime.waitReady = async endpoint => {
    if (endpoint.name === id) { entered(); await pending; }
    return endpoint;
  };
  const cold = runtime.ensure(id);
  await waiting;
  assert.equal((await runtime.ensure(other)).name, other);
  release(); await cold;
});
