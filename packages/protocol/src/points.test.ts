import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActions, type Action } from './index.ts';

test('actions accept points as {x, y} as well as [x, y]', () => {
  const sent = JSON.parse(
    '[{"type":"tap","point":{"x":0.5,"y":0.8}},{"type":"swipe","from":{"x":0.5,"y":0.8},"to":[0.5,0.3]},{"type":"type","text":"hi"}]',
  );
  const actions: Action[] = sent;
  assert.deepEqual(normalizeActions(actions), [
    { type: 'tap', point: [0.5, 0.8] },
    { type: 'swipe', from: [0.5, 0.8], to: [0.5, 0.3] },
    { type: 'type', text: 'hi' },
  ]);
});
