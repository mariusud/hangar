import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice } from '@devicepool/protocol';
import { startBroker } from '@devicepool/broker';
import { Tunnels } from '../../../agent/src/tunnels.ts';
import { Devicepool } from './index.ts';

function echo(tag: string): Promise<{ server: Server; port: number }> {
  const server = createServer((s) => s.on('data', (d) => s.write(`${tag}:${d.toString()}`)));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })));
}

function ask(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(text));
    s.once('data', (d) => {
      resolve(d.toString());
      s.destroy();
    });
    s.on('error', reject);
  });
}

test('one lease tunnel carries Metro and extra ports to the client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-tunnel-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const metro = await echo('metro');
  const api = await echo('api');
  let tunnels: Tunnels | null = null;
  try {
    const devices: AgentDevice[] = [{ deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }];
    const handlers = broker.attach({
      send: (m) => {
        queueMicrotask(() => {
          if (m.type === 'lease.prepare' || m.type === 'op') {
            handlers.message({ type: 'response', id: m.id, ok: true, result: {} });
          } else if (m.type === 'tunnel.start') {
            tunnels?.start(m.id, m.leaseId, m.ports);
          } else if (m.type === 'tunnel.data') {
            tunnels?.data(m.leaseId, m.conn, m.data);
          } else if (m.type === 'tunnel.close') {
            tunnels?.close(m.leaseId, m.conn);
          }
        });
      },
      close: () => {},
    });
    tunnels = new Tunnels((m) => handlers.message(m));
    handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices, leases: [] });
    const client = new Devicepool({ url: broker.url, token: broker.adminToken('test') });
    const lease = await client.lease({}, { autoRenew: false });
    const tunnel = await lease.metroTunnel(metro.port, [api.port]);
    const onDevice = tunnel.ports[String(api.port)];
    assert.ok(onDevice, 'the extra port has a place on the device');
    assert.notEqual(onDevice, api.port, 'the port is taken on this machine, so the device gets another one');
    assert.equal(await ask(tunnel.port, 'a'), 'metro:a');
    assert.equal(await ask(onDevice ?? 0, 'b'), 'api:b');
    tunnel.close();
    await lease.release();
  } finally {
    tunnels?.stopAll();
    metro.server.close();
    api.server.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
