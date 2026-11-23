import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type BrokerMessage } from '@devicepool/protocol';
import { Hosts, readAgentMessage } from './hosts.ts';

function link(): { sent: BrokerMessage[]; closed: number; hosts: Hosts; handlers: ReturnType<Hosts['attach']> } {
  const out = { sent: [] as BrokerMessage[], closed: 0 };
  const hosts = new Hosts();
  const handlers = hosts.attach({ send: (m) => out.sent.push(m), close: () => (out.closed += 1) });
  return { ...out, get sent() { return out.sent; }, get closed() { return out.closed; }, hosts, handlers };
}

const hello = { type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'mac', versions: {}, memoryBytes: 1, offers: [], devices: [], leases: [] };

test('a malformed agent message is dropped with one log line and the broker keeps running', () => {
  const logged: string[] = [];
  const log = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    const l = link();
    l.handlers.message({ ...hello, devices: 'none' });
    assert.equal(l.closed, 1, 'a bad hello closes the socket');
    assert.equal(l.hosts.hosts.size, 0);
    assert.match(logged[0] ?? '', /Dropped hello from an agent that has not said hello: .*devices/);

    l.handlers.message(hello);
    assert.equal(l.hosts.hosts.size, 1);
    const before = logged.length;
    l.handlers.message({ type: 'inventory', devices: null });
    l.handlers.message({ type: 'inventory' });
    l.handlers.message({ type: 'response', id: 'x', ok: true });
    l.handlers.message({ type: 'nope' });
    l.handlers.message('text');
    l.handlers.message(null);
    l.handlers.rejected('it is not valid JSON');
    assert.equal(logged.length - before, 7);
    assert.match(logged[before] ?? '', /Dropped inventory from host mac/);
    assert.equal(l.closed, 1, 'only a bad hello closes the socket');
    assert.equal(l.hosts.hosts.size, 1);
  } finally {
    console.error = log;
  }
});

test('a hello from another protocol version is told so, whatever else it carries', () => {
  const l = link();
  l.handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION + 1 });
  assert.equal(l.sent[0]?.type, 'incompatible');
  assert.equal(l.closed, 1);
});

test('a throwing listener does not escape the message handler', () => {
  const logged: string[] = [];
  const log = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    const l = link();
    l.hosts.onHello = () => {
      throw new Error('boom');
    };
    l.handlers.message(hello);
    assert.match(logged[0] ?? '', /handling it failed: boom/);
  } finally {
    console.error = log;
  }
});

test('valid messages of every type are read back unchanged', () => {
  const frame = { type: 'stream.frame', leaseId: 'l', codec: 'jpeg', data: new Uint8Array([1]) };
  assert.deepEqual(readAgentMessage(frame), { ok: true, value: frame });
  assert.deepEqual(readAgentMessage(hello), { ok: true, value: hello });
  const bad = { type: 'response', id: 3, ok: false, error: { code: 'X', message: 'no' } };
  assert.deepEqual(readAgentMessage(bad), { ok: true, value: bad });
  const status = { type: 'images.status', image: 'i', id: 'b', state: 'ready' };
  assert.deepEqual(readAgentMessage(status), { ok: true, value: status });
});
