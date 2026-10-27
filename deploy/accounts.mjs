import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
const SESSION_MS = 14 * 86400_000;
const digest = value => createHash('sha256').update(value).digest('hex');
export class Accounts {
  constructor(directory, { maxAccounts = 12, now = Date.now } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'accounts.json');
    this.maxAccounts = maxAccounts;
    if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 12) throw new Error('Account capacity must be between 1 and 12 for the provisioned storage pool.');
    this.now = now;
    this.hashing = 0;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, accounts: [], sessions: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.accounts) || !Array.isArray(this.state.sessions)) throw new Error('Invalid accounts store. Restore it before starting the gateway.');
    for (const account of this.state.accounts) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(account.id) || !/^[a-z0-9_]{3,32}$/.test(account.username) || !/^[0-9a-f]{64}$/.test(account.salt) || !/^[0-9a-f]{128}$/.test(account.password)) throw new Error('Invalid account record. Restore the accounts store.');
    }
    if (new Set(this.state.accounts.map(account => account.id)).size !== this.state.accounts.length || new Set(this.state.accounts.map(account => account.username)).size !== this.state.accounts.length) throw new Error('Duplicate accounts in the account store.');
    for (const session of this.state.sessions) {
      if (!/^[0-9a-f]{64}$/.test(session.hash) || !Number.isFinite(session.expires) || !this.state.accounts.some(account => account.id === session.account)) throw new Error('Invalid session record. Restore the accounts store.');
    }
  }
  save() {
    this.state.sessions = this.state.sessions.filter(session => session.expires > this.now());
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
  async hash(password, salt) {
    if (this.hashing >= 4) throw new Error('Sign-in is busy. Try again shortly.');
    this.hashing++;
    try { return await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
    finally { this.hashing--; }
  }
  async register(username, password) {
    username = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new Error('Use 3 to 32 lowercase letters, numbers or underscores for your username.');
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('Use a password of at least 12 characters and at most 1024 bytes.');
    if (this.state.accounts.length >= this.maxAccounts) throw new Error('Registration is at capacity. Please try again later.');
    const salt = randomBytes(32).toString('hex');
    const passwordHash = (await this.hash(password, salt)).toString('hex');
    // Recheck after hashing: concurrent requests must not create duplicate users.
    if (this.state.accounts.some(account => account.username === username)) throw new Error('That username is unavailable.');
    if (this.state.accounts.length >= this.maxAccounts) throw new Error('Registration is at capacity. Please try again later.');
    const account = { id: randomUUID(), username, salt, password: passwordHash, created: this.now() };
    this.state.accounts.push(account);
    try { this.save(); } catch (error) { this.state.accounts.pop(); throw error; }
    return account;
  }
  async login(username, password) {
    username = username.trim().toLowerCase();
    if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return null;
    const account = this.state.accounts.find(entry => entry.username === username);
    const actual = await this.hash(password, account?.salt ?? '0'.repeat(64));
    if (!account || !timingSafeEqual(actual, Buffer.from(account.password, 'hex'))) return null;
    return account;
  }
  async resetPassword(username, password) {
    const account = this.state.accounts.find(entry => entry.username === username.trim().toLowerCase());
    if (!account) throw new Error('Unknown account.');
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('Use a password of at least 12 characters and at most 1024 bytes.');
    const salt = randomBytes(32).toString('hex');
    const hash = (await this.hash(password, salt)).toString('hex');
    account.salt = salt; account.password = hash;
    this.state.sessions = this.state.sessions.filter(session => session.account !== account.id);
    this.save();
  }
  session(account) {
    const token = randomBytes(32).toString('base64url');
    const own = this.state.sessions.filter(session => session.account === account.id).slice(-9);
    this.state.sessions = [...this.state.sessions.filter(session => session.account !== account.id), ...own].slice(-1023);
    this.state.sessions.push({ hash: digest(token), account: account.id, expires: this.now() + SESSION_MS });
    this.save();
    return token;
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.state.sessions.find(session => session.hash === digest(token) && session.expires > this.now());
    return session ? this.state.accounts.find(account => account.id === session.account) ?? null : null;
  }
  logout(token) {
    if (!token) return;
    this.state.sessions = this.state.sessions.filter(session => session.hash !== digest(token));
    this.save();
  }
}

export class RateLimit {
  constructor({ now = Date.now, maxEntries = 10000 } = {}) { this.entries = new Map(); this.now = now; this.maxEntries = maxEntries; }
  take(key, limit, duration) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= this.maxEntries) {
        for (const [name, value] of this.entries) if (value.until <= now) this.entries.delete(name);
        if (this.entries.size >= this.maxEntries) return false;
      }
      entry = { count: 0, until: now + duration }; this.entries.set(key, entry);
    }
    return ++entry.count <= limit;
  }
}
