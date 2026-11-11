import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { startBroker, type Broker } from './index.ts';

// A host whose devices come back with a new id after a wipe. Maestro passes every flow.
function fakeHost(broker: Broker, count: number): void {
  let n = count;
  let devices: AgentDevice[] = Array.from({ length: count }, (_, i) => ({ deviceId: `dev-${i + 1}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }));
  const owner = new Map<string, string>();
  const handlers = broker.attach({
    send: (m: BrokerMessage) => {
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          owner.set(m.leaseId, m.deviceId);
          devices = devices.map((d) => (d.deviceId === m.deviceId ? { ...d, state: 'busy' } : d));
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'op' && m.body.op === 'maestro') {
          const cases = m.body.flows.map((f) => `<testcase name="${f.replace('.yaml', '')}" time="1"/>`).join('');
          handlers.message({ type: 'response', id: m.id, ok: true, result: { passed: true, junit: `<testsuites>${cases}</testsuites>`, log: 'done', durationMs: 1 } });
        } else if (m.type === 'op') {
          handlers.message({ type: 'response', id: m.id, ok: true, result: {} });
        } else if (m.type === 'lease.end') {
          const deviceId = owner.get(m.leaseId);
          owner.delete(m.leaseId);
          n += 1;
          devices = devices.filter((d) => d.deviceId !== deviceId).concat(deviceId ? [{ deviceId: `dev-${n}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }] : []);
          handlers.message({ type: 'inventory', devices });
        }
      });
    },
    close: () => {},
  });
  handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices, leases: [] });
}

type Reply = { status: number; json: any };

async function call(broker: Broker, token: string, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${broker.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const stop = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 20));
    v = await get();
  }
  return v;
}

async function withBroker(fn: (broker: Broker, member: (name: string, team: string) => string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-runs-booking-test-'));
  const zone = process.env.HANGAR_TIME_ZONE;
  process.env.HANGAR_TIME_ZONE = 'UTC';
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const member = (name: string, team: string): string => {
    const account = auth.createAccount(broker.db, name, 'member');
    broker.db.saveTeam({ id: team, name: team, quota: null });
    broker.db.setTeam(account.id, team);
    return auth.mintToken(broker.db, 'member', { accountId: account.id });
  };
  try {
    broker.db.insertBuild('abc123', 'App.app', '/nonexistent', 1);
    await fn(broker, member);
  } finally {
    await broker.close();
    if (zone === undefined) {
      delete process.env.HANGAR_TIME_ZONE;
    } else {
      process.env.HANGAR_TIME_ZONE = zone;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const suite = { kind: 'maestro', archive: 'dGFy', flows: ['a.yaml'] };

test('a run with --booking leases its shard inside the booking, ahead of the booking’s queued agents', async () => {
  await withBroker(async (broker, member) => {
    fakeHost(broker, 2);
    const alice = member('alice', 'qa');
    const window = { from: hhmm(Date.now() - 3_600_000), to: hhmm(Date.now() + 3_600_000), days: 'daily' };
    assert.equal((await call(broker, alice, 'POST', '/v1/bookings', { name: 'night', devices: 1, ...window })).status, 201);
    const agent = String((await call(broker, alice, 'POST', '/v1/bookings/night/tokens', { agent: true })).json.token);
    const first = await call(broker, agent, 'POST', '/v1/leases', {});
    await until(() => call(broker, agent, 'GET', `/v1/leases/${first.json.id}`), (r) => r.json.state === 'active');
    const second = await call(broker, agent, 'POST', '/v1/leases', {});
    assert.equal(second.json.state, 'queued', 'the booking has one device, and the first agent holds it');

    const ci = String((await call(broker, alice, 'POST', '/v1/tokens', { priority: 'ci' })).json.token);
    const start = await call(broker, ci, 'POST', '/v1/runs', { build: 'App.app', suite, retries: 0, booking: 'night' });
    assert.equal(start.status, 201);
    assert.deepEqual(start.json.booking, { id: broker.db.bookings()[0]?.id, name: 'night' });
    const queued = await until(() => call(broker, ci, 'GET', `/v1/runs/${start.json.id}`), (r) => r.json.leaseIds.length === 1);
    const shard = broker.db.getLease(String(queued.json.leaseIds[0]));
    assert.equal(shard?.priority, 'booked');
    assert.equal(shard?.bookingId, broker.db.bookings()[0]?.id);
    assert.equal(shard?.state, 'queued', 'the CI floor device is not the booking’s');

    await call(broker, agent, 'DELETE', `/v1/leases/${first.json.id}`);
    const done = await until(() => call(broker, ci, 'GET', `/v1/runs/${start.json.id}`), (r) => r.json.state !== 'running');
    assert.equal(done.json.state, 'passed');
    const waiting = await call(broker, agent, 'GET', `/v1/leases/${second.json.id}`);
    assert.notEqual(waiting.json.state, 'ended');
    const activeAt = broker.db.getLease(String(second.json.id))?.activatedAt;
    const shardAt = broker.db.getLease(String(queued.json.leaseIds[0]))?.activatedAt;
    assert.ok(shardAt !== undefined && shardAt !== null, 'the shard got the device');
    assert.ok(activeAt === undefined || activeAt === null || activeAt >= shardAt, 'the queued agent came after the shard');
  });
});

test('a run with --booking needs the booking’s team and an open window', async () => {
  await withBroker(async (broker, member) => {
    fakeHost(broker, 2);
    const alice = member('alice', 'qa');
    const bob = member('bob', 'web');
    const open = { from: hhmm(Date.now() - 3_600_000), to: hhmm(Date.now() + 3_600_000), days: 'daily' };
    const later = { from: hhmm(Date.now() + 3 * 3_600_000), to: hhmm(Date.now() + 4 * 3_600_000), days: 'daily' };
    assert.equal((await call(broker, alice, 'POST', '/v1/bookings', { name: 'night', devices: 1, ...open })).status, 201);
    const other = await call(broker, bob, 'POST', '/v1/runs', { build: 'App.app', suite, booking: 'night' });
    assert.equal(other.status, 403);
    assert.equal(other.json.error?.code ?? other.json.code, 'NOT_YOUR_BOOKING');
    assert.equal((await call(broker, alice, 'POST', '/v1/runs', { build: 'App.app', suite, booking: 'nope' })).status, 404);

    assert.equal((await call(broker, alice, 'DELETE', '/v1/bookings/night')).status, 200);
    assert.equal((await call(broker, alice, 'POST', '/v1/bookings', { name: 'later', devices: 1, ...later })).status, 201);
    const closed = await call(broker, alice, 'POST', '/v1/runs', { build: 'App.app', suite, booking: 'later' });
    assert.equal(closed.status, 409);
    assert.match(JSON.stringify(closed.json), /BOOKING_CLOSED/);
    assert.equal(broker.db.recentRuns().length, 0, 'a refused run leaves nothing behind');
  });
});
