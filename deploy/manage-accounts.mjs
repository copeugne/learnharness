import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Accounts } from './accounts.mjs';

const directory = process.env.LH_GATEWAY_STATE;
if (!directory) throw new Error('Set LH_GATEWAY_STATE to the production gateway state directory.');
const [operation, username] = process.argv.slice(2);
const accounts = new Accounts(directory);
if (operation === 'list') {
  console.log(JSON.stringify(accounts.state.accounts.map(({ id, username, created }) => ({ id, username, created })), null, 2));
} else if (operation === 'reset-password' && username) {
  const state = execFileSync('systemctl', ['show', 'learn-gateway.service', '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
  if (state !== 'inactive' && state !== 'failed') throw new Error('Stop learn-gateway.service before resetting a password, then start it again afterward.');
  if (process.stdin.isTTY) throw new Error('Read the replacement password without echo in your shell and pass it on stdin. Do not put passwords in command arguments.');
  const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  await accounts.resetPassword(username, password);
  console.log('Password replaced and all previous account sessions revoked. Start learn-gateway.service. Learning records and provider keys were preserved.');
} else throw new Error('Usage: manage-accounts.mjs list | reset-password <username> (password on stdin)');
