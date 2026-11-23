import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { DevicepoolError } from './client/index.ts';
import { clip, intOption, seconds, unexpectedMessage, usageProblem } from './args.ts';

function problem(args: string[], allowPositionals = false): string | null {
  try {
    parseArgs({ args, allowPositionals, options: { port: { type: 'string' }, phones: { type: 'boolean' } } });
  } catch (err) {
    return usageProblem(err);
  }
  return null;
}

test('an unknown option is one line with the hint', () => {
  assert.equal(problem(['--bogus']), 'Unknown option --bogus. Run `devicepool help`.');
});

test('an option without its value says which one', () => {
  assert.equal(problem(['--port']), '--port needs a value. Run `devicepool help`.');
  assert.equal(problem(['--phones=yes']), '--phones does not take a value. Run `devicepool help`.');
});

test('a stray word where none is allowed is named', () => {
  assert.equal(problem(['extra']), 'Unexpected argument extra. Run `devicepool help`.');
});

test('errors that are not argument errors are left alone', () => {
  assert.equal(usageProblem(new Error('boom')), null);
  assert.equal(usageProblem('x'), null);
});

test('a numeric option names the flag and the range', () => {
  assert.equal(intOption('--port', undefined, 1, 65535), undefined);
  assert.equal(intOption('--port', '7420', 1, 65535), 7420);
  assert.equal(intOption('--warm', '0', 0), 0);
  for (const bad of ['abc', '0', '99999', '-1', '1.5', '', '1e3']) {
    assert.throws(() => intOption('--port', bad, 1, 65535), (err: unknown) => err instanceof DevicepoolError && err.code === 'USAGE' && err.message === `--port must be a whole number, from 1 to 65535. You gave "${bad}". Run \`devicepool help\`.`);
  }
  assert.throws(() => intOption('--retries', '5', 0, 3), /--retries must be a whole number, from 0 to 3/);
  assert.throws(() => intOption('--max', 'abc', 1), /--max must be a whole number, 1 or more/);
  assert.throws(() => seconds('--ttl', '0'), /--ttl must be a whole number, 1 or more/);
  assert.equal(seconds('--ttl', '90'), 90);
});

test('clip cuts on code points, not in the middle of a surrogate pair', () => {
  assert.equal(clip('abc', 5), 'abc');
  const text = `${'a'.repeat(79)}😀tail`;
  assert.equal(clip(text, 80), `${'a'.repeat(79)}😀`);
  assert.equal(clip('😀😀😀', 2), '😀😀');
});

test('an unexpected error says how to get the stack', () => {
  assert.equal(unexpectedMessage(new Error('boom')), 'boom\nSet DEVICEPOOL_DEBUG=1 to see the full error.');
});
