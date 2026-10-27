import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class Runtimes {
  constructor({ image, network = 'learn-tenants', maxActive = 8, docker = 'docker', provision }) {
    if (!image || !/^[a-zA-Z0-9_./:@-]+$/.test(image)) throw new Error('Set LH_TENANT_IMAGE to the immutable application image.');
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 8) throw new Error('Active runtime capacity must be between 1 and 8.');
    this.image = image; this.network = network; this.maxActive = maxActive; this.docker = docker;
    this.provision = provision ?? (async id => {
      const { stdout } = await execute('sudo', ['-n', '/usr/local/libexec/learn-provision', id], { timeout: 10000, maxBuffer: 4096 });
      return JSON.parse(stdout);
    });
    this.queue = Promise.resolve();
  }
  async command(args) {
    const { stdout } = await execute(this.docker, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }
  ensure(id) {
    if (!UUID.test(id)) return Promise.reject(new Error('Invalid account identifier.'));
    const result = this.queue.then(() => this.start(id));
    this.queue = result.catch(() => {});
    return result.then(endpoint => this.waitReady(endpoint));
  }
  async runningIDs() {
    const names = await this.command(['ps', '--filter', 'label=zone.nix.learn.tenant=1', '--format', '{{.Names}}']);
    return names.split('\n').map(name => name.replace(/^learn-user-/, '')).filter(id => UUID.test(id));
  }
  suspend(id) {
    if (!UUID.test(id)) return Promise.reject(new Error('Invalid account identifier.'));
    const result = this.queue.then(async () => {
      const name = `learn-user-${id}`;
      const inspect = JSON.parse(await this.command(['inspect', name]))[0];
      if (!inspect.State.Running) return true;
      const port = Number(inspect.NetworkSettings.Ports['3000/tcp'][0].HostPort);
      const secret = inspect.Config.Env.find(entry => entry.startsWith('LH_WEB_RUNTIME_SECRET='))?.slice('LH_WEB_RUNTIME_SECRET='.length);
      if (!/^[0-9a-f]{64}$/.test(secret ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid runtime capability or listening port.');
      const response = await fetch(`http://127.0.0.1:${port}/api/host-runtime`, { headers: { 'x-learnharness-web': secret }, signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).idle !== true) return false;
      await this.command(['stop', '--time', '30', name]);
      return true;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async start(id) {
    const name = `learn-user-${id}`;
    const listing = await this.command(['ps', '-a', '--filter', 'label=zone.nix.learn.tenant=1', '--format', '{{json .}}']);
    const containers = listing ? listing.split('\n').map(line => JSON.parse(line)) : [];
    let existing = containers.find(container => container.Names === name);
    if (existing?.State !== 'running') {
      const active = containers.filter(container => container.State === 'running').length;
      if (active >= this.maxActive) throw new Error('All learning spaces are busy. Please try again later.');
      if (existing) {
        const details = JSON.parse(await this.command(['inspect', name]))[0];
        const desired = await this.command(['image', 'inspect', '--format', '{{.Id}}', this.image]);
        if (details.Image !== desired) { await this.command(['rm', name]); existing = undefined; }
      }
      if (existing) await this.command(['start', name]);
      else {
        const { uid, directory } = await this.provision(id);
        if (!Number.isInteger(uid) || uid < 200000 || uid > 200011 || directory !== `/srv/learnharness/tenants/${id}`) throw new Error('Invalid private tenant volume.');
        await this.command([
        'run', '--detach', '--name', name, '--label', 'zone.nix.learn.tenant=1', '--label', `zone.nix.learn.account=${id}`,
        '--network', this.network, '--publish', '127.0.0.1::3000', '--init',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--memory', '1024m', '--memory-swap', '1024m', '--cpus', '2', '--pids-limit', '512',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
        '--tmpfs', `/app/.next/cache:rw,nosuid,nodev,size=128m,uid=${uid},gid=${uid}`,
        '--shm-size', '128m', '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2',
        '--volume', `${directory}:/home/node/learner:Z`,
        '--user', `${uid}:${uid}`,
        '--env', 'HOME=/home/node/learner', '--env', 'LH_DATA_DIR=/home/node/learner/data',
        '--env', 'LH_AUTH_FILE=/home/node/learner/auth.json', '--env', 'LH_IGNORE_ENV_KEYS=1',
        '--env', `LH_WEB_RUNTIME_SECRET=${randomBytes(32).toString('hex')}`,
        '--env', 'NODE_OPTIONS=--max-old-space-size=512', this.image,
        ]);
      }
    }
    const inspect = JSON.parse(await this.command(['inspect', name]))[0];
    const port = Number(inspect?.NetworkSettings?.Ports?.['3000/tcp']?.[0]?.HostPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The learning space has no private listening port.');
    const secret = inspect.Config.Env.find(entry => entry.startsWith('LH_WEB_RUNTIME_SECRET='))?.slice('LH_WEB_RUNTIME_SECRET='.length);
    if (!/^[0-9a-f]{64}$/.test(secret ?? '')) throw new Error('The learning space has no private request capability.');
    return { port, name, secret };
  }
  async waitReady({ port, name, secret }) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { 'x-learnharness-web': secret }, signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return { port, name, secret };
      } catch (error) {
        if (attempt === 59) throw new Error('The learning space could not start.', { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The learning space did not become ready.');
  }
}
