import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from './db.ts';
import { closeWindowNight } from './reports.ts';

test('a closed window with no leases and no open night records nothing', () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'hangar-')), 'h.db'));
  assert.equal(closeWindowNight(db, { bookingId: 'b1', name: 'night', from: 0, to: 1000 }), null);
});

test('a closed window closes the open night of that booking', () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'hangar-')), 'h.db'));
  db.insertNight({ id: 'n1', teamId: 'default', booking: 'night', state: 'open', openedAt: 0, closedAt: null, data: { openedBy: 'a', closedBy: null, leaseIds: null, runIds: null } });
  const closed = closeWindowNight(db, { bookingId: 'gone', name: 'night', from: 0, to: 1000 });
  assert.equal(closed?.id, 'n1');
  assert.equal(closed?.state, 'closed');
  assert.equal(closed?.closedAt, 1000);
});
