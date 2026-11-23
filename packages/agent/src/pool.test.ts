import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepWarm, RECENT_LEASE_MS, spareDevice } from './index.ts';

const always = (): boolean => true;

test('a full Mac gives up an idle device of another class for a waiting lease', () => {
  const devices = [
    { deviceId: 'plain-busy', state: 'busy', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, ['signed-in'], 2, always), 'plain-ready');
});

test('nothing is given up with room left, without a wait, or when the class is already coming', () => {
  const devices = [
    { deviceId: 'plain-busy', state: 'busy', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, ['signed-in'], 3, always), null);
  assert.equal(spareDevice(devices, [], 2, always), null);
  assert.equal(spareDevice([...devices.slice(0, 1), { deviceId: 'signed-in-boot', state: 'wiping', image: 'signed-in', leaseId: null }], ['signed-in'], 2, always), null);
  assert.equal(spareDevice(devices, ['signed-in'], 2, () => false), null);
});

test('an idle device of a class that is also waiting is kept', () => {
  const devices = [
    { deviceId: 'signed-in-busy', state: 'busy', image: 'signed-in', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, ['signed-in', undefined], 2, always), null);
});

test('overdue lists leases past their deadline plus the grace period', async () => {
  const { overdue } = await import('./connect.ts');
  const deadlines = new Map([['late', 1000], ['inside-grace', 50_000], ['open', 500_000]]);
  assert.deepEqual(overdue(deadlines, 61_001, 60_000), ['late']);
  assert.deepEqual(overdue(deadlines, 1000, 60_000), []);
});

test('images leased lately stay warm, after the ones waiting leases want', () => {
  const now = 10 * RECENT_LEASE_MS;
  const leasedAt = new Map<string | undefined, number>([
    ['bison', now - 60_000],
    [undefined, now - RECENT_LEASE_MS - 1],
  ]);
  assert.deepEqual(keepWarm(['signed-in'], leasedAt, now), ['signed-in', 'bison']);
  assert.deepEqual(keepWarm([], new Map(), now), []);
  const devices = [
    { deviceId: 'bison-busy', state: 'busy', image: 'bison', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, keepWarm([], leasedAt, now), 2, always), 'plain-ready');
});
