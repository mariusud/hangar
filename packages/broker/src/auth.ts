// Tokens, built-in accounts and sessions. Tokens are opaque, shown once, and stored as SHA-256.

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Account, Db, TokenRow } from './db.ts';

const scryptAsync = promisify(scrypt);

export type Principal = {
  accountId: string;
  name: string;
  role: Account['role'];
  scopes: string[];
};

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function secret(kind: string): string {
  return `hgr_${kind}_${randomBytes(20).toString('base64url')}`;
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
  const key = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split(':');
  if (!salt || !key) {
    return false;
  }
  const expected = Buffer.from(key, 'base64');
  const actual = (await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length)) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function createAccount(db: Db, name: string, role: Account['role']): Account {
  const account: Account = { id: randomUUID(), name, role, passwordHash: null };
  db.insertAccount(account);
  return account;
}

export const SESSION_COOKIE = 'hangar_session';
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

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      return v.join('=');
    }
  }
  return null;
}

// Resolves the caller from a bearer token or the console session cookie.
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
    const account = db.getAccount(token.accountId);
    const scopes = account?.role === 'operator' ? ['install:upload', ...token.scopes] : token.scopes;
    return account ? { accountId: account.id, name: account.name, role: account.role, scopes } : null;
  }
  const session = readCookie(headers.cookie, SESSION_COOKIE);
  if (session) {
    const accountId = db.sessionAccount(sha256(session), now);
    const account = accountId ? db.getAccount(accountId) : null;
    // Uploading an app runs code on the host, so in the console only operators may do it.
    const scopes = account?.role === 'operator' ? ['install:upload'] : [];
    return account ? { accountId: account.id, name: account.name, role: account.role, scopes } : null;
  }
  return null;
}
