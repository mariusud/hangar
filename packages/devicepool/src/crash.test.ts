import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashHandlers } from './crash.ts';

test('an unhandled rejection is logged and the process keeps running', () => {
  const lines: string[] = [];
  const codes: number[] = [];
  crashHandlers({ log: (l) => lines.push(l), exit: (c) => codes.push(c) }).unhandledRejection(new Error('boom'));
  assert.equal(codes.length, 0);
  assert.match(lines[0] ?? '', /still running/);
  assert.match(lines[0] ?? '', /boom/);
  assert.match(lines[0] ?? '', /bug worth reporting/);
});

test('an uncaught exception is logged and the process exits non-zero', () => {
  const lines: string[] = [];
  const codes: number[] = [];
  crashHandlers({ log: (l) => lines.push(l), exit: (c) => codes.push(c) }).uncaughtException('plain string');
  assert.deepEqual(codes, [1]);
  assert.match(lines[0] ?? '', /plain string/);
});
