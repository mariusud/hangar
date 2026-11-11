import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activate,
  assign,
  deadline,
  detach,
  keepalive,
  matches,
  reattach,
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

test('a lease that loses its client is not idle during the grace period', () => {
  let l = activate(assign(lease('a', 0, { ttlMs: 10_000, maxMs: 10_000, idleMs: 100, graceMs: 60 }), 'd1', 0), 0);
  l = detach(l, 90);
  assert.deepEqual(deadline(l), { at: 150, reason: 'idle' }, 'idle would be 100; grace runs to 150');
  l = detach(touch(l, 95), 95);
  assert.deepEqual(deadline(l), { at: 195, reason: 'idle' }, 'grace never shortens the idle limit');
  assert.deepEqual(due([l], 194), []);
  l = reattach(l, 120);
  assert.equal(l.detachedAt, null);
  assert.deepEqual(deadline(l), { at: 220, reason: 'idle' }, 'reattaching counts as activity');
  assert.throws(() => reattach(end(l, 'idle', 300), 301), { code: 'LEASE_ENDED' });
  const queued = lease('q');
  assert.equal(reattach(queued, 5), queued, 'a queued lease carries on waiting');
});

test('keepalive counts as activity and renews, and only for an active lease', () => {
  let l = activate(assign(lease('a', 0, { ttlMs: 100, maxMs: 1000, idleMs: 50 }), 'd1', 0), 0);
  l = keepalive(l, 40);
  assert.deepEqual(deadline(l), { at: 90, reason: 'idle' });
  l = { ...l, idleMs: 500 };
  assert.deepEqual(deadline(l), { at: 140, reason: 'expired' }, 'keepalive renews the ttl');
  assert.throws(() => keepalive(lease('q'), 1), { code: 'LEASE_NOT_ACTIVE' });
});

test('a lease stored before grace existed still has a deadline', () => {
  const l = activate(assign(lease('a', 0, { idleMs: 50 }), 'd1', 0), 0);
  const { graceMs: _g, detachedAt: _d, ...stripped } = l;
  const old: Lease = JSON.parse(JSON.stringify(stripped));
  assert.deepEqual(deadline(old), { at: 50, reason: 'idle' });
});

test('property: keepalive, disconnects and reattaches never end a lease early or past its longest', () => {
  let seed = 7;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let run = 0; run < 300; run++) {
    let now = 0;
    const idleMs = 100 + rand(400);
    const graceMs = rand(300);
    const maxMs = 2000 + rand(4000);
    let l = activate(assign(lease(`r${run}`, 0, { ttlMs: maxMs, maxMs, idleMs, graceMs }), 'd1', 0), 0);
    let lastUse = 0;
    let lastDetach: number | null = null;
    while (l.state === 'active') {
      const before = deadline(l);
      const roll = rand(5);
      if (roll === 0) {
        l = keepalive(l, now);
        lastUse = now;
        lastDetach = null;
      } else if (roll === 1) {
        l = detach(l, now);
        lastDetach = now;
      } else if (roll === 2) {
        l = reattach(l, now);
        lastUse = now;
        lastDetach = null;
      } else {
        now += rand(idleMs + graceMs + 50);
      }
      const after = deadline(l);
      assert.ok(after && after.at <= maxMs, 'a lease outlives its longest-lease limit');
      if (before && roll === 1) {
        assert.ok(after.at >= before.at, 'a disconnect made the deadline earlier');
      }
      if (roll === 0 || roll === 2) {
        assert.ok(after.at >= Math.min(now + idleMs, maxMs), 'keepalive or reattach left less than the idle limit');
      }
      for (const d of due([l], now)) {
        if (d.reason === 'idle') {
          assert.ok(now >= lastUse + idleMs, 'ended idle while in use');
          assert.ok(lastDetach === null || now >= lastDetach + graceMs, 'ended idle inside the grace period');
        }
        assert.ok(now >= lastUse + Math.min(idleMs, maxMs) || now >= maxMs, 'ended before any limit');
        l = end(l, d.reason, now);
      }
    }
    assert.ok(l.endedAt !== null && l.endedAt >= Math.min(maxMs, lastUse + idleMs));
  }
});
