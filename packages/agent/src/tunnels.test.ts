import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AgentMessage } from '@devicepool/protocol';
import { Tunnels } from './tunnels.ts';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const address = s.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((r) => s.close(r));
  return port;
}

function response(sent: AgentMessage[]): Promise<AgentMessage> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const m = sent.find((x) => x.type === 'response');
      if (m) {
        clearInterval(timer);
        resolve(m);
      }
    }, 5);
  });
}

test('a requested extra port another lease holds is an error, not a silent random port', async () => {
  const port = await freePort();
  const sentA: AgentMessage[] = [];
  const sentB: AgentMessage[] = [];
  const a = new Tunnels((m) => sentA.push(m));
  const b = new Tunnels((m) => sentB.push(m));
  a.start(1, 'a', [port]);
  const first = await response(sentA);
  assert.equal(first.type === 'response' && first.ok, true);
  b.start(2, 'b', [port]);
  const second = await response(sentB);
  assert.ok(second.type === 'response' && !second.ok);
  assert.equal(second.error.code, 'TUNNEL_PORT_BUSY');
  assert.match(second.error.message, new RegExp(`Port ${port}`));
  assert.match(second.error.message, /--port/);
  a.stopAll();
  b.stopAll();
});

test('where the device has its own loopback, a busy extra port falls back to a random one', async () => {
  const port = await freePort();
  const sentA: AgentMessage[] = [];
  const sentB: AgentMessage[] = [];
  const a = new Tunnels((m) => sentA.push(m));
  const b = new Tunnels((m) => sentB.push(m), { shouldFallBack: true });
  a.start(1, 'a', [port]);
  await response(sentA);
  b.start(2, 'b', [port]);
  const second = await response(sentB);
  assert.ok(second.type === 'response' && second.ok);
  a.stopAll();
  b.stopAll();
});
