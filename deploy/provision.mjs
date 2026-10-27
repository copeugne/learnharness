#!/usr/bin/node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// This is the only privileged filesystem operation exposed to the gateway.
// Install root-owned and invoke through the exact sudoers command below.
const ROOT = '/srv/learnharness';
const POOL = path.join(ROOT, 'tenants');
const id = process.argv[2];
if (process.getuid() !== 0 || process.argv.length !== 3 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '')) throw new Error('Expected one valid account UUID, invoked by the tenant gateway.');
const mount = JSON.parse(execFileSync('/usr/bin/findmnt', ['--json', '--target', POOL, '--output', 'TARGET,OPTIONS'], { encoding: 'utf8' })).filesystems?.[0];
if (mount?.target !== POOL || !mount.options.split(',').includes('usrquota')) throw new Error('The dedicated tenant filesystem must be mounted with enforced user quotas.');
const registryFile = path.join(ROOT, 'tenant-map.json');
const registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : {};
let uid = registry[id];
if (!uid) {
  if (Object.keys(registry).length >= 12) throw new Error('The tenant storage pool is at account capacity.');
  uid = 200000 + Object.keys(registry).length;
  if (Object.values(registry).includes(uid)) throw new Error('Tenant quota identifier collision.');
  registry[id] = uid;
  const temporary = `${registryFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, registryFile);
}
if (!Number.isInteger(uid) || uid < 200000 || uid > 200011) throw new Error('Invalid tenant quota identifier.');
const directory = path.join(POOL, id);
if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) throw new Error('Tenant directory is not a real directory.');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chownSync(directory, uid, uid);
fs.chmodSync(directory, 0o700);
// 96 MiB and 5,000 inodes per learner, within a preallocated 1.5 GiB pool.
execFileSync('/usr/sbin/setquota', ['-u', String(uid), '98304', '98304', '5000', '5000', POOL]);
console.log(JSON.stringify({ uid, directory }));
