import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spareDevice } from './index.ts';

const always = (): boolean => true;

test('a full Mac gives up an idle device of another class for a waiting lease', () => {
  const devices = [
    { deviceId: 'plain-busy', state: 'busy', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, ['bison'], 2, always), 'plain-ready');
});

test('nothing is given up with room left, without a wait, or when the class is already coming', () => {
  const devices = [
    { deviceId: 'plain-busy', state: 'busy', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, ['bison'], 3, always), null);
  assert.equal(spareDevice(devices, [], 2, always), null);
  assert.equal(spareDevice([...devices.slice(0, 1), { deviceId: 'bison-boot', state: 'wiping', image: 'bison', leaseId: null }], ['bison'], 2, always), null);
  assert.equal(spareDevice(devices, ['bison'], 2, () => false), null);
});

test('an idle device of a class that is also waiting is kept', () => {
  const devices = [
    { deviceId: 'bison-busy', state: 'busy', image: 'bison', leaseId: 'l1' },
    { deviceId: 'plain-ready', state: 'ready', leaseId: null },
  ];
  assert.equal(spareDevice(devices, ['bison', undefined], 2, always), null);
});
