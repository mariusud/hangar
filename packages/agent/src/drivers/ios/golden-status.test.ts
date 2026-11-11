import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceImage } from '@hangar/protocol';
import { imageStatus, planImages, type ImageSlot } from './golden.ts';

function img(name: string, id: string): DeviceImage {
  return { id, name, apps: [{ url: '/v1/artifacts/a', sha256: 'a' }] };
}

test('a host tells the broker when an image builds, is ready or failed, and why', () => {
  const waiting: ImageSlot = { image: img('nightly', 'n1'), golden: null, failed: false };
  assert.equal(imageStatus(waiting, false), null, 'an image waiting its turn says nothing');
  assert.deepEqual(imageStatus(waiting, true), { type: 'images.status', image: 'nightly', id: 'n1', state: 'building' });
  assert.deepEqual(imageStatus({ ...waiting, golden: 'gold-n1' }, false), { type: 'images.status', image: 'nightly', id: 'n1', state: 'ready' });
  assert.deepEqual(imageStatus({ ...waiting, failed: true, message: 'The sign-in flow failed.' }, false), {
    type: 'images.status',
    image: 'nightly',
    id: 'n1',
    state: 'failed',
    message: 'The sign-in flow failed.',
  });
  assert.deepEqual(imageStatus({ ...waiting, failed: true }, false), { type: 'images.status', image: 'nightly', id: 'n1', state: 'failed' });
  const long = imageStatus({ ...waiting, failed: true, message: `start ${'x'.repeat(5000)} end` }, false);
  assert.ok(long?.message && long.message.length <= 2000 && long.message.endsWith('end'), 'a long message keeps its end, where Maestro says what failed');
});

test('a failed image is tried again when the broker sends images, and a built one is kept', () => {
  const slots = new Map<string, ImageSlot>([
    ['broken', { image: img('broken', 'b1'), golden: null, failed: true, message: 'SIGN_IN_ENV_MISSING' }],
    ['built', { image: img('built', 'k1'), golden: 'gold-k1', failed: false }],
  ]);
  const plan = planImages(slots, [img('broken', 'b1'), img('built', 'k1')]);
  assert.deepEqual(plan.slots.get('broken'), { image: img('broken', 'b1'), golden: null, failed: false });
  assert.equal(plan.slots.get('built'), slots.get('built'));
  assert.deepEqual(plan.drop, []);
  assert.deepEqual(plan.retire, []);
});
