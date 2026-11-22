import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice } from '@devicepool/protocol';
import { startBroker } from '@devicepool/broker';
import { proxyStream } from './proxy.ts';

test('the stream proxy passes a lease stream through with the token kept server side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-proxy-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const proxy = createServer((_req, res) => res.writeHead(404).end());
  try {
    const devices: AgentDevice[] = [{ deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }];
    const handlers = broker.attach({
      send: (m) => {
        queueMicrotask(() => {
          if (m.type === 'lease.prepare' || m.type === 'op') {
            handlers.message({ type: 'response', id: m.id, ok: true, result: {} });
          } else if (m.type === 'stream.start') {
            handlers.message({ type: 'stream.frame', leaseId: m.leaseId, codec: 'jpeg', data: new Uint8Array([0xff, 0xd8]) });
          }
        });
      },
      close: () => {},
    });
    handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices, leases: [] });
    const token = broker.adminToken('test');
    const res = await fetch(`${broker.url}/v1/leases?wait=5`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ class: {} }) });
    const lease: { id: string } = await res.json();
    proxy.on('upgrade', (req, socket, head) => proxyStream(req, socket, head, { url: broker.url, token, leaseId: lease.id, codec: 'jpeg' }));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const address = proxy.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/screen`);
    ws.binaryType = 'arraybuffer';
    const first = await new Promise<Uint8Array>((resolve, reject) => {
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          resolve(new Uint8Array(e.data));
        }
      };
      ws.onerror = () => reject(new Error('socket failed'));
    });
    assert.deepEqual([...first], [1, 0xff, 0xd8]);
    ws.close();
  } finally {
    proxy.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
