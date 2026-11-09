import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesField, encode } from './hid.ts';

test('HID events encode exactly as idb serializes them', () => {
  assert.equal(encode({ press: { touch: [200.5, 406] }, up: false }).toString('hex'), '0a180a160a140a12090000000000106940110000000000607940');
  assert.equal(encode({ press: { touch: [200.5, 406] }, up: true }).toString('hex'), '0a1a0a160a140a120900000000001069401100000000006079401001');
  assert.equal(encode({ press: { button: 1 }, up: true }).toString('hex'), '0a080a04120208011001');
  assert.equal(encode({ press: { key: 40 }, up: true }).toString('hex'), '0a080a041a0208281001');
  assert.equal(encode({ swipe: { from: [10, 20], to: [30, 40], durationS: 0.3 } }).toString('hex'), '12310a120900000000000024401100000000000034401212090000000000003e4011000000000000444031333333333333d33f');
});

test('bytesField finds a field after a double, a varint and another string', () => {
  const msg = Buffer.from([0x19, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, 0x20, 0xac, 0x02, 0x12, 3, 0x70, 0x6e, 0x67, 0x0a, 2, 0xab, 0xcd]);
  assert.equal(bytesField(msg, 2).toString(), 'png');
  assert.deepEqual([...bytesField(msg, 1)], [0xab, 0xcd]);
  assert.equal(bytesField(msg, 5).length, 0);
});
