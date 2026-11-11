import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceImage } from '@hangar/protocol';
import { buildImage, goldenImageName, planImages, readyImages, redact, retirable, signInEnv, type ImageSlot, type ImageSteps } from './golden.ts';

function fakeSteps(): { calls: string[]; steps: ImageSteps } {
  const calls: string[] = [];
  let n = 0;
  const steps: ImageSteps = {
    boot: async (udid) => {
      calls.push(`boot ${udid}`);
    },
    shutdown: async (udid) => {
      calls.push(`shutdown ${udid}`);
    },
    install: async (_udid, app) => {
      n += 1;
      calls.push(`install ${app.sha256}`);
      return { bundleId: `com.example.app${n}` };
    },
    grant: async (_udid, service, bundleId) => {
      calls.push(`grant ${service} ${bundleId}`);
    },
    setLocale: async (_udid, locale) => {
      calls.push(`locale ${locale}`);
    },
    appearance: async (_udid, mode) => {
      calls.push(`appearance ${mode}`);
    },
    signIn: async (_udid, flow, env) => {
      calls.push(`sign-in ${flow.length} ${JSON.stringify(env)}`);
    },
  };
  return { calls, steps };
}

const apps = [
  { url: 'http://broker/a', sha256: 'a' },
  { url: 'http://broker/b', sha256: 'b' },
];

test('an image without a setup builds as before', async () => {
  const { calls, steps } = fakeSteps();
  await buildImage('U', { id: '1', name: 'plain', apps: apps.slice(0, 1), appearance: 'dark' }, steps, {});
  assert.deepEqual(calls, ['boot U', 'install a', 'appearance dark', 'shutdown U']);
});

test('permissions go to every app, and the sign-in flow runs last on a rebooted device when the locale changed', async () => {
  const { calls, steps } = fakeSteps();
  const image: DeviceImage = {
    id: '2',
    name: 'signed-in',
    apps,
    locale: 'nb_NO',
    setup: { grants: ['location', 'photos'], signIn: { flow: 'abc', env: ['USER_EMAIL', 'USER_PASSWORD'], values: { USER_PASSWORD: 'from-broker' } } },
  };
  await buildImage('U', image, steps, { USER_EMAIL: 'qa@example.com', USER_PASSWORD: 'from-host', HOME: '/Users/qa' });
  assert.deepEqual(calls, [
    'boot U',
    'install a',
    'install b',
    'grant location com.example.app1',
    'grant location com.example.app2',
    'grant photos com.example.app1',
    'grant photos com.example.app2',
    'locale nb_NO',
    'shutdown U',
    'boot U',
    'sign-in 3 {"USER_EMAIL":"qa@example.com","USER_PASSWORD":"from-broker"}',
    'shutdown U',
  ]);
});

test('a missing value stops the build before the device boots, naming the variable and not any value', async () => {
  const { calls, steps } = fakeSteps();
  const image: DeviceImage = { id: '3', name: 'signed-in', apps, setup: { signIn: { flow: 'abc', env: ['USER_EMAIL', 'USER_PASSWORD'], values: { USER_EMAIL: 'qa@example.com' } } } };
  await assert.rejects(buildImage('U', image, steps, { USER_PASSWORD: '' }), (err: Error) => {
    assert.match(err.message, /USER_PASSWORD/);
    assert.doesNotMatch(err.message, /USER_EMAIL|qa@example/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('only the names the flow declares are passed, never the rest of the host environment', () => {
  const env = signInEnv({ flow: 'x', env: ['A'], values: {} }, { A: '1', AWS_SECRET_ACCESS_KEY: 'nope' });
  assert.deepEqual(env, { A: '1' });
});

test('secret values are blanked out of a failed flow log', () => {
  assert.equal(redact('typed hunter2 into hunter2-field for qa', ['hunter2', '', 'qa']), 'typed *** into ***-field for ***');
  assert.equal(redact('abcd abc', ['abc', 'abcd']), '*** ***');
});

function img(name: string, id: string): DeviceImage {
  return { id, name, apps: [{ sha256: id, url: `https://broker.test/v1/artifacts/${id}` }] };
}

test('a golden device is named after the image id, model and runtime', () => {
  assert.equal(goldenImageName('abc', 'iPhone 17 Pro', '26.1'), 'hangar-golden-image-abc-iPhone-17-Pro-26.1');
});

test('a refreshed image keeps leases on the old golden and retires it once they end', () => {
  let slots = new Map<string, ImageSlot>([
    ['nightly', { image: img('nightly', 'v1'), golden: 'gold-v1', failed: false }],
    ['plain', { image: img('plain', 'p1'), golden: 'gold-p1', failed: false }],
  ]);
  assert.deepEqual(readyImages(slots), ['nightly', 'plain']);

  const plan = planImages(slots, [img('nightly', 'v2'), img('plain', 'p1')]);
  slots = plan.slots;
  assert.deepEqual(plan.drop, ['nightly'], 'warm clones of the old build go at once');
  assert.deepEqual(plan.retire, ['gold-v1']);
  assert.equal(slots.get('plain')?.golden, 'gold-p1', 'an unchanged image keeps its golden');
  assert.deepEqual(slots.get('nightly'), { image: img('nightly', 'v2'), golden: null, failed: false });
  assert.deepEqual(readyImages(slots), ['plain'], 'new leases wait for the new build instead of getting the old one');

  const cloneOf = new Map([
    ['leased-1', 'gold-v1'],
    ['leased-2', 'gold-v1'],
    ['warm-p', 'gold-p1'],
  ]);
  assert.deepEqual(retirable(plan.retire, cloneOf, new Set(['leased-1', 'leased-2', 'warm-p'])), [], 'leases still use the old golden');
  assert.deepEqual(retirable(plan.retire, cloneOf, new Set(['leased-2', 'warm-p'])), []);
  assert.deepEqual(retirable(plan.retire, cloneOf, new Set(['warm-p'])), ['gold-v1'], 'the last lease ended');

  slots.set('nightly', { image: img('nightly', 'v2'), golden: 'gold-v2', failed: false });
  assert.deepEqual(readyImages(slots), ['nightly', 'plain']);
});

test('removing an image retires its golden, and a failed build is not offered', () => {
  const slots = new Map<string, ImageSlot>([['gone', { image: img('gone', 'g1'), golden: 'gold-g1', failed: false }]]);
  const plan = planImages(slots, [img('new', 'n1')]);
  assert.deepEqual(plan.drop, ['gone']);
  assert.deepEqual(plan.retire, ['gold-g1']);
  assert.deepEqual([...plan.slots.keys()], ['new']);
  assert.deepEqual(readyImages(plan.slots), [], 'an image is offered only once built');
  assert.deepEqual(readyImages(new Map([['new', { image: img('new', 'n1'), golden: 'gold-n1', failed: true }]])), []);
  const unbuilt = planImages(new Map([['x', { image: img('x', 'x1'), golden: null, failed: true }]]), [img('x', 'x2')]);
  assert.deepEqual(unbuilt.retire, [], 'an image that never built has no golden to retire');
  assert.equal(unbuilt.slots.get('x')?.failed, false, 'a new declaration gets a new try');
});
