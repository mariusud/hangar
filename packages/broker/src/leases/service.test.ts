import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice } from '@devicepool/protocol';
import * as auth from '../auth.ts';
import { Db } from '../db.ts';
import { Hosts } from '../hosts.ts';
import { startBroker } from '../index.ts';
import { ApiError, Leases } from './service.ts';
import { capsFromEnv } from './limits.ts';
import * as m from './machine.ts';

const device: AgentDevice = { deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'busy', platform: 'ios-simulator' };

async function setup(): Promise<{ db: Db; hosts: Hosts; dir: string; clock: { now: number }; leases: Leases; account: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-service-test-'));
  const db = new Db(join(dir, 'devicepool.db'));
  const hosts = new Hosts();
  const clock = { now: 1_000_000 };
  const leases = new Leases(db, hosts, () => clock.now, 'UTC', { maxLeasesPerAccount: 2, maxShards: 50 });
  const account = auth.createAccount(db, 'alice', 'member').id;
  return { db, hosts, dir, clock, leases, account };
}

function activeLease(db: Db, account: string, now: number): m.Lease {
  const lease = m.activate(m.assign(m.newLease({ id: 'lease-1', principalId: account, teamId: db.teamOf(account), class: {} }, now), 'dev-1', now), now);
  db.insertLease(lease);
  return lease;
}

function hello(hosts: Hosts, leases: string[]): void {
  hosts.attach({ send: () => {}, close: () => {} }).message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices: [device], leases });
}

test('after a broker restart a lease whose host has not said hello yet is left alone until the grace has passed', async () => {
  const { db, hosts, dir, clock, leases, account } = await setup();
  try {
    activeLease(db, account, clock.now - 5000);
    clock.now += 1000;
    await leases.tick();
    assert.equal(db.getLease('lease-1')?.state, 'active', 'one second after start');
    clock.now += 58_000;
    await leases.tick();
    assert.equal(db.getLease('lease-1')?.state, 'active', 'still inside the grace');
    clock.now += 2000;
    await leases.tick();
    assert.equal(db.getLease('lease-1')?.state, 'ended');
    assert.equal(db.getLease('lease-1')?.reason, 'device_lost');
    assert.equal(hosts.hosts.size, 0);
  } finally {
    db.sql.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent that reconnects inside the grace and still reports its lease carries on untouched', async () => {
  const { db, hosts, dir, clock, leases, account } = await setup();
  try {
    activeLease(db, account, clock.now - 5000);
    clock.now += 1000;
    await leases.tick();
    hello(hosts, ['lease-1']);
    clock.now += 120_000;
    await leases.tick();
    assert.equal(db.getLease('lease-1')?.state, 'active');
    assert.equal(db.getLease('lease-1')?.reason, null);
  } finally {
    db.sql.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tick never rejects, and one bad lease does not stop the rest of the tick', async () => {
  const { db, hosts, dir, clock, leases, account } = await setup();
  const logged: string[] = [];
  const log = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    activeLease(db, account, clock.now);
    hello(hosts, ['lease-1']);
    const real = db.updateLease.bind(db);
    db.updateLease = (lease) => {
      if (lease.id === 'lease-1') {
        throw new Error('database is locked');
      }
      real(lease);
    };
    db.insertLease(m.newLease({ id: 'lease-2', principalId: account, teamId: db.teamOf(account), class: {}, queueTimeoutMs: 1000 }, clock.now - 5000));
    clock.now += 60 * 60_000;
    await leases.tick();
    await leases.tick();
    assert.equal(db.getLease('lease-2')?.state, 'ended', 'the second lease was still ended');
    assert.equal(logged.filter((l) => l.includes('lease-1')).length, 1, 'logged once with the lease id');
  } finally {
    console.error = log;
    db.sql.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an account may hold only so many leases at once, and says what to do', async () => {
  const { db, hosts, dir, leases, account } = await setup();
  try {
    hello(hosts, []);
    const other = auth.createAccount(db, 'bob', 'member').id;
    const principal = (id: string) => {
      const token = auth.mintToken(db, 'member', { accountId: id });
      const p = auth.authenticate(db, { authorization: `Bearer ${token}` }, Date.now());
      assert.ok(p);
      return p;
    };
    const alice = principal(account);
    const first = leases.create(alice, {});
    leases.create(alice, {});
    assert.throws(
      () => leases.create(alice, {}),
      (err) => err instanceof ApiError && err.status === 429 && err.code === 'TOO_MANY_LEASES' && /2 leases queued or running.*DEVICEPOOL_MAX_LEASES_PER_ACCOUNT/.test(err.message),
    );
    leases.create(principal(other), {});
    leases.release(alice, first.id);
    leases.create(alice, {});
  } finally {
    leases.stopped = true;
    db.sql.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the caps come from the environment and fall back to 50', () => {
  assert.deepEqual(capsFromEnv({}), { maxLeasesPerAccount: 50, maxShards: 50 });
  assert.deepEqual(capsFromEnv({ DEVICEPOOL_MAX_LEASES_PER_ACCOUNT: '200', DEVICEPOOL_MAX_SHARDS: '8' }), { maxLeasesPerAccount: 200, maxShards: 8 });
  assert.deepEqual(capsFromEnv({ DEVICEPOOL_MAX_LEASES_PER_ACCOUNT: 'many', DEVICEPOOL_MAX_SHARDS: '0' }), { maxLeasesPerAccount: 50, maxShards: 50 });
});

test('a run with more shards than the cap is refused with the numbers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-shards-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    broker.leases.caps.maxShards = 2;
    broker.db.insertBuild('abc123', 'App.app', join(dir, 'nothing'), 1);
    const token = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'ci', 'member').id });
    const res = await fetch(`${broker.url}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ build: 'App.app', shards: 3, suite: { kind: 'maestro', archive: 'dGFy', flows: ['a.yaml', 'b.yaml', 'c.yaml'] } }),
    });
    const body: { error: { code: string; message: string } } = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'TOO_MANY_SHARDS');
    assert.match(body.error.message, /at most 2 shards.*asked for 3.*DEVICEPOOL_MAX_SHARDS/);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
