import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage } from '@hangar/protocol';
import * as auth from '../auth.ts';
import { startBroker, type Broker } from '../index.ts';
import { onWindowClosed } from '../schedule.ts';

type Host = { ends: string[]; ops: { leaseId: string; op: string }[]; devices: () => AgentDevice[] };

// A host whose devices come back with a new id after a wipe. Maestro fails flows named broken, and the first
// run of a flow named slow waits until its lease ends.
function fakeHost(broker: Broker, count: number): Host {
  let n = count;
  const waiting = new Map<string, number>();
  const slowSeen = new Set<string>();
  let devices: AgentDevice[] = Array.from({ length: count }, (_, i) => ({ deviceId: `dev-${i + 1}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }));
  const owner = new Map<string, string>();
  const host: Host = { ends: [], ops: [], devices: () => devices };
  const handlers = broker.attach({
    send: (m: BrokerMessage) => {
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          owner.set(m.leaseId, m.deviceId);
          devices = devices.map((d) => (d.deviceId === m.deviceId ? { ...d, state: 'busy' } : d));
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'op') {
          host.ops.push({ leaseId: m.leaseId, op: m.body.op });
          if (!owner.has(m.leaseId)) {
            handlers.message({ type: 'response', id: m.id, ok: false, error: { code: 'LEASE_NOT_HELD', message: 'no such lease here' } });
          } else if (m.body.op === 'maestro' && m.body.flows.some((f) => f.startsWith('slow') && !slowSeen.has(f))) {
            m.body.flows.forEach((f) => slowSeen.add(f));
            waiting.set(m.leaseId, m.id);
          } else if (m.body.op === 'maestro') {
            const cases = m.body.flows.map((f) => `<testcase name="${f.replace('.yaml', '')}" time="1">${f.startsWith('broken') ? '<failure>no</failure>' : ''}</testcase>`).join('');
            handlers.message({ type: 'response', id: m.id, ok: true, result: { passed: !cases.includes('failure'), junit: `<testsuites>${cases}</testsuites>`, log: 'done', durationMs: 1 } });
          } else {
            handlers.message({ type: 'response', id: m.id, ok: true, result: {} });
          }
        } else if (m.type === 'lease.end') {
          host.ends.push(m.leaseId);
          const pending = waiting.get(m.leaseId);
          if (pending !== undefined) {
            waiting.delete(m.leaseId);
            handlers.message({ type: 'response', id: pending, ok: false, error: { code: 'LEASE_ENDED', message: 'The lease ended.' } });
          }
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
  return host;
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
    await new Promise((r) => setTimeout(r, 50));
    v = await get();
  }
  return v;
}

async function withBroker(fn: (broker: Broker, member: (name: string, team: string) => string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-bookings-test-'));
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

test('a booking holds devices for its token, ci preempts it, and removing it ends its leases', async () => {
  await withBroker(async (broker, member) => {
    fakeHost(broker, 2);
    const admin = broker.adminToken('test');
    const alice = member('alice', 'qa');
    const bob = member('bob', 'web');
    const window = { from: hhmm(Date.now() - 3_600_000), to: hhmm(Date.now() + 3_600_000), days: 'daily' };

    const over = await call(broker, alice, 'POST', '/v1/bookings', { name: 'night', devices: 2, ...window });
    assert.equal(over.status, 409, 'the CI floor of one leaves one device for bookings');
    assert.equal(over.json.error.code, 'OVER_CAPACITY');
    assert.equal((await call(broker, alice, 'PUT', '/v1/ci-floors/fake-mac', { floor: 0 })).status, 403);
    assert.equal((await call(broker, admin, 'PUT', '/v1/ci-floors/fake-mac', { floor: 0 })).json.floor, 0);
    const made = await call(broker, alice, 'POST', '/v1/bookings', { name: 'night', devices: 2, ...window });
    assert.equal(made.status, 201);
    assert.ok(made.json.open, 'the window is open');
    assert.equal(made.json.team, 'qa');
    assert.equal((await call(broker, alice, 'POST', '/v1/bookings', { name: 'other', devices: 1, ...window })).status, 409, 'no room left');

    assert.equal((await call(broker, bob, 'POST', '/v1/bookings/night/tokens', {})).status, 403, 'only the team makes tokens');
    const token = await call(broker, alice, 'POST', '/v1/bookings/night/tokens', { agent: true });
    assert.equal(token.json.priority, 'booked');
    const agent = String(token.json.token);

    const first = await call(broker, agent, 'POST', '/v1/leases?wait=5', {});
    const second = await call(broker, agent, 'POST', '/v1/leases?wait=5', {});
    assert.equal(first.json.state, 'active');
    assert.equal(second.json.state, 'active');
    assert.equal(first.json.priority, 'booked');
    assert.equal(first.json.booking, 'night');
    const third = await call(broker, agent, 'POST', '/v1/leases', {});
    assert.equal(third.json.state, 'queued', 'a booking leases no more than it booked');

    const person = await call(broker, bob, 'POST', '/v1/leases', {});
    assert.equal(person.json.state, 'queued');
    await broker.leases.tick();
    assert.equal((await call(broker, agent, 'GET', `/v1/leases/${first.json.id}`)).json.ending, null, 'a person does not preempt a booking');

    const ci = String((await call(broker, bob, 'POST', '/v1/tokens', { priority: 'ci' })).json.token);
    assert.equal((await call(broker, bob, 'POST', '/v1/tokens', { priority: 'booked' })).status, 400);
    const ciLease = await call(broker, ci, 'POST', '/v1/leases', {});
    assert.equal(ciLease.json.priority, 'ci');
    await broker.leases.tick();
    const newest = (await call(broker, agent, 'GET', `/v1/leases/${second.json.id}`)).json;
    assert.equal(newest.ending?.reason, 'preempted', 'the newest booked lease is told it ends');
    assert.ok(newest.ending.at - Date.now() > 110_000 && newest.ending.at - Date.now() <= 120_000);
    assert.equal((await call(broker, agent, 'GET', `/v1/leases/${first.json.id}`)).json.ending, null, 'one preemption for one request');
    await broker.leases.tick();
    assert.equal((await call(broker, agent, 'GET', `/v1/leases/${first.json.id}`)).json.ending, null, 'the next tick waits for that device');

    assert.equal((await call(broker, bob, 'DELETE', '/v1/bookings/night')).status, 403);
    const closed: string[] = [];
    const stop = onWindowClosed((w) => closed.push(w.name));
    assert.equal((await call(broker, alice, 'DELETE', '/v1/bookings/night')).status, 200);
    const ended = await until(() => call(broker, agent, 'GET', `/v1/leases/${first.json.id}`), (r) => r.json.state === 'ended');
    assert.equal(ended.json.reason, 'window_closed');
    stop();
    assert.deepEqual(closed, ['night'], 'stream C hears that the window closed');
    const got = await until(() => call(broker, ci, 'GET', `/v1/leases/${ciLease.json.id}`), (r) => r.json.state === 'active');
    assert.equal(got.json.state, 'active', 'ci gets a device once the booked lease is gone');
    const gone = await call(broker, agent, 'POST', '/v1/leases', {});
    assert.equal(gone.status, 410, 'a removed booking’s token leases nothing');
  });
});

test('a booked request before its window waits in the queue', async () => {
  await withBroker(async (broker, member) => {
    fakeHost(broker, 2);
    const alice = member('alice', 'qa');
    const later = { from: hhmm(Date.now() + 2 * 3_600_000), to: hhmm(Date.now() + 3 * 3_600_000), days: 'daily' };
    const made = await call(broker, alice, 'POST', '/v1/bookings', { name: 'later', devices: 1, ...later });
    assert.equal(made.json.open, null);
    const agent = String((await call(broker, alice, 'POST', '/v1/bookings/later/tokens', { agent: true })).json.token);
    const early = await call(broker, agent, 'POST', '/v1/leases?wait=1', {});
    assert.equal(early.json.state, 'queued');
    const stored = broker.db.getLease(early.json.id);
    assert.ok(stored && stored.queueTimeoutMs > 2 * 3_600_000, 'it waits past the window opening');
  });
});

test('a failed flow keeps its device for the run’s team, and the device is wiped when that lease ends', async () => {
  await withBroker(async (broker, member) => {
    const host = fakeHost(broker, 1);
    broker.db.insertBuild('abc123', 'App.app', '/nonexistent', 1);
    const alice = member('alice', 'qa');
    const carol = member('carol', 'qa');
    const bob = member('bob', 'web');
    assert.equal((await call(broker, alice, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['broken.yaml'] }, holdSeconds: 99_999 })).status, 400);
    const start = await call(broker, alice, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml', 'broken.yaml'] }, retries: 0, holdSeconds: 600 });
    assert.equal(start.status, 201);
    const run = await until(() => call(broker, alice, 'GET', `/v1/runs/${start.json.id}`), (r) => r.json.state !== 'running');
    assert.equal(run.json.state, 'failed');
    const broken = run.json.flows.find((f: { flow: string }) => f.flow === 'broken.yaml');
    assert.ok(broken.held && broken.held.until > Date.now() + 590_000, 'the failed flow is held');
    const runLease = String(run.json.leaseIds[0]);
    assert.deepEqual(host.ends, [], 'the device was not wiped');
    assert.equal(broker.leases.deviceState(host.devices()[0]?.deviceId ?? '', 'busy'), 'held');
    assert.equal(broker.db.getLease(runLease)?.state, 'ended');

    const path = `/v1/runs/${start.json.id}/flows/broken.yaml/hold-lease`;
    assert.equal((await call(broker, bob, 'POST', path)).status, 404, 'another team does not see the run');
    const carolAgent = String((await call(broker, carol, 'POST', '/v1/tokens', { agent: true })).json.token);
    assert.equal((await call(broker, carolAgent, 'POST', path)).status, 403, 'an agent token does not take a held device');
    const taken = await call(broker, carol, 'POST', path);
    assert.equal(taken.status, 201);
    assert.equal(taken.json.state, 'active');
    assert.equal((await call(broker, alice, 'POST', path)).status, 409, 'one person at a time');
    assert.equal((await call(broker, carol, 'POST', `/v1/leases/${taken.json.id}/open-url`, { url: 'myapp://home' })).status, 200);
    assert.equal(host.ops.at(-1)?.leaseId, runLease, 'the host knows the device by the run lease');

    assert.equal((await call(broker, carol, 'DELETE', `/v1/leases/${taken.json.id}`)).status, 200);
    assert.deepEqual(host.ends, [runLease], 'the device is wiped when the held lease ends');
    assert.deepEqual(broker.leases.holds(), []);
    const after = await call(broker, alice, 'GET', `/v1/runs/${start.json.id}`);
    assert.equal(after.json.flows.find((f: { flow: string }) => f.flow === 'broken.yaml').held, undefined);
  });
});

test('a run shard on a preempted lease runs again on another device', async () => {
  await withBroker(async (broker, member) => {
    fakeHost(broker, 1);
    broker.db.insertBuild('abc123', 'App.app', '/nonexistent', 1);
    const admin = broker.adminToken('test');
    await call(broker, admin, 'PUT', '/v1/ci-floors/fake-mac', { floor: 0 });
    const alice = member('alice', 'qa');
    const window = { from: hhmm(Date.now() - 3_600_000), to: hhmm(Date.now() + 3_600_000), days: 'daily' };
    assert.equal((await call(broker, alice, 'POST', '/v1/bookings', { name: 'night', devices: 1, ...window })).status, 201);
    const booked = String((await call(broker, alice, 'POST', '/v1/bookings/night/tokens', {})).json.token);
    const start = await call(broker, booked, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['slow.yaml'] }, retries: 0 });
    const first = await until(() => call(broker, booked, 'GET', `/v1/runs/${start.json.id}`), (r) => r.json.flows[0].status === 'running');
    const shardLease = String(first.json.leaseIds[0]);
    assert.equal(broker.db.getLease(shardLease)?.shard, true);

    const ci = String((await call(broker, alice, 'POST', '/v1/tokens', { priority: 'ci' })).json.token);
    const ciLease = await call(broker, ci, 'POST', '/v1/leases', {});
    await broker.leases.tick();
    const told = broker.db.getLease(shardLease);
    assert.equal(told?.ending?.reason, 'preempted');
    // Skip the two minutes.
    if (told) {
      broker.db.updateLease({ ...told, ending: { reason: 'preempted', at: Date.now() } });
    }
    await broker.leases.tick();
    assert.equal(broker.db.getLease(shardLease)?.reason, 'preempted');
    const active = await until(() => call(broker, ci, 'GET', `/v1/leases/${ciLease.json.id}`), (r) => r.json.state === 'active');
    assert.equal(active.json.state, 'active', 'ci gets the device');
    const queued = (await call(broker, booked, 'GET', `/v1/runs/${start.json.id}`)).json;
    assert.equal(queued.state, 'running');
    assert.equal(queued.flows[0].status, 'queued', 'the interrupted flow waits for another device');
    await call(broker, ci, 'DELETE', `/v1/leases/${ciLease.json.id}`);
    const done = await until(() => call(broker, booked, 'GET', `/v1/runs/${start.json.id}`), (r) => r.json.state !== 'running');
    assert.equal(done.json.state, 'passed');
    assert.equal(done.json.leaseIds.length, 2);
  });
});
