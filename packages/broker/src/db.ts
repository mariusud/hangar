// SQLite storage. The partial unique index on leases is what makes double-leasing impossible:
// a scheduler bug fails the write instead of handing one device to two leases.

import { DatabaseSync } from 'node:sqlite';
import type { Lease } from './leases/machine.ts';

const SCHEMA = `
create table if not exists accounts (
  id text primary key,
  name text not null,
  role text not null,
  password_hash text,
  created_at integer not null
);
create table if not exists tokens (
  hash text primary key,
  kind text not null,
  account_id text,
  lease_id text,
  label text,
  scopes text not null default '',
  expires_at integer,
  used_at integer,
  created_at integer not null
);
create table if not exists sessions (
  hash text primary key,
  account_id text not null,
  expires_at integer not null
);
create table if not exists leases (
  id text primary key,
  state text not null,
  device_id text,
  principal_id text not null,
  data text not null
);
create unique index if not exists one_live_lease_per_device
  on leases(device_id) where state in ('preparing', 'active');
create index if not exists leases_by_state on leases(state);
create table if not exists builds (
  sha256 text primary key,
  name text not null,
  path text not null,
  size integer not null,
  created_at integer not null
);
create table if not exists audit (
  at integer not null,
  principal_id text,
  lease_id text,
  event text not null
);
`;

export type Account = { id: string; name: string; role: 'member' | 'operator'; passwordHash: string | null };
export type TokenRow = {
  hash: string;
  kind: 'member' | 'host' | 'stream' | 'join' | 'welcome' | 'invite' | 'artifact';
  accountId: string | null;
  leaseId: string | null;
  label: string | null;
  scopes: string[];
  expiresAt: number | null;
  usedAt: number | null;
};

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
    this.sql.exec(SCHEMA);
  }

  // Leases

  insertLease(lease: Lease): void {
    this.sql
      .prepare('insert into leases (id, state, device_id, principal_id, data) values (?, ?, ?, ?, ?)')
      .run(lease.id, lease.state, lease.deviceId, lease.principalId, JSON.stringify(lease));
  }

  updateLease(lease: Lease): void {
    this.sql
      .prepare('update leases set state = ?, device_id = ?, data = ? where id = ?')
      .run(lease.state, lease.deviceId, JSON.stringify(lease), lease.id);
  }

  getLease(id: string): Lease | null {
    const row = this.sql.prepare('select data from leases where id = ?').get(id);
    return row ? parseLease(row) : null;
  }

  leasesIn(states: Lease['state'][]): Lease[] {
    const marks = states.map(() => '?').join(', ');
    return this.sql.prepare(`select data from leases where state in (${marks})`).all(...states).map(parseLease);
  }

  leasesOf(principalId: string, limit = 50): Lease[] {
    return this.sql
      .prepare('select data from leases where principal_id = ? order by rowid desc limit ?')
      .all(principalId, limit)
      .map(parseLease);
  }

  // Every device a lease ever held. Agents replace a used device with a fresh clone under a new
  // id, so an id in this set is never handed out again.
  usedDeviceIds(): Set<string> {
    const rows = this.sql.prepare('select distinct device_id from leases where device_id is not null').all();
    return new Set(rows.map((r) => String(r.device_id)));
  }

  recentLeases(limit = 100): Lease[] {
    return this.sql.prepare('select data from leases order by rowid desc limit ?').all(limit).map(parseLease);
  }

  // Accounts

  insertAccount(a: Account): void {
    this.sql
      .prepare('insert into accounts (id, name, role, password_hash, created_at) values (?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.role, a.passwordHash, Date.now());
  }

  getAccount(id: string): Account | null {
    const row = this.sql.prepare('select id, name, role, password_hash from accounts where id = ?').get(id);
    return row ? toAccount(row) : null;
  }

  accountByName(name: string): Account | null {
    const row = this.sql.prepare('select id, name, role, password_hash from accounts where name = ? collate nocase').get(name);
    return row ? toAccount(row) : null;
  }

  accounts(): Account[] {
    return this.sql.prepare('select id, name, role, password_hash from accounts order by created_at').all().map(toAccount);
  }

  setPassword(id: string, hash: string): void {
    this.sql.prepare('update accounts set password_hash = ? where id = ?').run(hash, id);
  }

  // Tokens and sessions

  insertToken(t: TokenRow): void {
    this.sql
      .prepare(
        'insert into tokens (hash, kind, account_id, lease_id, label, scopes, expires_at, used_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.hash, t.kind, t.accountId, t.leaseId, t.label, t.scopes.join(' '), t.expiresAt, t.usedAt, Date.now());
  }

  getToken(hash: string): TokenRow | null {
    const row = this.sql.prepare('select * from tokens where hash = ?').get(hash);
    if (!row) {
      return null;
    }
    return {
      hash: String(row.hash),
      kind: String(row.kind) as TokenRow['kind'],
      accountId: row.account_id === null ? null : String(row.account_id),
      leaseId: row.lease_id === null ? null : String(row.lease_id),
      label: row.label === null ? null : String(row.label),
      scopes: String(row.scopes).split(' ').filter(Boolean),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
    };
  }

  // Marks a one-use token used. Returns false if it was already used, so two racing requests
  // cannot both spend it.
  useToken(hash: string, now: number): boolean {
    const r = this.sql.prepare('update tokens set used_at = ? where hash = ? and used_at is null').run(now, hash);
    return r.changes === 1;
  }

  tokensOf(accountId: string): TokenRow[] {
    return this.sql
      .prepare("select hash from tokens where account_id = ? and kind = 'member'")
      .all(accountId)
      .map((r) => this.getToken(String(r.hash)))
      .filter((t): t is TokenRow => t !== null);
  }

  deleteToken(hash: string): void {
    this.sql.prepare('delete from tokens where hash = ?').run(hash);
  }

  insertSession(hash: string, accountId: string, expiresAt: number): void {
    this.sql.prepare('insert into sessions (hash, account_id, expires_at) values (?, ?, ?)').run(hash, accountId, expiresAt);
  }

  sessionAccount(hash: string, now: number): string | null {
    const row = this.sql.prepare('select account_id from sessions where hash = ? and expires_at > ?').get(hash, now);
    return row ? String(row.account_id) : null;
  }

  deleteSession(hash: string): void {
    this.sql.prepare('delete from sessions where hash = ?').run(hash);
  }

  // Builds

  insertBuild(sha256: string, name: string, path: string, size: number): void {
    this.sql
      .prepare('insert or ignore into builds (sha256, name, path, size, created_at) values (?, ?, ?, ?, ?)')
      .run(sha256, name, path, size, Date.now());
  }

  getBuild(ref: string): { sha256: string; name: string; path: string; size: number } | null {
    const row = this.sql
      .prepare('select sha256, name, path, size from builds where sha256 = ? or name = ? order by created_at desc limit 1')
      .get(ref, ref);
    return row ? { sha256: String(row.sha256), name: String(row.name), path: String(row.path), size: Number(row.size) } : null;
  }

  builds(): { sha256: string; name: string; size: number }[] {
    return this.sql
      .prepare('select sha256, name, size from builds order by created_at desc')
      .all()
      .map((r) => ({ sha256: String(r.sha256), name: String(r.name), size: Number(r.size) }));
  }

  audit(event: string, principalId: string | null, leaseId: string | null): void {
    this.sql.prepare('insert into audit (at, principal_id, lease_id, event) values (?, ?, ?, ?)').run(Date.now(), principalId, leaseId, event);
  }
}

function parseLease(row: Record<string, unknown>): Lease {
  return JSON.parse(String(row.data)) as Lease;
}

function toAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role) as Account['role'],
    passwordHash: row.password_hash === null ? null : String(row.password_hash),
  };
}
