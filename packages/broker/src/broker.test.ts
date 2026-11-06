import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage } from '@hangar/protocol';
import { createServer } from 'node:net';
import { Hangar } from '@hangar/client';
import * as auth from './auth.ts';
import { startBroker, type Broker } from './index.ts';

// A fake agent with one device. It answers ops and replaces a device after its lease ends.
function fakeAgent(broker: Broker): { messages: BrokerMessage[]; ended: string[]; handlers: ReturnType<Broker['attach']> } {
  const messages: BrokerMessage[] = [];
  const ended: string[] = [];
  let devices: AgentDevice[] = [{ deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready' }];
  let n = 1;
  const leaseOf = new Map<string, string>();
  const handlers = broker.attach({
    send: (m) => {
      messages.push(m);
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          leaseOf.set(m.leaseId, m.deviceId);
          devices = devices.map((d) => (d.deviceId === m.deviceId ? { ...d, state: 'busy' } : d));
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'tunnel.start') {
          handlers.message({ type: 'response', id: m.id, ok: true, result: { port: 41000 } });
        } else if (m.type === 'op') {
          if (!leaseOf.has(m.leaseId)) {
            handlers.message({ type: 'response', id: m.id, ok: false, error: { code: 'LEASE_NOT_HELD', message: 'no' } });
          } else if (m.body.op === 'screenshot') {
            handlers.message({ type: 'response', id: m.id, ok: true, binary: Buffer.from('fakepng').toString('base64') });
          } else {
            handlers.message({ type: 'response', id: m.id, ok: true, result: { op: m.body.op } });
          }
        } else if (m.type === 'lease.end') {
          ended.push(m.leaseId);
          const deviceId = leaseOf.get(m.leaseId);
          leaseOf.delete(m.leaseId);
          n += 1;
          devices = devices.filter((d) => d.deviceId !== deviceId).concat({ deviceId: `dev-${n}`, model: 'iPhone 17', os: '26.5', state: 'ready' });
          handlers.message({ type: 'inventory', devices });
        }
      });
    },
    close: () => {},
  });
  handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5' }], devices, leases: [] });
  return { messages, ended, handlers };
}

async function setup(): Promise<{ broker: Broker; dir: string; token: (name: string) => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-broker-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const token = (name: string): string => {
    const account = auth.createAccount(broker.db, name, 'member');
    return auth.mintToken(broker.db, 'member', { accountId: account.id });
  };
  return { broker, dir, token };
}

async function call(broker: Broker, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${broker.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

test('two clients race for the last device: one gets it, the other waits for a fresh one', async () => {
  const { broker, dir, token } = await setup();
  try {
    const agent = fakeAgent(broker);
    const alice = token('alice');
    const bob = token('bob');

    const [a, b] = await Promise.all([
      call(broker, alice, 'POST', '/v1/leases', { class: { model: 'iphone 17' } }),
      call(broker, bob, 'POST', '/v1/leases', { class: { model: 'iPhone 17' } }),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const la = await call(broker, alice, 'GET', `/v1/leases/${a.json.id}?wait=5`);
    const lb = await call(broker, bob, 'GET', `/v1/leases/${b.json.id}`);
    const states = [la.json.state, lb.json.state].sort();
    assert.deepEqual(states, ['active', 'queued'], 'exactly one lease is active');

    const [winner, winnerToken, loser, loserToken] =
      la.json.state === 'active' ? [la.json, alice, lb.json, bob] : [lb.json, bob, la.json, alice];
    assert.equal(loser.queuePosition, 1);

    // Someone else's lease looks missing.
    const peek = await call(broker, loserToken, 'GET', `/v1/leases/${winner.id}`);
    assert.equal(peek.status, 404);

    const shot = await fetch(`${broker.url}/v1/leases/${winner.id}/screenshot`, { headers: { authorization: `Bearer ${winnerToken}` } });
    assert.equal(shot.status, 200);
    assert.equal(await shot.text(), 'fakepng');

    const queuedOp = await call(broker, loserToken, 'GET', `/v1/leases/${loser.id}/ui`);
    assert.equal(queuedOp.status, 409);
    assert.equal(queuedOp.json.error.code, 'LEASE_NOT_ACTIVE');

    const released = await call(broker, winnerToken, 'DELETE', `/v1/leases/${winner.id}`);
    assert.equal(released.json.state, 'ended');
    assert.equal(released.json.reason, 'released');

    const next = await call(broker, loserToken, 'GET', `/v1/leases/${loser.id}?wait=5`);
    assert.equal(next.json.state, "active", JSON.stringify(next.json));
    assert.deepEqual(agent.ended, [winner.id]);

    const prepared = agent.messages.filter((m) => m.type === 'lease.prepare').map((m) => (m.type === 'lease.prepare' ? m.deviceId : ''));
    assert.deepEqual(prepared, ['dev-1', 'dev-2'], 'the second lease got a new device, not the released one');

    const afterEnd = await call(broker, winnerToken, 'POST', `/v1/leases/${winner.id}/actions`, { actions: [{ type: 'tap', point: [0.5, 0.5] }] });
    assert.equal(afterEnd.status, 409);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('requests explain what is wrong and what to do', async () => {
  const { broker, dir, token } = await setup();
  try {
    const t = token('carol');
    const none = await call(broker, t, 'POST', '/v1/leases', {});
    assert.equal(none.status, 503);
    assert.equal(none.json.error.code, 'NO_DEVICES');
    assert.match(none.json.error.hint, /hangar up/);

    fakeAgent(broker);
    const wrong = await call(broker, t, 'POST', '/v1/leases', { class: { model: 'Pixel 9' } });
    assert.equal(wrong.status, 404);
    assert.match(wrong.json.error.hint, /iPhone 17/);

    const anon = await fetch(`${broker.url}/v1/leases`);
    assert.equal(anon.status, 401);

    const upload = await fetch(`${broker.url}/v1/builds`, { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: 'x' });
    assert.equal(upload.status, 403, 'members cannot upload apps without the scope');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('welcome link signs in once; invites create accounts', async () => {
  const { broker, dir } = await setup();
  try {
    const link = broker.welcomeLink();
    const first = await fetch(link, { redirect: 'manual' });
    assert.equal(first.status, 302);
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, /^hangar_session=/);
    const again = await fetch(link, { redirect: 'manual' });
    assert.equal(again.headers.get('location'), '/?error=link-used');

    const me = await (await fetch(`${broker.url}/v1/me`, { headers: { cookie } })).json();
    assert.equal(me.role, 'operator');

    const invite = await (await fetch(`${broker.url}/v1/invites`, { method: 'POST', headers: { cookie }, body: '{}' })).json();
    const code = invite.url.split('/invite/')[1];
    const accept = await fetch(`${broker.url}/v1/invites/${code}/accept`, { method: 'POST', body: JSON.stringify({ name: 'dana', password: 'correct horse' }) });
    assert.equal(accept.status, 200);
    const login = await fetch(`${broker.url}/v1/login`, { method: 'POST', body: JSON.stringify({ name: 'Dana', password: 'correct horse' }) });
    assert.equal(login.status, 200);
    const reuse = await fetch(`${broker.url}/v1/invites/${code}/accept`, { method: 'POST', body: JSON.stringify({ name: 'eve', password: 'correct horse' }) });
    assert.equal(reuse.status, 404);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Metro tunnel carries a device connection to the lease holder, and only to them', async () => {
  const { broker, dir, token } = await setup();
  // Stands in for Metro on the developer's machine: answers what it receives.
  const metro = createServer((socket) => socket.on('data', (d) => socket.write(`metro got ${d}`)));
  await new Promise<void>((r) => metro.listen(0, '127.0.0.1', r));
  try {
    const agent = fakeAgent(broker);
    const alice = token('alice');
    const lease = await new Hangar({ url: broker.url, token: alice }).lease({}, { autoRenew: false });
    const address = metro.address();
    const tunnel = await lease.metroTunnel(typeof address === 'object' && address ? address.port : 0);
    assert.equal(tunnel.port, 41000);

    // The simulator opens a connection on the Mac and sends a request.
    agent.handlers.message({ type: 'tunnel.open', leaseId: lease.id, conn: 7 });
    agent.handlers.message({ type: 'tunnel.data', leaseId: lease.id, conn: 7, data: Buffer.from('GET /status') });
    let reply: string | null = null;
    for (let i = 0; i < 100 && !reply; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const m = agent.messages.find((x) => x.type === 'tunnel.data' && x.conn === 7);
      reply = m?.type === 'tunnel.data' ? Buffer.from(m.data).toString() : null;
    }
    assert.equal(reply, 'metro got GET /status');

    // Someone else cannot attach a tunnel to Alice's lease.
    const bob = new Hangar({ url: broker.url, token: token('bob') }).attach(lease.id);
    await assert.rejects(bob.metroTunnel(1));
    tunnel.close();
    await lease.release();
  } finally {
    metro.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
