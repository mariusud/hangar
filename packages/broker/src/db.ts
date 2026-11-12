
import { DatabaseSync } from 'node:sqlite';
import type { Lease } from './leases/machine.ts';
import type { Run } from './runs.ts';
import type { Finding } from '@hangar/protocol';

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
create table if not exists recordings (
  id text primary key,
  lease_id text not null,
  account_id text not null,
  state text not null,
  started_at integer,
  ended_at integer,
  bytes integer not null default 0,
  error text,
  device text,
  created_at integer not null
);
create index if not exists recordings_by_lease on recordings(lease_id);
create table if not exists runs (
  id text primary key,
  account_id text not null,
  data text not null
);
-- Declared device images; agents build them (milestone 4).
create table if not exists images (
  name text primary key collate nocase,
  data text not null
);
create table if not exists teams (
  id text primary key,
  name text not null unique collate nocase,
  -- Most leases the team holds at once; null is no limit.
  quota integer
);
-- An account with no row here is in the default team.
create table if not exists memberships (
  account_id text primary key,
  team_id text not null
);
-- People who sign in through OIDC, by the provider's issuer and subject.
create table if not exists identities (
  issuer text not null,
  subject text not null,
  account_id text not null,
  primary key (issuer, subject)
);
create table if not exists audit (
  at integer not null,
  principal_id text,
  lease_id text,
  event text not null
);
-- What a member token allows its leases; null is the default. No row is a token made before limits.
create table if not exists token_limits (
  hash text primary key,
  agent integer not null default 0,
  idle_ms integer,
  max_ms integer,
  grace_ms integer
);
-- The operator's caps on token limits per role (member, operator, agent); null is the built-in cap.
create table if not exists lease_limits (
  role text primary key,
  idle_ms integer,
  max_ms integer,
  grace_ms integer
);
-- What an image sets up after its apps are installed: granted permissions and a sign-in flow.
create table if not exists image_setups (
  name text primary key collate nocase,
  data text not null
);
-- Values for the environment names a sign-in flow reads. The API never returns them.
create table if not exists image_secrets (
  name text primary key,
  value text not null,
  updated_at integer not null
);
-- What a run needs to run one of its flows again: the build hashes and the flows archive.
-- Only the names of the run's environment variables are kept, never their values.
create table if not exists run_suites (
  run_id text primary key,
  data text not null
);
-- Devices a team holds for a window on given days.
create table if not exists bookings (
  id text primary key,
  name text not null unique collate nocase,
  data text not null
);
-- Devices per host, by host name, that bookings never count as theirs; no row is the default floor.
create table if not exists ci_floors (
  host_name text primary key,
  floor integer not null
);
-- A token's lease priority, and the booking it leases from; no row is interactive.
create table if not exists token_priorities (
  hash text primary key,
  priority text not null,
  booking_id text
);
-- Devices a failed run flow left as they were, by device id.
create table if not exists holds (
  device_id text primary key,
  data text not null
);
-- A finding an agent or a person filed on a lease. data is the FindingData JSON.
create table if not exists findings (
  id text primary key,
  lease_id text not null,
  account_id text not null,
  team_id text not null,
  night_id text,
  created_at integer not null,
  data text not null
);
create index if not exists findings_by_lease on findings(lease_id);
create index if not exists findings_by_night on findings(night_id);
-- One booking window: its leases, findings and runs. data holds the members frozen at close.
create table if not exists nights (
  id text primary key,
  team_id text not null,
  booking text not null collate nocase,
  state text not null,
  opened_at integer not null,
  closed_at integer,
  data text not null
);
create index if not exists nights_by_team on nights(team_id, opened_at);
`;

export const DEFAULT_TEAM = 'default';
export type Team = { id: string; name: string; quota: number | null };
export type ImageSpec = { name: string; apps: string[]; locale?: string; appearance?: 'light' | 'dark' };

export type Account = { id: string; name: string; role: 'member' | 'operator'; passwordHash: string | null };
export type TokenRow = {
  hash: string;
  kind: 'member' | 'host' | 'stream' | 'join' | 'welcome' | 'invite' | 'artifact' | 'upload';
  accountId: string | null;
  leaseId: string | null;
  label: string | null;
  scopes: string[];
  expiresAt: number | null;
  usedAt: number | null;
};

export type RecordingRow = {
  id: string;
  leaseId: string;
  accountId: string;
  state: 'waiting' | 'recording' | 'saving' | 'ready' | 'failed' | 'deleted';
  startedAt: number | null;
  endedAt: number | null;
  bytes: number;
  error: string | null;
  device: string | null;
};

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec('pragma journal_mode = wal; pragma busy_timeout = 5000;');
    this.sql.exec(SCHEMA);
    // Tokens once took their account's role. The operator's own CLI tokens keep it; every other token becomes a member's.
    this.sql.exec(`update tokens set scopes = trim(scopes || ' operator install:upload')
      where kind = 'member' and (label like 'hangar up on %' or label like 'CLI on %') and ' ' || scopes || ' ' not like '% operator %'
      and account_id in (select id from accounts where role = 'operator')`);
  }


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

  // Replaced devices get a new id, so an id a lease ever held is never handed out again.
  usedDeviceIds(): Set<string> {
    const rows = this.sql.prepare('select distinct device_id from leases where device_id is not null').all();
    return new Set(rows.map((r) => String(r.device_id)));
  }

  recentLeases(limit = 100): Lease[] {
    return this.sql.prepare('select data from leases order by rowid desc limit ?').all(limit).map(parseLease);
  }


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

  setRole(id: string, role: Account['role']): void {
    this.sql.prepare('update accounts set role = ? where id = ?').run(role, id);
  }

  identity(issuer: string, subject: string): string | null {
    const row = this.sql.prepare('select account_id from identities where issuer = ? and subject = ?').get(issuer, subject);
    return row ? String(row.account_id) : null;
  }

  linkIdentity(issuer: string, subject: string, accountId: string): void {
    this.sql.prepare('insert into identities (issuer, subject, account_id) values (?, ?, ?)').run(issuer, subject, accountId);
  }

  setPassword(id: string, hash: string): void {
    this.sql.prepare('update accounts set password_hash = ? where id = ?').run(hash, id);
  }


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

  // Returns false if the token was already used, so racing requests cannot both spend it.
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


  insertRecording(r: RecordingRow): void {
    this.sql
      .prepare('insert into recordings (id, lease_id, account_id, state, started_at, ended_at, bytes, error, device, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.leaseId, r.accountId, r.state, r.startedAt, r.endedAt, r.bytes, r.error, r.device, Date.now());
  }

  updateRecording(id: string, fields: Partial<Omit<RecordingRow, 'id' | 'leaseId' | 'accountId'>>): void {
    const r = this.getRecording(id);
    if (!r) {
      return;
    }
    const next = { ...r, ...fields };
    this.sql
      .prepare('update recordings set state = ?, started_at = ?, ended_at = ?, bytes = ?, error = ?, device = ? where id = ?')
      .run(next.state, next.startedAt, next.endedAt, next.bytes, next.error, next.device, id);
  }

  getRecording(id: string): RecordingRow | null {
    const row = this.sql.prepare('select * from recordings where id = ?').get(id);
    return row ? toRecording(row) : null;
  }

  recordingOf(leaseId: string, states: RecordingRow['state'][]): RecordingRow | null {
    const row = this.sql
      .prepare(`select * from recordings where lease_id = ? and state in (${states.map(() => '?').join(', ')}) order by created_at desc limit 1`)
      .get(leaseId, ...states);
    return row ? toRecording(row) : null;
  }

  recordings(accountId: string | null): RecordingRow[] {
    const rows = accountId
      ? this.sql.prepare("select * from recordings where account_id = ? and state != 'deleted' order by created_at desc limit 200").all(accountId)
      : this.sql.prepare("select * from recordings where state != 'deleted' order by created_at desc limit 200").all();
    return rows.map(toRecording);
  }

  stuckRecordings(endedBefore: number): RecordingRow[] {
    return this.sql.prepare("select * from recordings where state = 'saving' and ended_at < ?").all(endedBefore).map(toRecording);
  }

  expiredRecordings(before: number): RecordingRow[] {
    return this.sql.prepare("select * from recordings where created_at < ? and state != 'deleted'").all(before).map(toRecording);
  }


  teams(): Team[] {
    const rows = this.sql.prepare('select id, name, quota from teams order by name').all().map(toTeam);
    return rows.some((t) => t.id === DEFAULT_TEAM) ? rows : [{ id: DEFAULT_TEAM, name: 'Default', quota: null }, ...rows];
  }

  saveTeam(t: Team): void {
    this.sql.prepare('insert into teams (id, name, quota) values (?, ?, ?) on conflict(id) do update set name = excluded.name, quota = excluded.quota').run(t.id, t.name, t.quota);
  }

  teamOf(accountId: string): string {
    const row = this.sql.prepare('select team_id from memberships where account_id = ?').get(accountId);
    return row ? String(row.team_id) : DEFAULT_TEAM;
  }

  setTeam(accountId: string, teamId: string): void {
    this.sql.prepare('insert into memberships (account_id, team_id) values (?, ?) on conflict(account_id) do update set team_id = excluded.team_id').run(accountId, teamId);
  }


  images(): ImageSpec[] {
    return this.sql.prepare('select data from images order by name').all().map((r) => JSON.parse(String(r.data)));
  }

  saveImage(image: ImageSpec): void {
    this.sql.prepare('insert or replace into images (name, data) values (?, ?)').run(image.name, JSON.stringify(image));
  }

  removeImage(name: string): boolean {
    return this.sql.prepare('delete from images where name = ?').run(name).changes === 1;
  }

  saveRun(run: Run): void {
    this.sql.prepare('insert or replace into runs (id, account_id, data) values (?, ?, ?)').run(run.id, run.accountId, JSON.stringify(run));
  }

  getRun(id: string): Run | null {
    const row = this.sql.prepare('select data from runs where id = ?').get(id);
    return row ? (JSON.parse(String(row.data)) as Run) : null;
  }

  recentRuns(limit = 100): Run[] {
    return this.sql.prepare('select data from runs order by rowid desc limit ?').all(limit).map((r) => JSON.parse(String(r.data)) as Run);
  }

  audit(event: string, principalId: string | null, leaseId: string | null): void {
    this.sql.prepare('insert into audit (at, principal_id, lease_id, event) values (?, ?, ?, ?)').run(Date.now(), principalId, leaseId, event);
  }

  saveRunSuite(runId: string, suite: RunSuite): void {
    this.sql.prepare('insert or replace into run_suites (run_id, data) values (?, ?)').run(runId, JSON.stringify(suite));
  }

  getRunSuite(runId: string): RunSuite | null {
    const row = this.sql.prepare('select data from run_suites where run_id = ?').get(runId);
    if (!row) {
      return null;
    }
    const suite: RunSuite = JSON.parse(String(row.data));
    return suite;
  }

  imageSetup(name: string): string | null {
    const row = this.sql.prepare('select data from image_setups where name = ?').get(name);
    return row ? String(row.data) : null;
  }

  saveImageSetup(name: string, data: string | null): void {
    if (data === null) {
      this.sql.prepare('delete from image_setups where name = ?').run(name);
      return;
    }
    this.sql.prepare('insert or replace into image_setups (name, data) values (?, ?)').run(name, data);
  }

  imageSecrets(): { name: string; updatedAt: number }[] {
    return this.sql.prepare('select name, updated_at from image_secrets order by name').all().map((r) => ({ name: String(r.name), updatedAt: Number(r.updated_at) }));
  }

  imageSecretValues(names: string[]): Record<string, string> {
    const values: Record<string, string> = {};
    for (const name of names) {
      const row = this.sql.prepare('select value from image_secrets where name = ?').get(name);
      if (row) {
        values[name] = String(row.value);
      }
    }
    return values;
  }

  saveImageSecret(name: string, value: string, at: number): void {
    this.sql.prepare('insert or replace into image_secrets (name, value, updated_at) values (?, ?, ?)').run(name, value, at);
  }

  removeImageSecret(name: string): boolean {
    return this.sql.prepare('delete from image_secrets where name = ?').run(name).changes === 1;
  }

  setTokenLimits(hash: string, limits: TokenLimitRow): void {
    this.sql
      .prepare('insert or replace into token_limits (hash, agent, idle_ms, max_ms, grace_ms) values (?, ?, ?, ?, ?)')
      .run(hash, limits.agent ? 1 : 0, limits.idleMs, limits.maxMs, limits.graceMs);
  }

  tokenLimits(hash: string): TokenLimitRow | null {
    const row = this.sql.prepare('select agent, idle_ms, max_ms, grace_ms from token_limits where hash = ?').get(hash);
    if (!row) {
      return null;
    }
    return { agent: Number(row.agent) === 1, idleMs: numOrNull(row.idle_ms), maxMs: numOrNull(row.max_ms), graceMs: numOrNull(row.grace_ms) };
  }

  leaseLimitCaps(): LeaseLimitRow[] {
    return this.sql
      .prepare('select role, idle_ms, max_ms, grace_ms from lease_limits')
      .all()
      .map((r) => ({ role: String(r.role), idleMs: numOrNull(r.idle_ms), maxMs: numOrNull(r.max_ms), graceMs: numOrNull(r.grace_ms) }));
  }

  setLeaseLimitCap(row: LeaseLimitRow): void {
    this.sql
      .prepare('insert or replace into lease_limits (role, idle_ms, max_ms, grace_ms) values (?, ?, ?, ?)')
      .run(row.role, row.idleMs, row.maxMs, row.graceMs);
  }

  bookings(): Booking[] {
    return this.sql.prepare('select data from bookings order by name').all().map((r) => parseBooking(r));
  }

  saveBooking(b: Booking): void {
    this.sql.prepare('insert or replace into bookings (id, name, data) values (?, ?, ?)').run(b.id, b.name, JSON.stringify(b));
  }

  removeBooking(id: string): boolean {
    return this.sql.prepare('delete from bookings where id = ?').run(id).changes === 1;
  }

  ciFloors(): Map<string, number> {
    return new Map(this.sql.prepare('select host_name, floor from ci_floors').all().map((r) => [String(r.host_name), Number(r.floor)]));
  }

  setCiFloor(hostName: string, floor: number | null): void {
    if (floor === null) {
      this.sql.prepare('delete from ci_floors where host_name = ?').run(hostName);
      return;
    }
    this.sql.prepare('insert or replace into ci_floors (host_name, floor) values (?, ?)').run(hostName, floor);
  }

  setTokenPriority(hash: string, row: TokenPriorityRow): void {
    this.sql.prepare('insert or replace into token_priorities (hash, priority, booking_id) values (?, ?, ?)').run(hash, row.priority, row.bookingId);
  }

  tokenPriority(hash: string): TokenPriorityRow | null {
    const row = this.sql.prepare('select priority, booking_id from token_priorities where hash = ?').get(hash);
    if (!row) {
      return null;
    }
    const priority = row.priority === 'ci' || row.priority === 'booked' ? row.priority : 'interactive';
    return { priority, bookingId: row.booking_id === null ? null : String(row.booking_id) };
  }

  holds(): Hold[] {
    return this.sql.prepare('select data from holds').all().map((r) => parseHold(r));
  }

  saveHold(h: Hold): void {
    this.sql.prepare('insert or replace into holds (device_id, data) values (?, ?)').run(h.deviceId, JSON.stringify(h));
  }

  removeHold(deviceId: string): void {
    this.sql.prepare('delete from holds where device_id = ?').run(deviceId);
  }

  insertFinding(f: FindingRow): void {
    this.sql
      .prepare('insert into findings (id, lease_id, account_id, team_id, night_id, created_at, data) values (?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, f.leaseId, f.accountId, f.teamId, f.nightId, f.createdAt, JSON.stringify(f.data));
  }

  getFinding(id: string): FindingRow | null {
    const row = this.sql.prepare('select * from findings where id = ?').get(id);
    return row ? toFinding(row) : null;
  }

  findingsOf(opts: { nightId?: string; leaseIds?: string[] }): FindingRow[] {
    const leaseIds = opts.leaseIds ?? [];
    const where: string[] = [];
    const args: string[] = [];
    if (opts.nightId) {
      where.push('night_id = ?');
      args.push(opts.nightId);
    }
    if (leaseIds.length) {
      where.push(`lease_id in (${leaseIds.map(() => '?').join(', ')})`);
      args.push(...leaseIds);
    }
    if (!where.length) {
      return [];
    }
    return this.sql.prepare(`select * from findings where ${where.join(' or ')} order by created_at`).all(...args).map(toFinding);
  }

  findingsBefore(before: number): FindingRow[] {
    return this.sql.prepare('select * from findings where created_at < ?').all(before).map(toFinding);
  }

  insertNight(n: NightRow): void {
    this.sql
      .prepare('insert into nights (id, team_id, booking, state, opened_at, closed_at, data) values (?, ?, ?, ?, ?, ?, ?)')
      .run(n.id, n.teamId, n.booking, n.state, n.openedAt, n.closedAt, JSON.stringify(n.data));
  }

  updateNight(n: NightRow): void {
    this.sql.prepare('update nights set state = ?, closed_at = ?, data = ? where id = ?').run(n.state, n.closedAt, JSON.stringify(n.data), n.id);
  }

  getNight(id: string): NightRow | null {
    const row = this.sql.prepare('select * from nights where id = ?').get(id);
    return row ? toNight(row) : null;
  }

  nights(opts: { teamId?: string; booking?: string; state?: NightRow['state'] } = {}, limit = 100): NightRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.teamId) {
      where.push('team_id = ?');
      args.push(opts.teamId);
    }
    if (opts.booking) {
      where.push('booking = ?');
      args.push(opts.booking);
    }
    if (opts.state) {
      where.push('state = ?');
      args.push(opts.state);
    }
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    return this.sql.prepare(`select * from nights ${clause} order by opened_at desc, rowid desc limit ?`).all(...args, limit).map(toNight);
  }

  // Leases of a team that were active at some point in [from, to].
  teamLeasesActiveBetween(teamId: string, from: number, to: number): Lease[] {
    return this.sql
      .prepare(
        "select data from leases where json_extract(data, '$.teamId') = ? and json_extract(data, '$.activatedAt') is not null and json_extract(data, '$.activatedAt') <= ? and coalesce(json_extract(data, '$.endedAt'), ?) >= ? order by rowid",
      )
      .all(teamId, to, Number.MAX_SAFE_INTEGER, from)
      .map(parseLease);
  }
}

export type TokenLimitRow = { agent: boolean; idleMs: number | null; maxMs: number | null; graceMs: number | null };
export type LeaseLimitRow = { role: string; idleMs: number | null; maxMs: number | null; graceMs: number | null };

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export type RunSuite = { sha256: string; testSha256: string; archive: string; envKeys: string[] };

type Booking = import('@hangar/protocol').Booking;
type Hold = import('@hangar/protocol').Hold;
export type TokenPriorityRow = { priority: import('@hangar/protocol').Priority; bookingId: string | null };

function parseBooking(row: Record<string, unknown>): Booking {
  const b: Booking = JSON.parse(String(row.data));
  return b;
}

function parseHold(row: Record<string, unknown>): Hold {
  const h: Hold = JSON.parse(String(row.data));
  return h;
}

export type FindingRow = { id: string; leaseId: string; accountId: string; teamId: string; nightId: string | null; createdAt: number; data: FindingData };
export type FindingData = Omit<Finding, 'id' | 'leaseId' | 'nightId' | 'by' | 'createdAt' | 'video' | 'screenshot'> & {
  video: { recordingId: string; fromMs: number; toMs: number; startedWithFinding: boolean } | null;
  screenshot: boolean;
};
export type NightRow = {
  id: string;
  teamId: string;
  booking: string;
  state: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  data: { openedBy: string; closedBy: string | null; leaseIds: string[] | null; runIds: string[] | null };
};

function toFinding(row: Record<string, unknown>): FindingRow {
  return {
    id: String(row.id),
    leaseId: String(row.lease_id),
    accountId: String(row.account_id),
    teamId: String(row.team_id),
    nightId: row.night_id === null ? null : String(row.night_id),
    createdAt: Number(row.created_at),
    data: JSON.parse(String(row.data)),
  };
}

function toNight(row: Record<string, unknown>): NightRow {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    booking: String(row.booking),
    state: String(row.state) === 'closed' ? 'closed' : 'open',
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
    data: JSON.parse(String(row.data)),
  };
}

function parseLease(row: Record<string, unknown>): Lease {
  return JSON.parse(String(row.data)) as Lease;
}

function toRecording(row: Record<string, unknown>): RecordingRow {
  const num = (v: unknown): number | null => (v === null ? null : Number(v));
  return {
    id: String(row.id),
    leaseId: String(row.lease_id),
    accountId: String(row.account_id),
    state: String(row.state) as RecordingRow['state'],
    startedAt: num(row.started_at),
    endedAt: num(row.ended_at),
    bytes: Number(row.bytes),
    error: row.error === null ? null : String(row.error),
    device: row.device === null ? null : String(row.device),
  };
}

function toTeam(row: Record<string, unknown>): Team {
  return { id: String(row.id), name: String(row.name), quota: row.quota === null ? null : Number(row.quota) };
}

function toAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role) as Account['role'],
    passwordHash: row.password_hash === null ? null : String(row.password_hash),
  };
}
