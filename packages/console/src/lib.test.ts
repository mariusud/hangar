import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRerun, canRotate, capSeconds, capValue, deviceRows, duration, flowRecordings, isLanguageTag, LANGUAGES, leaseClass, LIMIT_FIELDS, limitsText, parseEnv, percent, viewExpiry, withView } from './lib.js';

const devices = [
  { platform: 'ios-simulator', model: 'iPhone 17', os: '26.5', host: 'mac-1', state: 'ready', image: null },
  { platform: 'ios-simulator', model: 'iPhone 17', os: '26.5', host: 'mac-1', state: 'leased', image: null },
  { platform: 'ios-simulator', model: 'iPhone 17', os: '26.5', host: 'mac-1', state: 'ready', image: 'signed-in' },
  { platform: 'android-emulator', model: 'Pixel 9', os: '15', host: 'mac-2', state: 'ready' },
];

test('device rows count only devices with the chosen image, or none', () => {
  assert.deepEqual(deviceRows(devices, null).map((r) => [r.model, r.free, r.total]), [['iPhone 17', 1, 2], ['Pixel 9', 1, 1]]);
  assert.deepEqual(deviceRows(devices, 'signed-in').map((r) => [r.model, r.free, r.total]), [['iPhone 17', 1, 1]]);
  assert.deepEqual(deviceRows(devices, 'other'), []);
});

test('a lease class carries the image only when one is chosen', () => {
  const [row] = deviceRows(devices, null);
  assert.deepEqual(leaseClass(row ?? null, null), { platform: 'ios-simulator', model: 'iPhone 17', os: '26.5' });
  assert.deepEqual(leaseClass(row ?? null, 'signed-in'), { platform: 'ios-simulator', model: 'iPhone 17', os: '26.5', image: 'signed-in' });
  assert.deepEqual(leaseClass(null, 'signed-in'), { image: 'signed-in' });
});

test('view-only links carry the view code to every file and show when they end', () => {
  assert.equal(withView('/v1/recordings/r1/video.mp4', null), '/v1/recordings/r1/video.mp4');
  assert.equal(withView('/v1/recordings/r1/video.mp4', '123.a-b_c'), '/v1/recordings/r1/video.mp4?view=123.a-b_c');
  assert.equal(withView('/x?a=1', '1.z'), '/x?a=1&view=1.z');
  assert.equal(viewExpiry('1767225600000.abc'), 1767225600000);
  assert.equal(viewExpiry('nope'), null);
  assert.equal(viewExpiry(null), null);
});

test('the language list holds tags the iOS driver accepts', () => {
  for (const [tag] of LANGUAGES) {
    assert.ok(isLanguageTag(tag), tag);
  }
  assert.equal(isLanguageTag('nb_NO'), false);
});

test('lease limits read as plain durations', () => {
  assert.equal(duration(5 * 60_000), '5 minutes');
  assert.equal(duration(60_000), '1 minute');
  assert.equal(duration(4 * 3_600_000), '4 hours');
  assert.equal(duration(90 * 60_000), '1 hour 30 minutes');
  assert.equal(duration(0), '1 minute');
  assert.equal(limitsText({ idleMs: 2 * 3_600_000, maxMs: 8 * 3_600_000 }), 'Yours until you release it, leave it idle for 2 hours, or have held it for 8 hours. It is wiped when it ends.');
});

test('a flow links the first failed attempt and the retry, once each', () => {
  const first = 'http://mac.local:7300/recordings/r1';
  assert.deepEqual(flowRecordings({ flow: 'a', status: 'passed' }), []);
  assert.deepEqual(flowRecordings({ flow: 'a', status: 'failed', firstRecording: first }), [{ label: 'First failure', href: '/recordings/r1' }]);
  assert.deepEqual(flowRecordings({ flow: 'a', status: 'flaky', firstRecording: first, recording: 'http://mac.local:7300/recordings/r2' }), [
    { label: 'First failure', href: '/recordings/r1' },
    { label: 'Latest attempt', href: '/recordings/r2' },
  ]);
  assert.equal(flowRecordings({ flow: 'a', status: 'failed', firstRecording: first, recording: first }).length, 1);
  assert.deepEqual(flowRecordings({ flow: 'a', status: 'failed', recording: '/recordings/r4' }), [{ label: 'Recording', href: '/recordings/r4' }]);
});

test('only failed and flaky flows of a finished run can be rerun', () => {
  assert.equal(canRerun({ state: 'failed' }, { flow: 'a', status: 'failed' }), true);
  assert.equal(canRerun({ state: 'passed' }, { flow: 'a', status: 'flaky' }), true);
  assert.equal(canRerun({ state: 'passed' }, { flow: 'a', status: 'passed' }), false);
  assert.equal(canRerun({ state: 'running' }, { flow: 'a', status: 'failed' }), false);
});

test('rerun env is KEY=value lines', () => {
  assert.deepEqual(parseEnv('USER=test\n\n# note\nPASS = a=b \n'), { USER: 'test', PASS: ' a=b' });
  assert.throws(() => parseEnv('nope'), /KEY=value/);
  assert.throws(() => parseEnv('=x'), /KEY=value/);
});

test('rates, rotation and limit caps', () => {
  assert.equal(percent(0.333), '33%');
  assert.equal(canRotate('android-emulator'), true);
  assert.equal(canRotate('ios-simulator'), false);
  const [idle, max] = LIMIT_FIELDS;
  assert.ok(idle && max);
  assert.equal(capSeconds('30', idle), 1800);
  assert.equal(capSeconds('1.5', max), 5400);
  assert.equal(capSeconds(' ', idle), null);
  assert.throws(() => capSeconds('-1', idle), /positive number of minutes/);
  assert.throws(() => capSeconds('abc', max), /positive number of hours/);
  assert.equal(capValue(2 * 3_600_000, idle), '120');
  assert.equal(capValue(5400_000, max), '1.5');
});
