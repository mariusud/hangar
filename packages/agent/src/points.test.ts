import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onScreen } from './index.ts';

test('action points must be fractions of the screen', () => {
  onScreen([0, 1]);
  onScreen([0.5, 0.8]);
  for (const p of [[200, 700], [-0.1, 0.5], [0.5, Number.NaN]] satisfies [number, number][]) {
    assert.throws(() => onScreen(p), /POINT_OFF_SCREEN|off the screen/);
  }
});
