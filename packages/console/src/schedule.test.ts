import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingBody, countdown, daysText, endingText, heldText, linkPath, logTail, mcpSettings, openAgainError, openAgainTarget, windowStatus } from './lib.js';

test('booking days read as words', () => {
  assert.equal(daysText(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), 'every day');
  assert.equal(daysText(['fri', 'mon', 'tue', 'wed', 'thu']), 'weekdays');
  assert.equal(daysText(['sun', 'sat']), 'weekends');
  assert.equal(daysText(['wed', 'mon']), 'mon, wed');
});

test('a booking says whether its window is open and when it changes', () => {
  const now = 1_000_000;
  assert.deepEqual(windowStatus({ open: { from: 0, to: now + 2 * 3_600_000 }, next: null }, now), { open: true, text: 'Open, closes in 2 hours' });
  assert.deepEqual(windowStatus({ open: null, next: { from: now + 90 * 60_000, to: now + 10 * 3_600_000 } }, now), { open: false, text: 'Opens in 1 hour 30 minutes' });
  assert.deepEqual(windowStatus({ open: null, next: { from: now + 82 * 3_600_000, to: now + 90 * 3_600_000 } }, now), { open: false, text: 'Opens in 3 days' });
  assert.deepEqual(windowStatus({ open: null, next: null }, now), { open: false, text: 'No window ahead' });
});

test('the booking form drops empty fields and wants a whole device count', () => {
  assert.deepEqual(bookingBody({ name: ' night ', devices: '2', days: 'mon-thu', from: '18:00', to: '07:00', image: '' }), { name: 'night', days: 'mon-thu', from: '18:00', to: '07:00', devices: 2 });
  assert.throws(() => bookingBody({ name: 'n', devices: '' }), /whole number/);
  assert.throws(() => bookingBody({ name: 'n', devices: '1.5' }), /whole number/);
  assert.throws(() => bookingBody({ name: 'n', devices: '0' }), /whole number/);
});

test('MCP settings match what hangar connect prints', () => {
  const s = mcpSettings('http://mac.local:7300/mcp', 'hgr_x');
  assert.deepEqual(JSON.parse(s.json), { mcpServers: { hangar: { url: 'http://mac.local:7300/mcp', headers: { Authorization: 'Bearer hgr_x' } } } });
  assert.equal(s.claude, 'claude mcp add --transport http hangar http://mac.local:7300/mcp --header "Authorization: Bearer hgr_x"');
});

test('a lease told it ends shows why and a countdown', () => {
  assert.equal(countdown(119_001), '2:00');
  assert.equal(countdown(61_000), '1:01');
  assert.equal(countdown(-5), '0:00');
  assert.match(endingText({ reason: 'preempted', at: 120_000 }, 0), /higher priority.*ends in 2:00/);
  assert.match(endingText({ reason: 'window_closed', at: 600_000 }, 0), /window is closing.*ends in 10:00/);
});

test('held devices, log tails and links', () => {
  assert.equal(heldText(30 * 60_000, 0), 'Kept as the flow left it for 30 minutes more.');
  assert.match(heldText(0, 1), /wipes/);
  assert.deepEqual(logTail([1, 2, 3, 4], 2), [3, 4]);
  assert.equal(logTail(Array.from({ length: 50 }, (_, i) => i)).length, 20);
  assert.equal(linkPath('http://mac.local:7300/v1/findings/f/screenshot.png'), '/v1/findings/f/screenshot.png');
  assert.equal(linkPath('http://mac.local:7300/v1/recordings/r/video.mp4#t=60,180'), '/v1/recordings/r/video.mp4#t=60,180');
  assert.equal(linkPath('http://mac.local:7300/v1/nights/n/report?format=md'), '/v1/nights/n/report?format=md');
});

test('open again goes to the new lease, and says so plainly when the broker has no such route', () => {
  assert.equal(openAgainTarget({ id: 'l1', state: 'queued' }), '/leases/l1');
  assert.equal(openAgainTarget({ lease: { id: 'l2' } }), '/leases/l2');
  assert.equal(openAgainTarget({ leaseId: 'l3' }), '/leases/l3');
  assert.equal(openAgainTarget({ url: 'http://h/leases/l4' }), '/leases/l4');
  assert.equal(openAgainTarget({}), null);
  assert.match(openAgainError({ code: 'NOT_FOUND', message: 'No route for POST /v1/findings/f/open-again.' }), /cannot open findings again yet/);
  assert.equal(openAgainError({ code: 'FINDING_NOT_FOUND', message: 'No finding f.' }), 'No finding f.');
});
