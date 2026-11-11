import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice } from '@hangar/protocol';
import * as auth from '../auth.ts';
import { startBroker, type Broker } from '../index.ts';

// One host with one simulator that answers every request.
function fakeHost(broker: Broker): void {
  let devices: AgentDevice[] = [{ deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }];
  let n = 1;
  const handlers = broker.attach({
    send: (m) => {
      queueMicrotask(() => {
        if (m.type === 'lease.prepare' || m.type === 'op') {
          handlers.message({ type: 'response', id: m.id, ok: true, result: {} });
        } else if (m.type === 'lease.end') {
          n += 1;
          devices = [{ deviceId: `dev-${n}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }];
          handlers.message({ type: 'inventory', devices });
        }
      });
    },
    close: () => {},
  });
  handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices, leases: [] });
}

type Reply = { status: number; json: Record<string, unknown> & { error?: { code: string } } };

async function call(broker: Broker, token: string, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${broker.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

test('agent tokens carry longer limits under the operator caps, and a restarted agent gets its lease back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-leases-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    fakeHost(broker);
    const admin = broker.adminToken('test');
    const alice = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'alice', 'member').id });

    const made = await call(broker, alice, 'POST', '/v1/tokens', { label: 'claude', agent: true, idleSeconds: 1800, maxSeconds: 86_400 });
    assert.equal(made.status, 201);
    assert.deepEqual(made.json.limits, { agent: true, idleMs: 1_800_000, maxMs: 8 * 3_600_000, graceMs: 60_000 }, 'longest lease capped at 8 hours');
    const agent = String(made.json.token);

    assert.equal((await call(broker, alice, 'PUT', '/v1/lease-limits/agent', { idleSeconds: 600 })).status, 403);
    assert.equal((await call(broker, admin, 'PUT', '/v1/lease-limits/agent', { idleSeconds: 600 })).status, 200);
    assert.equal((await call(broker, admin, 'PUT', '/v1/lease-limits/robot', {})).status, 404);
    const limits = await call(broker, agent, 'GET', '/v1/lease-limits');
    assert.deepEqual(limits.json.mine, { agent: true, idleMs: 600_000, maxMs: 8 * 3_600_000, graceMs: 60_000 }, 'a lowered cap applies to tokens made before it');

    const tooLong = await call(broker, agent, 'POST', '/v1/leases', { idleSeconds: 1200 });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.error?.code, 'LEASE_LIMIT');

    const lease = await call(broker, agent, 'POST', '/v1/leases?wait=5', { maxSeconds: 3600 });
    assert.equal(lease.json.state, 'active');
    assert.deepEqual(lease.json.limits, { idleMs: 600_000, maxMs: 3_600_000, ttlMs: 3_600_000, graceMs: 60_000 });
    const id = String(lease.json.id);

    const kept = await call(broker, agent, 'POST', `/v1/leases/${id}/keepalive`);
    assert.equal(kept.status, 200);
    assert.ok(Number(kept.json.expiresAt) >= Date.now() + 590_000);

    const events = new AbortController();
    const stream = await fetch(`${broker.url}/v1/leases/${id}/events`, { headers: { authorization: `Bearer ${agent}` }, signal: events.signal });
    assert.equal(stream.status, 200);
    events.abort();
    let detachedAt: unknown = null;
    for (let i = 0; i < 50 && !detachedAt; i++) {
      await new Promise((r) => setTimeout(r, 20));
      detachedAt = (await call(broker, agent, 'GET', `/v1/leases/${id}`)).json.detachedAt;
    }
    assert.ok(typeof detachedAt === 'number', 'closing the event stream starts the grace period');

    const other = await call(broker, alice, 'POST', `/v1/leases/${id}/attach`);
    assert.equal(other.status, 403);
    assert.equal(other.json.error?.code, 'WRONG_TOKEN');
    const back = await call(broker, agent, 'POST', `/v1/leases/${id}/attach`);
    assert.equal(back.status, 200);
    assert.equal(back.json.state, 'active');
    assert.equal(back.json.detachedAt, null);

    const person = await call(broker, alice, 'POST', '/v1/leases?wait=5', {});
    assert.equal(person.json.state, 'queued', 'one device, held by the agent');
    await call(broker, agent, 'DELETE', `/v1/leases/${id}`);
    const ended = await call(broker, agent, 'POST', `/v1/leases/${id}/attach`);
    assert.equal(ended.status, 409);
    assert.equal(ended.json.error?.code, 'LEASE_ENDED');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('keepalive and reattach_lease are MCP tools', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const dir = await mkdtemp(join(tmpdir(), 'hangar-leases-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'test', version: '0' });
  try {
    fakeHost(broker);
    const token = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'bot', 'member').id });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${broker.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const text = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await client.callTool({ name, arguments: args });
      const first = Array.isArray(r.content) ? r.content[0] : undefined;
      assert.ok(!r.isError, JSON.stringify(r.content));
      return JSON.parse(first && 'text' in first && typeof first.text === 'string' ? first.text : '{}');
    };
    const leased = await text('lease_device', { idleSeconds: 120 });
    assert.equal(leased.state, 'active');
    assert.deepEqual(leased.limits, { idleMs: 120_000, maxMs: 4 * 3_600_000, ttlMs: 4 * 3_600_000, graceMs: 60_000 }, 'an MCP lease has no ttl unless it asks');
    assert.equal((await text('keepalive', {})).state, 'active');
    assert.equal((await text('reattach_lease', { leaseId: leased.leaseId })).state, 'active');
  } finally {
    await client.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
