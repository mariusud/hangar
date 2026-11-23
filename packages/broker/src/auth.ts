
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Account, Db, TokenLimitRow, TokenRow } from './db.ts';
import { ApiError } from './leases/service.ts';

const SCRYPT_PARALLEL = 4;
const SCRYPT_QUEUE = 32;
let scryptRunning = 0;
const scryptWaiting: (() => void)[] = [];

async function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  if (scryptRunning < SCRYPT_PARALLEL) {
    scryptRunning += 1;
  } else {
    if (scryptWaiting.length >= SCRYPT_QUEUE) {
      throw new ApiError(429, 'BUSY', 'Too many sign-ins are being checked at once.', 'Try again in a few seconds.');
    }
    await new Promise<void>((resolve) => scryptWaiting.push(resolve));
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, keyLength, (err, key) => (err ? reject(err) : resolve(key)));
    });
  } finally {
    const next = scryptWaiting.shift();
    if (next) {
      next();
    } else {
      scryptRunning -= 1;
    }
  }
}

export type LimiterOptions = { maxFailures: number; windowMs: number; blockMs: number; maxEntries: number };
type Attempts = { failures: number[]; blockedUntil: number };

export class AttemptLimiter {
  private readonly entries = new Map<string, Attempts>();
  private readonly now: () => number;
  private readonly opts: LimiterOptions;

  constructor(now: () => number = Date.now, opts: Partial<LimiterOptions> = {}) {
    this.now = now;
    this.opts = { maxFailures: 5, windowMs: 10 * 60_000, blockMs: 60_000, maxEntries: 10_000, ...opts };
  }

  assertOpen(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const blockedUntil = this.entries.get(key)?.blockedUntil ?? 0;
      if (blockedUntil > now) {
        const seconds = Math.ceil((blockedUntil - now) / 1000);
        throw new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many attempts. Wait ${seconds} seconds and try again.`, 'Attempts are counted per account name and per address.');
      }
    }
  }

  fail(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { failures: [], blockedUntil: 0 };
      entry.failures = entry.failures.filter((t) => t > now - this.opts.windowMs);
      entry.failures.push(now);
      if (entry.failures.length >= this.opts.maxFailures) {
        entry.failures = [];
        entry.blockedUntil = now + this.opts.blockMs;
      }
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  clear(keys: string[]): void {
    for (const key of keys) {
      this.entries.delete(key);
    }
  }
}

const limiters = new WeakMap<Db, { login: AttemptLimiter; oidc: AttemptLimiter }>();

export function limitersFor(db: Db): { login: AttemptLimiter; oidc: AttemptLimiter } {
  let found = limiters.get(db);
  if (!found) {
    found = { login: new AttemptLimiter(), oidc: new AttemptLimiter(Date.now, { maxFailures: 30 }) };
    limiters.set(db, found);
  }
  return found;
}

export function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

export const DUMMY_HASH = `scrypt:${Buffer.alloc(16).toString('base64')}:${Buffer.alloc(32).toString('base64')}`;

export type Principal = {
  accountId: string;
  name: string;
  role: Account['role'];
  scopes: string[];
  leaseId?: string;
  token?: { hash: string } & TokenLimitRow;
};

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function secret(kind: string): string {
  return `dp_${kind}_${randomBytes(20).toString('base64url')}`;
}

export function mintToken(
  db: Db,
  kind: TokenRow['kind'],
  fields: Partial<Omit<TokenRow, 'hash' | 'kind'>> = {},
): string {
  const value = secret(kind);
  db.insertToken({
    hash: sha256(value),
    kind,
    accountId: fields.accountId ?? null,
    leaseId: fields.leaseId ?? null,
    label: fields.label ?? null,
    scopes: fields.scopes ?? [],
    expiresAt: fields.expiresAt ?? null,
    usedAt: null,
  });
  return value;
}

export function lookupToken(db: Db, value: string, now: number): TokenRow | null {
  const row = db.getToken(sha256(value));
  if (!row || (row.expiresAt !== null && row.expiresAt <= now)) {
    return null;
  }
  return row;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split(':');
  if (!salt || !key) {
    return false;
  }
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function createAccount(db: Db, name: string, role: Account['role'], passwordHash: string | null = null): Account {
  const account: Account = { id: randomUUID(), name, role, passwordHash };
  db.insertAccount(account);
  return account;
}

export const SESSION_COOKIE = 'devicepool_session';
const SESSION_MS = 30 * 24 * 60 * 60_000;

export function startSession(db: Db, accountId: string, now: number): string {
  const value = randomBytes(32).toString('base64url');
  db.insertSession(sha256(value), accountId, now + SESSION_MS);
  return value;
}

export function sessionCookie(value: string, secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_MS / 1000}`];
  if (secure) {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export const STATE_COOKIE = 'devicepool_oidc_state';

export function stateCookie(value: string, secure: boolean, maxAge = 600): string {
  const attrs = [`${STATE_COOKIE}=${value}`, 'Path=/v1/oidc', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export function isSecureRequest(req: IncomingMessage, publicUrl: string): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim().toLowerCase();
  return publicUrl.startsWith('https') || proto === 'https';
}

export function assertSameOrigin(req: IncomingMessage, publicUrl: string, isUpgrade = false): void {
  const method = req.method ?? 'GET';
  if (!isUpgrade && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')) {
    return;
  }
  if (/^Bearer .+/.test(req.headers.authorization ?? '') || !readCookie(req.headers.cookie, SESSION_COOKIE)) {
    return;
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    return;
  }
  let isSame = false;
  try {
    isSame = new URL(origin).host === req.headers.host || new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    isSame = false;
  }
  if (!isSame) {
    throw new ApiError(403, 'CROSS_ORIGIN', `This request came from ${origin}, which is not this Devicepool.`, 'Use the console at the Devicepool address, or send a bearer token instead of the session cookie.');
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      return v.join('=');
    }
  }
  return null;
}

export function authenticate(
  db: Db,
  headers: { authorization?: string; cookie?: string },
  now: number,
): Principal | null {
  const bearer = headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    const token = lookupToken(db, bearer, now);
    if (!token || token.kind !== 'member' || !token.accountId) {
      return null;
    }
    if (token.leaseId && db.getLease(token.leaseId)?.state !== 'active') {
      return null;
    }
    const account = db.getAccount(token.accountId);
    const role = account?.role === 'operator' && token.scopes.includes('operator') ? 'operator' : 'member';
    const limits = db.tokenLimits(token.hash) ?? { agent: false, idleMs: null, maxMs: null, graceMs: null };
    if (!account) {
      return null;
    }
    const p: Principal = { accountId: account.id, name: account.name, role, scopes: token.scopes, token: { hash: token.hash, ...limits } };
    if (token.leaseId) {
      p.leaseId = token.leaseId;
    }
    return p;
  }
  const session = readCookie(headers.cookie, SESSION_COOKIE);
  if (session) {
    const accountId = db.sessionAccount(sha256(session), now);
    const account = accountId ? db.getAccount(accountId) : null;
    const scopes = account?.role === 'operator' ? ['install:upload'] : [];
    return account ? { accountId: account.id, name: account.name, role: account.role, scopes } : null;
  }
  return null;
}

export function canUpload(p: Principal, name: string): boolean {
  return p.scopes.some((s) => s === 'install:upload' || (s.startsWith('install:upload:') && name.startsWith(s.slice('install:upload:'.length))));
}

export function leaseTokenAllows(p: Principal, path: string): boolean {
  if (!p.leaseId) {
    return true;
  }
  const match = /^\/v1\/leases\/([^/]+)(\/.*)?$/.exec(path);
  return Boolean(match?.[1]) && decodeURIComponent(match?.[1] ?? '') === p.leaseId && match?.[2] !== '/tokens';
}
