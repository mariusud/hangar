import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Booking, Hold, Priority } from '@hangar/protocol';
import { activate, assign, due, end, newLease, warn, type Lease } from './leases/machine.ts';
import {
  checkBooking,
  closedWindows,
  holdsDue,
  localTime,
  mayTakeHold,
  nextWindow,
  onWindowClosed,
  parseClock,
  parseDays,
  plan,
  PREEMPT_NOTICE_MS,
  WINDOW_NOTICE_MS,
  windowAt,
  windowClosed,
  type PlanDevice,
  type PlanInput,
} from './schedule.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Monday 2026-11-09 00:00 UTC.
const MONDAY = Date.UTC(2026, 10, 9);

function booking(fields: Partial<Booking> = {}): Booking {
  return { id: 'b1', name: 'nightly', teamId: 'qa', devices: 2, class: {}, days: ['mon', 'tue', 'wed', 'thu'], from: '18:00', to: '07:00', createdBy: 'x', createdAt: 0, ...fields };
}

function device(id: string, hostId = 'h1'): PlanDevice {
  return { deviceId: id, model: 'iPhone 17', os: '26.5', build: null, platform: 'ios-simulator', hostId };
}

function request(id: string, now: number, priority: Priority, extra: Partial<Lease> = {}): Lease {
  return newLease({ id, principalId: `p-${id}`, teamId: extra.teamId ?? 't', class: {}, priority, ...extra }, now);
}

function input(fields: Partial<PlanInput>): PlanInput {
  return {
    now: MONDAY,
    timeZone: 'UTC',
    queued: [],
    ready: [],
    returning: [],
    live: [],
    devices: new Map(),
    hostSizes: new Map([['h1', 4]]),
    floors: new Map([['h1', 0]]),
    bookings: [],
    holds: [],
    quotaByTeam: new Map(),
    ...fields,
  };
}

test('days, clock times and the local time in a zone', () => {
  assert.deepEqual(parseDays('mon-thu'), ['mon', 'tue', 'wed', 'thu']);
  assert.deepEqual(parseDays('fri-mon'), ['mon', 'fri', 'sat', 'sun'], 'a range wraps past Sunday');
  assert.deepEqual(parseDays('weekdays'), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(parseDays(['Monday', 'wed']), ['mon', 'wed']);
  assert.equal(parseDays('someday'), null);
  assert.equal(parseClock('7:05'), 425);
  assert.equal(parseClock('24:00'), null);
  assert.deepEqual(localTime(MONDAY + 18 * HOUR, 'UTC'), { day: 0, minute: 18 * 60 });
  assert.deepEqual(localTime(MONDAY + 23 * HOUR, 'Europe/Oslo'), { day: 1, minute: 0 }, 'Oslo is an hour ahead in November');
});

test('a window that ends before it starts runs past midnight, from the day it starts', () => {
  const b = booking();
  assert.equal(windowAt(b, MONDAY + 17 * HOUR, 'UTC'), null);
  assert.deepEqual(windowAt(b, MONDAY + 20 * HOUR, 'UTC'), { bookingId: 'b1', name: 'nightly', from: MONDAY + 18 * HOUR, to: MONDAY + 31 * HOUR });
  assert.equal(windowAt(b, MONDAY + 30 * HOUR, 'UTC')?.from, MONDAY + 18 * HOUR, 'Tuesday 06:00 is still in Monday’s window');
  assert.equal(windowAt(b, MONDAY + 3 * 24 * HOUR + 30 * HOUR, 'UTC')?.from, MONDAY + 3 * 24 * HOUR + 18 * HOUR, 'Friday morning ends Thursday’s window');
  assert.equal(windowAt(b, MONDAY + 4 * 24 * HOUR + 20 * HOUR, 'UTC'), null, 'no window starts on Friday');
  assert.equal(windowAt(b, MONDAY + 20 * HOUR, 'Europe/Oslo')?.from, MONDAY + 17 * HOUR);
  assert.equal(nextWindow(b, MONDAY + 3 * 24 * HOUR + 8 * HOUR, 'UTC')?.from, MONDAY + 3 * 24 * HOUR + 18 * HOUR);
  assert.equal(nextWindow(b, MONDAY + 4 * 24 * HOUR + 8 * HOUR, 'UTC')?.from, MONDAY + 7 * 24 * HOUR + 18 * HOUR, 'after Thursday comes next Monday');
});

test('a booking may not need more devices than the hosts have after the CI floor', () => {
  const hosts = [
    { name: 'a', floor: 1, devices: [device('1'), device('2'), device('3')] },
    { name: 'b', floor: 1, devices: [device('4'), device('5')] },
  ];
  assert.equal(checkBooking(booking({ devices: 3 }), [], hosts).ok, true);
  const tooMany = checkBooking(booking({ devices: 4 }), [], hosts);
  assert.equal(tooMany.ok, false);
  const day = booking({ id: 'b2', name: 'day', devices: 2, from: '06:00', to: '08:00', days: ['tue'] });
  assert.equal(checkBooking(day, [booking({ devices: 2 })], hosts).ok, false, 'Tuesday 06:00 to 07:00 overlaps Monday night');
  assert.equal(checkBooking({ ...day, from: '07:00', to: '09:00' }, [booking({ devices: 2 })], hosts).ok, true, 'back to back is fine');
  assert.equal(checkBooking({ ...day, class: { platform: 'android-emulator' } }, [booking({ devices: 3, class: { platform: 'ios-simulator' } })], [...hosts, { name: 'c', floor: 0, devices: [{ ...device('6'), platform: 'android-emulator' }, { ...device('7'), platform: 'android-emulator' }] }]).ok, true, 'other devices do not compete');
  assert.equal(checkBooking(booking({ class: { image: 'signed-in' }, devices: 3 }), [], hosts).ok, true, 'an image counts plain simulators');
});

test('ci goes before interactive before booked, and inside a booking shards go first', () => {
  const now = MONDAY + 20 * HOUR;
  const b = booking({ devices: 1 });
  const queued = [
    request('agent', now - 5000, 'booked', { bookingId: 'b1' }),
    request('shard', now - 1000, 'booked', { bookingId: 'b1', shard: true }),
    request('person', now - 4000, 'interactive'),
    request('ci', now - 10, 'ci'),
  ];
  const ready = [device('1'), device('2'), device('3')];
  const out = plan(input({ now, queued, ready, bookings: [b], hostSizes: new Map([['h1', 4]]) }));
  const order = out.assignments.map((a) => a.leaseId);
  assert.deepEqual(order, ['ci', 'person', 'shard'], 'the booking keeps one device, for its shard first');
  assert.equal(out.assignments.find((a) => a.leaseId === 'shard')?.windowEndsAt, MONDAY + 31 * HOUR);
});

test('a booked request before its window waits, and an interactive one cannot take a booked device', () => {
  const b = booking({ devices: 1 });
  const early = request('early', MONDAY + 17 * HOUR, 'booked', { bookingId: 'b1' });
  assert.deepEqual(plan(input({ now: MONDAY + 17 * HOUR, queued: [early], ready: [device('1')], bookings: [b] })).assignments, []);
  const at = MONDAY + 18 * HOUR;
  const person = request('person', at - 1, 'interactive');
  const out = plan(input({ now: at, queued: [person], ready: [device('1')], hostSizes: new Map([['h1', 1]]), bookings: [b] }));
  assert.deepEqual(out.assignments, [], 'the free device is the booking’s');
  assert.equal(out.reserved.get('1'), 'b1');
  const withFloor = plan(input({ now: at, queued: [person], ready: [device('1')], hostSizes: new Map([['h1', 1]]), floors: new Map([['h1', 1]]), bookings: [b] }));
  assert.deepEqual(withFloor.assignments.map((a) => a.leaseId), ['person'], 'the CI floor is never a booking’s');
});

test('a ci request with every device taken ends the lowest-priority, newest lease in two minutes', () => {
  const now = MONDAY + 20 * HOUR;
  const live = [
    active(request('person', now - 50 * MIN, 'interactive'), '1', now - 50 * MIN),
    active(request('old-agent', now - 40 * MIN, 'booked', { bookingId: 'b1' }), '2', now - 40 * MIN),
    active(request('new-agent', now - 30 * MIN, 'booked', { bookingId: 'b1' }), '3', now - 30 * MIN),
    active(request('shard', now - 10 * MIN, 'booked', { bookingId: 'b1', shard: true }), '4', now - 10 * MIN),
  ];
  const devices = new Map(['1', '2', '3', '4'].map((id) => [id, device(id)]));
  const ci = request('ci', now - 1, 'ci');
  const out = plan(input({ now, queued: [ci], live, devices, bookings: [booking({ devices: 3 })] }));
  assert.deepEqual(out.endings, [{ leaseId: 'new-agent', ending: { reason: 'preempted', at: now + PREEMPT_NOTICE_MS } }], 'agent leases before shards, newest first');
  assert.deepEqual(out.preempting, ['ci']);
  const person = request('person2', now - 1, 'interactive');
  assert.deepEqual(plan(input({ now, queued: [person], live, devices, bookings: [booking({ devices: 3 })] })).endings, [], 'interactive does not take booked devices');
});

test('booked leases are told ten minutes before the window closes, and end when it does', () => {
  const b = booking();
  const close = MONDAY + 31 * HOUR;
  const lease = active(request('agent', MONDAY + 20 * HOUR, 'booked', { bookingId: 'b1', windowEndsAt: close }), '1', MONDAY + 20 * HOUR);
  const devices = new Map([['1', device('1')]]);
  assert.deepEqual(plan(input({ now: close - WINDOW_NOTICE_MS - 1, live: [lease], devices, bookings: [b] })).endings, []);
  assert.deepEqual(plan(input({ now: close - WINDOW_NOTICE_MS, live: [lease], devices, bookings: [b] })).endings, [{ leaseId: 'agent', ending: { reason: 'window_closed', at: close } }]);
  assert.deepEqual(plan(input({ now: close - HOUR, live: [lease], devices, bookings: [] })).endings[0]?.ending, { reason: 'window_closed', at: close - HOUR }, 'a removed booking ends its leases now');
  const long = { ...lease, idleMs: 100 * HOUR, maxMs: 100 * HOUR, ttlMs: 100 * HOUR };
  assert.deepEqual(due([long], close), [{ id: 'agent', reason: 'window_closed' }]);
});

test('holds end on time and only people on the team take them', () => {
  const hold: Hold = { deviceId: 'd', hostLeaseId: 'l', runId: 'r', flow: 'f', teamId: 'qa', until: 100, leaseId: null };
  assert.deepEqual(holdsDue([hold], 99), []);
  assert.deepEqual(holdsDue([hold], 100), [hold]);
  assert.equal(mayTakeHold(hold, { teamId: 'qa', person: true }), true);
  assert.equal(mayTakeHold(hold, { teamId: 'qa', person: false }), false);
  assert.equal(mayTakeHold(hold, { teamId: 'web', person: true }), false);
});

test('a held device counts against its team’s quota', () => {
  const hold: Hold = { deviceId: 'd', hostLeaseId: 'l', runId: 'r', flow: 'f', teamId: 'qa', until: MONDAY + HOUR, leaseId: null };
  const q = request('q', MONDAY, 'interactive', { teamId: 'qa' });
  assert.deepEqual(plan(input({ queued: [q], ready: [device('1')], holds: [hold], quotaByTeam: new Map([['qa', 1]]) })).assignments, []);
  assert.equal(plan(input({ queued: [q], ready: [device('1')], quotaByTeam: new Map([['qa', 1]]) })).assignments.length, 1);
});

test('closed windows reach the registered callback', () => {
  const seen: string[] = [];
  const stop = onWindowClosed((w) => seen.push(w.name));
  const w = { bookingId: 'b1', name: 'nightly', from: 1, to: 2 };
  for (const c of closedWindows([w], [])) {
    windowClosed(c);
  }
  assert.deepEqual(closedWindows([w], [w]), []);
  stop();
  windowClosed({ ...w, name: 'after' });
  assert.deepEqual(seen, ['nightly']);
});

function active(l: Lease, deviceId: string, at: number): Lease {
  return activate(assign(l, deviceId, at), at);
}

// ---- Property tests: a small fleet, simulated a second at a time ----

type Sim = {
  now: number;
  devices: PlanDevice[];
  wiping: { device: PlanDevice; readyAt: number }[];
  leases: Lease[];
  holds: Hold[];
  used: Set<string>;
  heldEver: Map<string, string>;
  next: number;
};

function rng(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s % n;
  };
}

// One scheduler tick, as the broker runs it: end what is due, then plan and apply.
function tick(sim: Sim, bookings: Booking[], floors: Map<string, number>, check: (out: ReturnType<typeof plan>, sim: Sim) => void): void {
  for (const d of due(sim.leases, sim.now)) {
    const i = sim.leases.findIndex((l) => l.id === d.id);
    const l = sim.leases[i];
    if (!l) {
      continue;
    }
    sim.leases[i] = end(l, d.reason, sim.now);
    const dev = sim.devices.find((x) => x.deviceId === l.deviceId);
    if (dev && !sim.holds.some((h) => h.deviceId === dev.deviceId)) {
      sim.wiping.push({ device: dev, readyAt: sim.now + 3000 });
    }
  }
  for (const w of sim.wiping.filter((x) => x.readyAt <= sim.now)) {
    // A wiped device comes back with a new id, as simulators do.
    sim.devices = sim.devices.filter((d) => d.deviceId !== w.device.deviceId).concat({ ...w.device, deviceId: `d${sim.next++}` });
  }
  sim.wiping = sim.wiping.filter((x) => x.readyAt > sim.now);
  const live = sim.leases.filter((l) => l.state === 'preparing' || l.state === 'active');
  const busy = new Set(live.map((l) => l.deviceId));
  const held = new Set(sim.holds.map((h) => h.deviceId));
  const wiping = new Set(sim.wiping.map((w) => w.device.deviceId));
  const out = plan({
    now: sim.now,
    timeZone: 'UTC',
    queued: sim.leases.filter((l) => l.state === 'queued'),
    ready: sim.devices.filter((d) => !busy.has(d.deviceId) && !held.has(d.deviceId) && !wiping.has(d.deviceId) && !sim.used.has(d.deviceId)),
    returning: sim.wiping.map((w) => w.device),
    live,
    devices: new Map(sim.devices.map((d) => [d.deviceId, d])),
    hostSizes: new Map([...new Set(sim.devices.map((d) => d.hostId))].map((h) => [h, sim.devices.filter((d) => d.hostId === h).length])),
    floors,
    bookings,
    holds: sim.holds,
    quotaByTeam: new Map(),
  });
  check(out, sim);
  for (const e of out.endings) {
    sim.leases = sim.leases.map((l) => (l.id === e.leaseId ? warn(l, e.ending) : l));
  }
  for (const id of out.preempting) {
    sim.leases = sim.leases.map((l) => (l.id === id ? { ...l, preemptedAt: sim.now } : l));
  }
  for (const a of out.assignments) {
    sim.used.add(a.deviceId);
    sim.leases = sim.leases.map((l) => (l.id === a.leaseId ? { ...activate(assign(l, a.deviceId, sim.now), sim.now), windowEndsAt: a.windowEndsAt } : l));
  }
}

function newSim(devices: number, hosts = 1): Sim {
  return {
    now: MONDAY + 17 * HOUR,
    devices: Array.from({ length: devices }, (_, i) => device(`d${i}`, `h${i % hosts}`)),
    wiping: [],
    leases: [],
    holds: [],
    used: new Set(),
    heldEver: new Map(),
    next: devices,
  };
}

function ask(sim: Sim, id: string, priority: Priority, fields: Partial<Lease> = {}): void {
  sim.leases.push(newLease({ id, principalId: `p-${id}`, teamId: 't', class: {}, priority, idleMs: 100 * HOUR, maxMs: 100 * HOUR, ttlMs: 100 * HOUR, queueTimeoutMs: 100 * HOUR, ...fields }, sim.now));
}

test('property: a device belongs to at most one booking at any moment, and a booked lease never outlives its window', () => {
  const rand = rng(11);
  for (let run = 0; run < 40; run++) {
    const sim = newSim(4 + rand(5), 1 + rand(2));
    const bookings = [
      booking({ id: 'b1', name: 'night', devices: 1 + rand(2), from: '18:00', to: '19:00', days: ['mon'] }),
      booking({ id: 'b2', name: 'evening', devices: 1 + rand(2), from: '18:30', to: '20:00', days: ['mon'], createdAt: 1 }),
    ];
    const floors = new Map([['h0', rand(2)], ['h1', rand(2)]]);
    let n = 0;
    let booked = 0;
    const windowEnd = new Map([['b1', MONDAY + 19 * HOUR], ['b2', MONDAY + 20 * HOUR]]);
    for (let s = 0; s < 4 * 3600; s += 5) {
      sim.now = MONDAY + 17 * HOUR + s * 1000;
      const roll = rand(20);
      if (roll === 0) {
        ask(sim, `r${n++}`, 'booked', { bookingId: rand(2) ? 'b1' : 'b2', shard: rand(2) === 0 });
      } else if (roll === 1) {
        ask(sim, `r${n++}`, rand(3) === 0 ? 'ci' : 'interactive');
      } else if (roll === 2) {
        const live = sim.leases.filter((l) => l.state === 'active');
        const l = live[rand(Math.max(1, live.length))];
        if (l) {
          sim.leases = sim.leases.map((x) => (x.id === l.id ? end(x, 'released', sim.now) : x));
          const dev = sim.devices.find((d) => d.deviceId === l.deviceId);
          if (dev) {
            sim.wiping.push({ device: dev, readyAt: sim.now + 3000 });
          }
        }
      }
      tick(sim, bookings, floors, (out, state) => {
        const owner = new Map<string, string>();
        for (const l of state.leases.filter((x) => (x.state === 'active' || x.state === 'preparing') && x.bookingId)) {
          assert.ok(l.deviceId && !owner.has(l.deviceId), 'a device in two booked leases');
          owner.set(l.deviceId ?? '', l.bookingId ?? '');
        }
        for (const [deviceId, bookingId] of out.reserved) {
          assert.ok(!owner.has(deviceId) || owner.get(deviceId) === bookingId, 'a device kept for one booking and leased to another');
        }
        const fresh = new Map<string, string>();
        for (const a of out.assignments) {
          const l = state.leases.find((x) => x.id === a.leaseId);
          assert.ok(!owner.has(a.deviceId) && !fresh.has(a.deviceId), 'a device assigned twice');
          if (l?.priority === 'booked' && l.bookingId) {
            fresh.set(a.deviceId, l.bookingId);
          }
        }
        for (const deviceId of out.reserved.keys()) {
          assert.ok(!fresh.has(deviceId), 'a device both kept for a booking and assigned');
        }
        for (const b of bookings) {
          const count = (m: Map<string, string>): number => [...m.values()].filter((x) => x === b.id).length;
          const held = count(owner) + count(fresh) + count(out.reserved);
          booked += count(fresh);
          assert.ok(held <= b.devices, `${b.name} holds more devices than it booked`);
        }
      });
      for (const l of sim.leases.filter((x) => x.bookingId)) {
        const close = windowEnd.get(l.bookingId ?? '') ?? 0;
        if (l.state === 'active') {
          assert.ok(sim.now < close + 5000, 'a booked lease is still active after its window');
        }
        if (l.state === 'ended' && l.activatedAt !== null) {
          assert.ok((l.endedAt ?? 0) <= close + 5000, 'a booked lease ended after its window');
        }
      }
    }
    assert.ok(booked > 0, 'no booked lease ever got a device');
  }
});

test('property: a ci request that arrives while booked agents hold every device gets one within 2 minutes 5 seconds', () => {
  const rand = rng(23);
  for (let run = 0; run < 60; run++) {
    const count = 1 + rand(6);
    const sim = newSim(count);
    const bookings = [booking({ devices: count, from: '18:00', to: '07:00' })];
    const floors = new Map([['h0', 0]]);
    sim.now = MONDAY + 18 * HOUR;
    for (let i = 0; i < count; i++) {
      ask(sim, `agent${i}`, 'booked', { bookingId: 'b1', shard: rand(3) === 0 });
    }
    tick(sim, bookings, floors, () => {});
    assert.equal(sim.leases.filter((l) => l.state === 'active').length, count, 'the agents hold every device');
    sim.now += rand(3600) * 1000;
    ask(sim, 'ci', 'ci');
    const arrived = sim.now;
    // Agents keep asking for devices while the ci request waits.
    let n = 0;
    while (sim.leases.find((l) => l.id === 'ci')?.state === 'queued') {
      if (rand(4) === 0) {
        ask(sim, `more${n++}`, 'booked', { bookingId: 'b1' });
      }
      sim.now += 1000;
      tick(sim, bookings, floors, () => {});
      assert.ok(sim.now - arrived <= 125_000, `the ci request waited ${(sim.now - arrived) / 1000} s`);
    }
    const preempted = sim.leases.filter((l) => l.reason === 'preempted');
    assert.equal(preempted.length, 1, 'one preemption serves one ci request');
  }
});

test('property: a held device is wiped before anyone outside its run’s team leases it', () => {
  const rand = rng(5);
  for (let run = 0; run < 30; run++) {
    const sim = newSim(3 + rand(3));
    let n = 0;
    for (let s = 0; s < 3600; s += 10) {
      sim.now = MONDAY + s * 1000;
      const roll = rand(10);
      const teams = ['qa', 'web'];
      if (roll < 3) {
        ask(sim, `r${n++}`, 'interactive', { teamId: teams[rand(2)] ?? 'qa' });
      } else if (roll < 5) {
        const live = sim.leases.filter((l) => l.state === 'active' && !l.hostLeaseId);
        const l = live[rand(Math.max(1, live.length))];
        if (l?.deviceId) {
          sim.leases = sim.leases.map((x) => (x.id === l.id ? end(x, 'released', sim.now) : x));
          if (rand(2) === 0) {
            // The run asked for a hold: the device keeps its state for its team.
            const hold: Hold = { deviceId: l.deviceId, hostLeaseId: l.id, runId: 'run', flow: `f${n}`, teamId: l.teamId, until: sim.now + rand(600) * 1000, leaseId: null };
            sim.holds.push(hold);
            sim.heldEver.set(l.deviceId, l.teamId);
          } else {
            const dev = sim.devices.find((d) => d.deviceId === l.deviceId);
            if (dev) {
              sim.wiping.push({ device: dev, readyAt: sim.now + 3000 });
            }
          }
        }
      } else if (roll < 7 && sim.holds.length) {
        const hold = sim.holds[rand(sim.holds.length)];
        const who = { teamId: teams[rand(2)] ?? 'qa', person: rand(4) !== 0 };
        if (hold && !hold.leaseId && mayTakeHold(hold, who)) {
          const id = `h${n++}`;
          const l = activate(assign(newLease({ id, principalId: `p-${id}`, teamId: who.teamId, class: {}, hostLeaseId: hold.hostLeaseId, maxMs: hold.until - sim.now + 1, idleMs: HOUR, ttlMs: HOUR }, sim.now), hold.deviceId, sim.now), sim.now);
          sim.leases.push(l);
          hold.leaseId = id;
        }
      }
      // A hold ends at its time, or when the lease on it ends; then the device is wiped.
      for (const hold of [...sim.holds]) {
        const lease = hold.leaseId ? sim.leases.find((l) => l.id === hold.leaseId) : undefined;
        const over = holdsDue([hold], sim.now).length > 0 || lease?.state === 'ended';
        if (over) {
          if (lease && lease.state !== 'ended') {
            sim.leases = sim.leases.map((l) => (l.id === lease.id ? end(l, 'expired', sim.now) : l));
          }
          sim.holds = sim.holds.filter((h) => h !== hold);
          const dev = sim.devices.find((d) => d.deviceId === hold.deviceId);
          if (dev) {
            sim.wiping.push({ device: dev, readyAt: sim.now + 3000 });
          }
        }
      }
      tick(sim, [], new Map(), () => {});
      for (const l of sim.leases.filter((x) => x.state === 'active' && x.deviceId && sim.heldEver.has(x.deviceId))) {
        assert.equal(l.teamId, sim.heldEver.get(l.deviceId ?? ''), 'someone outside the team leased a held device');
        assert.ok(l.hostLeaseId, 'a held device was leased by the scheduler instead of through its run');
      }
    }
  }
});

