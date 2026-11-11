import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronFor } from './client.ts';
import { parseDuration } from './client/maestro.ts';
import type { Weekday } from '@hangar/protocol';

const monTue: Weekday[] = ['mon', 'tue'];
const mon: Weekday[] = ['mon'];
const tue: Weekday[] = ['tue'];

test('--hold takes seconds, minutes or hours', () => {
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('1.5h'), 5400);
  assert.equal(parseDuration('0m'), null);
  assert.equal(parseDuration('soon'), null);
});

test('the Actions example starts when the booking window opens, in UTC', () => {
  // 18:00 in Oslo on Monday 2026-11-09 is 17:00 UTC.
  const oslo = { days: monTue, from: '18:00', timeZone: 'Europe/Oslo', next: { bookingId: 'b', name: 'n', from: Date.UTC(2026, 10, 9, 17), to: Date.UTC(2026, 10, 10, 6) } };
  assert.equal(cronFor(oslo), '0 17 * * 1,2');
  // 00:30 in Oslo on Tuesday is 23:30 UTC on Monday.
  const early = { days: tue, from: '00:30', timeZone: 'Europe/Oslo', next: { bookingId: 'b', name: 'n', from: Date.UTC(2026, 10, 9, 23, 30), to: Date.UTC(2026, 10, 10, 1) } };
  assert.equal(cronFor(early), '30 23 * * 1');
  // 20:00 in New York on Monday is 01:00 UTC on Tuesday.
  const ny = { days: mon, from: '20:00', timeZone: 'America/New_York', next: { bookingId: 'b', name: 'n', from: Date.UTC(2026, 10, 10, 1), to: Date.UTC(2026, 10, 10, 3) } };
  assert.equal(cronFor(ny), '0 1 * * 2');
});
