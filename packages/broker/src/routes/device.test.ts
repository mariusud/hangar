import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type BrokerMessage, type Op } from '@hangar/protocol';
import * as auth from '../auth.ts';
import { startBroker, type Broker } from '../index.ts';
import { isOrientation, pageQuery } from './device.ts';

function fakeAgent(broker: Broker): Op[] {
  const ops: Op[] = [];
  const handlers = broker.attach({
    send: (m: BrokerMessage) =>
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'op') {
          ops.push(m.body);
          if (m.body.op === 'orientation' || m.body.op === 'gesture') {
            handlers.message({ type: 'response', id: m.id, ok: false, error: { code: 'UNSUPPORTED', message: 'Rotating an iOS simulator is not supported.' } });
          } else {
            handlers.message({ type: 'response', id: m.id, ok: true, result: { items: [{ seq: 1, text: 'hi' }], next: 1, dropped: false, op: m.body.op } });
          }
        }
      }),
    close: () => {},
  });
  handlers.message({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    hostName: 'fake-mac',
    versions: {},
    memoryBytes: 0,
    offers: [{ model: 'iPhone 17', os: '26.5' }],
    devices: [{ deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready' }],
    leases: [],
  });
  return ops;
}

test('pageQuery reads bundleId, since and limit and refuses junk', () => {
  assert.deepEqual(pageQuery(new URLSearchParams('bundleId=com.example&since=12&limit=50')), { bundleId: 'com.example', since: 12, limit: 50 });
  assert.deepEqual(pageQuery(new URLSearchParams('')), {});
  assert.throws(() => pageQuery(new URLSearchParams('since=-1')), /whole number/);
  assert.throws(() => pageQuery(new URLSearchParams('limit=abc')), /whole number/);
  assert.ok(isOrientation('landscapeLeft'));
  assert.ok(!isOrientation('sideways'));
});

test('device tool routes and MCP tools reach the agent as ops, and UNSUPPORTED comes back as is', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const dir = await mkdtemp(join(tmpdir(), 'hangar-devicetools-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'test', version: '0' });
  try {
    const ops = fakeAgent(broker);
    const account = auth.createAccount(broker.db, 'dev', 'member');
    const token = auth.mintToken(broker.db, 'member', { accountId: account.id });
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: { error?: { code: string } } & Record<string, unknown> }> => {
      const res = await fetch(`${broker.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: await res.json() };
    };
    const lease = await call('POST', '/v1/leases?wait=5', {});
    const id = String(lease.json.id);
    assert.equal(lease.json.state, 'active');

    assert.equal((await call('GET', `/v1/leases/${id}/log?bundleId=com.example&since=3`)).json.op, 'appLog');
    assert.deepEqual(ops.at(-1), { op: 'appLog', bundleId: 'com.example', since: 3 });
    assert.equal((await call('POST', `/v1/leases/${id}/js`, { expression: '1 + 1' })).status, 200);
    assert.deepEqual(ops.at(-1), { op: 'jsEvaluate', expression: '1 + 1' });
    assert.equal((await call('POST', `/v1/leases/${id}/js`, {})).json.error?.code, 'BAD_EXPRESSION');
    assert.equal((await call('GET', `/v1/leases/${id}/js/console?limit=10`)).json.op, 'jsConsole');
    assert.equal((await call('GET', `/v1/leases/${id}/network`)).json.op, 'network');
    assert.equal((await call('POST', `/v1/leases/${id}/orientation`, { orientation: 'up' })).json.error?.code, 'BAD_ORIENTATION');
    const rotated = await call('POST', `/v1/leases/${id}/orientation`, { orientation: 'landscapeLeft' });
    assert.equal(rotated.status, 422);
    assert.equal(rotated.json.error?.code, 'UNSUPPORTED');
    const pinch = await call('POST', `/v1/leases/${id}/gestures`, { gesture: 'pinch', center: [0.5, 0.5], scale: 2 });
    assert.equal(pinch.json.error?.code, 'UNSUPPORTED');
    assert.deepEqual(ops.at(-1), { op: 'gesture', gesture: 'pinch', center: [0.5, 0.5], scale: 2 });

    await client.connect(new StreamableHTTPClientTransport(new URL(`${broker.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['app_log', 'js_evaluate', 'js_console', 'network_requests', 'set_orientation']) {
      assert.ok(names.includes(name), name);
    }
    const r = await client.callTool({ name: 'js_evaluate', arguments: { expression: 'globalThis.x' } });
    assert.ok(!r.isError);
    assert.deepEqual(ops.at(-1), { op: 'jsEvaluate', expression: 'globalThis.x' });
    const log = await client.callTool({ name: 'app_log', arguments: { since: 5 } });
    assert.ok(!log.isError);
    assert.deepEqual(ops.at(-1), { op: 'appLog', since: 5 });
    const rot = await client.callTool({ name: 'set_orientation', arguments: { orientation: 'portrait' } });
    assert.ok(rot.isError);
  } finally {
    await client.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
