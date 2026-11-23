import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokerAddress, reasonOf, retryNotifier } from './connect.ts';

test('an address without a scheme is refused with an example', () => {
  assert.throws(() => brokerAddress('studio-mini.local:7420'), /Use a full address such as http:\/\/studio-mini\.local:7420/);
  assert.throws(() => brokerAddress('http://'), /Use a full address/);
  assert.throws(() => brokerAddress('ws://studio-mini.local:7420'), /Use a full address/);
});

test('a full address loses its trailing slash', () => {
  assert.equal(brokerAddress('http://studio-mini.local:7420/'), 'http://studio-mini.local:7420');
  assert.equal(brokerAddress('https://devicepool.example.ts.net'), 'https://devicepool.example.ts.net');
});

test('socket errors are named in words', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  assert.equal(reasonOf(refused), 'connection refused');
  assert.equal(reasonOf(new Error('odd')), 'odd');
  assert.equal(reasonOf('x'), 'unknown error');
});

test('the unreachable notice prints at once, then at most once a minute, and again after a connection', () => {
  const lines: string[] = [];
  let now = 1_000_000;
  const notifier = retryNotifier((line) => lines.push(line), () => now);
  notifier.notice('http://a:1', 'connection refused');
  now += 1000;
  notifier.notice('http://a:1', 'connection refused');
  now += 58_000;
  notifier.notice('http://a:1', 'connection refused');
  assert.deepEqual(lines, ['Cannot reach http://a:1 (connection refused). Trying again.']);
  now += 1000;
  notifier.notice('http://a:1', 'no such host');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'Cannot reach http://a:1 (no such host). Trying again.');
  notifier.reset();
  notifier.notice('http://a:1', 'connection refused');
  assert.equal(lines.length, 3);
});
