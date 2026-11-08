import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage, encodeMessage, type AgentMessage } from './index.ts';

test('messages with bytes go as binary frames and come back the same', () => {
  const frame: AgentMessage = { type: 'stream.frame', leaseId: 'l1', codec: 'h264', data: new Uint8Array([0, 0, 0, 1, 103]) };
  const wire = encodeMessage(frame);
  assert.ok(Buffer.isBuffer(wire));
  const back = decodeMessage<AgentMessage>(wire, true);
  assert.equal(back.type, 'stream.frame');
  assert.deepEqual(back.type === 'stream.frame' && [...back.data], [0, 0, 0, 1, 103]);

  const inventory: AgentMessage = { type: 'inventory', devices: [] };
  const text = encodeMessage(inventory);
  assert.equal(typeof text, 'string');
  assert.deepEqual(decodeMessage(Buffer.from(String(text)), false), inventory);
});
