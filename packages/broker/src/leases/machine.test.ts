import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activate,
  assign,
  deadline,
  matches,
  due,
  end,
  newLease,
  prepareFailed,
  renew,
  schedule,
  touch,
  type Lease,
  type PoolDevice,
} from './machine.ts';

const iphone: PoolDevice = { deviceId: 'd1', model: 'iPhone 17', os: '26.5', build: null };

function lease(id: string, now = 0, extra: Partial<Lease> = {}): Lease {
  return newLease({ id, principalId: `p-${id}`, teamId: 't', class: {}, ...extra }, now);
}

test('a lease goes queued, preparing, active, ended', () => {
  let l = lease('a');
  l = assign(l, 'd1', 1);
  assert.equal(l.state, 'preparing');
  l = activate(l, 2);
  assert.equal(l.state, 'active');
  l = end(l, 'released', 3);
  assert.equal(l.state, 'ended');
  assert.equal(l.reason, 'released');
  assert.equal(end(l, 'expired', 4).reason, 'released', 'an ended lease keeps its first reason');
});

test('only active leases accept renew and device actions', () => {
  const l = lease('a');
  assert.throws(() => renew(l, 1), { code: 'LEASE_NOT_ACTIVE' });
  assert.throws(() => touch(end(l, 'cancelled', 1), 2), { code: 'LEASE_NOT_ACTIVE' });
});

test('deadline is the earliest of ttl, max duration and idle', () => {
  let l = activate(assign(lease('a', 0, { ttlMs: 100, maxMs: 1000, idleMs: 50 }), 'd1', 0), 0);
  assert.deepEqual(deadline(l), { at: 50, reason: 'idle' });
  l = touch(l, 40);
  assert.deepEqual(deadline(l), { at: 90, reason: 'idle' });
  l = renew(l, 80);
  assert.deepEqual(deadline(l), { at: 130, reason: 'idle' });
  l = { ...l, idleMs: 10_000 };
  assert.deepEqual(deadline(l), { at: 180, reason: 'expired' });
  l = { ...l, lastRenewAt: 990 };
  assert.deepEqual(deadline(l), { at: 1000, reason: 'expired' }, 'max duration caps renewals');
});

test('due ends queued, preparing and active leases on time', () => {
  const queued = lease('q', 0, { queueTimeoutMs: 10 });
  const preparing = assign(lease('p', 0, { prepareTimeoutMs: 10 }), 'd1', 0);
  const active = activate(assign(lease('a', 0, { idleMs: 10 }), 'd2', 0), 0);
  assert.deepEqual(due([queued, preparing, active], 9), []);
  assert.deepEqual(due([queued, preparing, active], 10), [
    { id: 'q', reason: 'queue_timeout' },
    { id: 'p', reason: 'failed' },
    { id: 'a', reason: 'idle' },
  ]);
});

test('a failed preparation retries, then fails', () => {
  let l = lease('a');
  for (let i = 0; i < 2; i++) {
    l = prepareFailed(assign(l, 'd1', i), i);
    assert.equal(l.state, 'queued');
  }
  l = prepareFailed(assign(l, 'd1', 3), 3);
  assert.equal(l.state, 'ended');
  assert.equal(l.reason, 'failed');
});

test('schedule matches class loosely and gives each device to one lease', () => {
  const a = lease('a', 0, { class: { model: 'iphone17' } });
  const b = lease('b', 1, { class: { model: 'iPhone 17' } });
  const c = lease('c', 2, { class: { model: 'iPad Pro' } });
  const out = schedule({
    queued: [a, b, c],
    ready: [iphone],
    activeByTeam: new Map(),
    activeByPrincipal: new Map(),
    quotaByTeam: new Map(),
  });
  assert.deepEqual(out, [{ leaseId: 'a', deviceId: 'd1' }]);
});

test('schedule prefers the team furthest under quota, then the least busy principal', () => {
  const busy = lease('busy', 0, { teamId: 'big', principalId: 'x' });
  const fresh = lease('fresh', 5, { teamId: 'small', principalId: 'y' });
  const devices = [iphone];
  const out = schedule({
    queued: [busy, fresh],
    ready: devices,
    activeByTeam: new Map([['big', 3]]),
    activeByPrincipal: new Map(),
    quotaByTeam: new Map([['big', 4], ['small', 4]]),
  });
  assert.deepEqual(out, [{ leaseId: 'fresh', deviceId: 'd1' }]);

  const p1 = lease('p1', 0, { principalId: 'hog' });
  const p2 = lease('p2', 9, { principalId: 'new' });
  const out2 = schedule({
    queued: [p1, p2],
    ready: devices,
    activeByTeam: new Map(),
    activeByPrincipal: new Map([['hog', 2]]),
    quotaByTeam: new Map(),
  });
  assert.deepEqual(out2, [{ leaseId: 'p2', deviceId: 'd1' }]);
});

test('schedule never exceeds a team quota', () => {
  const leases = ['a', 'b', 'c'].map((id, i) => lease(id, i));
  const ready = ['d1', 'd2', 'd3'].map((deviceId) => ({ ...iphone, deviceId }));
  const out = schedule({
    queued: leases,
    ready,
    activeByTeam: new Map([['t', 1]]),
    activeByPrincipal: new Map(),
    quotaByTeam: new Map([['t', 2]]),
  });
  assert.equal(out.length, 1);
});

// Random sequences of requests, scheduling, releases, device loss and clock jumps. After every
// step: a device has at most one lease in preparing or active, and every lease ends in bounded time.
test('property: no device is double-leased and every lease ends', () => {
  let seed = 42;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let run = 0; run < 200; run++) {
    let now = 0;
    let leases: Lease[] = [];
    const devices = ['d1', 'd2', 'd3'].map((deviceId) => ({ ...iphone, deviceId }));
    for (let step = 0; step < 60; step++) {
      const roll = rand(6);
      if (roll === 0) {
        leases.push(lease(`l${run}-${step}`, now, { principalId: `p${rand(3)}`, ttlMs: 1000, idleMs: 500, queueTimeoutMs: 2000 }));
      } else if (roll === 1) {
        const busy = new Set(leases.filter((l) => l.state === 'preparing' || l.state === 'active').map((l) => l.deviceId));
        const assignments = schedule({
          queued: leases.filter((l) => l.state === 'queued'),
          ready: devices.filter((d) => !busy.has(d.deviceId)),
          activeByTeam: new Map(),
          activeByPrincipal: new Map(),
          quotaByTeam: new Map(),
        });
        leases = leases.map((l) => {
          const a = assignments.find((x) => x.leaseId === l.id);
          return a ? assign(l, a.deviceId, now) : l;
        });
      } else if (roll === 2) {
        leases = leases.map((l) => (l.state === 'preparing' && rand(2) === 0 ? activate(l, now) : l));
      } else if (roll === 3) {
        leases = leases.map((l) => (l.state === 'preparing' && rand(3) === 0 ? prepareFailed(l, now) : l));
      } else if (roll === 4) {
        leases = leases.map((l) => (l.state === 'active' && rand(3) === 0 ? end(l, 'released', now) : l));
      } else {
        now += rand(700);
      }
      const ending = due(leases, now);
      leases = leases.map((l) => {
        const d = ending.find((x) => x.id === l.id);
        return d ? end(l, d.reason, now) : l;
      });

      const holding = leases.filter((l) => l.state === 'preparing' || l.state === 'active').map((l) => l.deviceId);
      assert.equal(new Set(holding).size, holding.length, 'a device is held by two leases');
    }
    // Let time run out: everything must end.
    leases = leases.map((l) => (l.state === 'preparing' ? activate(l, now) : l));
    now += 1_000_000;
    const ending = due(leases, now);
    leases = leases.map((l) => (ending.some((x) => x.id === l.id) ? end(l, 'expired', now) : l));
    assert.ok(leases.every((l) => l.state === 'ended'), 'a lease never ended');
  }
});

test('a device class picks iOS or Android; devices without a platform are iOS simulators', () => {
  const ios = { deviceId: 'a', model: 'iPhone 17', os: '26.5', build: null };
  const pixel = { deviceId: 'b', model: 'Pixel 8a', os: '16', build: null, platform: 'android-emulator' as const };
  assert.equal(matches({ platform: 'android-emulator' }, pixel), true);
  assert.equal(matches({ platform: 'android-emulator' }, ios), false);
  assert.equal(matches({ platform: 'ios-simulator' }, ios), true);
  assert.equal(matches({}, pixel), true);
});
