import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badPorts, isCrossOrigin } from './tunnel.ts';

test('ports below 1024 are refused with a message that names the port', () => {
  assert.match(badPorts([80]) ?? '', /Port 80 is below 1024/);
  assert.equal(badPorts([1024, 8081, 65535]), null);
  assert.ok(badPorts([70000]));
  assert.ok(badPorts([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => 3000 + n)));
});

test('a cookie with an Origin from another host is refused', () => {
  assert.equal(isCrossOrigin({ cookie: 'a=b', origin: 'https://evil.example', host: 'pool.local:7420' }), true);
  assert.equal(isCrossOrigin({ cookie: 'a=b', origin: 'http://pool.local:7420', host: 'pool.local:7420' }), false);
  assert.equal(isCrossOrigin({ origin: 'https://evil.example', host: 'pool.local:7420' }), false);
  assert.equal(isCrossOrigin({ cookie: 'a=b', host: 'pool.local:7420' }), false);
});
