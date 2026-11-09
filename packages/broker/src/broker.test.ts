import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage, type Platform } from '@hangar/protocol';
import { createServer } from 'node:net';
import { Hangar } from 'hangar';
import { WebSocket } from 'ws';
import { decodeMessage, encodeMessage } from '@hangar/protocol';
import { mintHostToken } from './index.ts';
import * as auth from './auth.ts';
import { startBroker, type Broker } from './index.ts';

function fakeAgent(broker: Broker, platform: Platform = 'ios-simulator'): { messages: BrokerMessage[]; ended: string[]; handlers: ReturnType<Broker['attach']> } {
  const messages: BrokerMessage[] = [];
  const ended: string[] = [];
  let devices: AgentDevice[] = [{ deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready', platform }];
  let n = 1;
  const leaseOf = new Map<string, string>();
  const recording = new Map<string, Record<'video' | 'log' | 'screenshot', string>>();
  const uploadRecording = async (leaseId: string): Promise<void> => {
    const uploads = recording.get(leaseId);
    recording.delete(leaseId);
    if (uploads) {
      await fetch(broker.url + uploads.screenshot, { method: 'PUT', body: 'png' });
      await fetch(broker.url + uploads.log, { method: 'PUT', body: '{"eventMessage":"hello from the app"}\n' });
      await fetch(broker.url + uploads.video, { method: 'PUT', body: '0123456789' });
    }
  };
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
          } else if (m.body.op === 'recordStart') {
            recording.set(m.leaseId, m.body.uploads);
            handlers.message({ type: 'response', id: m.id, ok: true, result: { device: 'iPhone 17, iOS 26.5' } });
          } else if (m.body.op === 'recordStop') {
            void uploadRecording(m.leaseId).then(() => handlers.message({ type: 'response', id: m.id, ok: true }));
          } else if (m.body.op === 'maestro') {
            const flows = m.body.flows;
            const failing = flows.length > 1 && flows.includes('broken.yaml');
            const cases = flows.map((f) => `<testcase name="${f.replace('.yaml', '')}">${failing && f === 'broken.yaml' ? '<failure>no</failure>' : ''}</testcase>`).join('');
            handlers.message({ type: 'response', id: m.id, ok: true, result: { passed: !failing, junit: `<testsuites>${cases}</testsuites>`, log: 'Assertion is false', durationMs: 1 } });
          } else if (m.body.op === 'espresso') {
            const cases = [{ target: 'com.example.test', className: 'com.example.LoginTest', name: 'signIn', status: 'passed', seconds: 1 }];
            handlers.message({ type: 'response', id: m.id, ok: true, result: { passed: true, cases, log: 'OK (1 test)', durationMs: 1 } });
          } else if (m.body.op === 'xcuitest') {
            const failing = m.body.tests.length > 1;
            const cases = m.body.tests.map((t) => ({ target: 'AppUITests', className: t.split('/')[1] ?? '', name: 'testIt', status: failing && t.endsWith('LoginTests') ? 'failed' : 'passed', seconds: 1 }));
            handlers.message({ type: 'response', id: m.id, ok: true, result: { passed: !failing, cases, log: '', durationMs: 1 } });
          } else if (m.body.op === 'describe') {
            const login = { role: 'button', label: 'Login', identifier: null, value: null, enabled: true, frame: { x: 100, y: 200, width: 200, height: 40 }, normalized: { x: 0.25, y: 0.25, width: 0.5, height: 0.05 } };
            handlers.message({ type: 'response', id: m.id, ok: true, result: { screen: { x: 0, y: 0, width: 400, height: 800 }, nodes: [login] } });
          } else if (m.body.op === 'actions') {
            handlers.message({ type: 'response', id: m.id, ok: true, result: m.body.actions.map(() => ({ ok: true })) });
          } else if (m.body.op === 'screenshot') {
            handlers.message({ type: 'response', id: m.id, ok: true, binary: Buffer.from('fakepng').toString('base64') });
          } else {
            handlers.message({ type: 'response', id: m.id, ok: true, result: { op: m.body.op } });
          }
        } else if (m.type === 'lease.end') {
          void uploadRecording(m.leaseId);
          ended.push(m.leaseId);
          const deviceId = leaseOf.get(m.leaseId);
          leaseOf.delete(m.leaseId);
          n += 1;
          devices = devices.filter((d) => d.deviceId !== deviceId).concat({ deviceId: `dev-${n}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform });
          handlers.message({ type: 'inventory', devices });
        }
      });
    },
    close: () => {},
  });
  handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform }], devices, leases: [] });
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
  const metro = createServer((socket) => socket.on('data', (d) => socket.write(`metro got ${d}`)));
  await new Promise<void>((r) => metro.listen(0, '127.0.0.1', r));
  try {
    const agent = fakeAgent(broker);
    const alice = token('alice');
    const lease = await new Hangar({ url: broker.url, token: alice }).lease({}, { autoRenew: false });
    const address = metro.address();
    const tunnel = await lease.metroTunnel(typeof address === 'object' && address ? address.port : 0);
    assert.equal(tunnel.port, 41000);

    agent.handlers.message({ type: 'tunnel.open', leaseId: lease.id, conn: 7 });
    agent.handlers.message({ type: 'tunnel.data', leaseId: lease.id, conn: 7, data: Buffer.from('GET /status') });
    let reply: string | null = null;
    for (let i = 0; i < 100 && !reply; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const m = agent.messages.find((x) => x.type === 'tunnel.data' && x.conn === 7);
      reply = m?.type === 'tunnel.data' ? Buffer.from(m.data).toString() : null;
    }
    assert.equal(reply, 'metro got GET /status');

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

test('a recording keeps the video, log and screenshot, and a timeline of the actions taken', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const alice = token('alice');
    const bob = token('bob');
    const lease = await call(broker, alice, 'POST', '/v1/leases?wait=5', {});

    const started = await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/recording`);
    assert.equal(started.status, 201);
    assert.equal(started.json.state, 'recording');
    assert.equal((await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/recording`)).json.error.code, 'ALREADY_RECORDING');

    await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/actions`, { actions: [{ type: 'tap', element: { label: 'Sign in' } }, { type: 'type', text: 'hi' }] });
    await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/open-url`, { url: 'myapp://home' });

    assert.equal((await call(broker, bob, 'POST', `/v1/leases/${lease.json.id}/recording/stop`)).status, 404);

    const stopped = await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/recording/stop`);
    assert.equal(stopped.json.state, 'ready');
    assert.equal(stopped.json.device, 'iPhone 17, iOS 26.5');
    assert.match(stopped.json.url, new RegExp(`/recordings/${stopped.json.id}$`));

    const timeline = await call(broker, bob, 'GET', stopped.json.files.timeline);
    assert.deepEqual(timeline.json.map((e: { what: string }) => e.what), ['Tap "Sign in", Type 2 characters', 'Open myapp://home']);
    assert.deepEqual((await call(broker, bob, 'GET', stopped.json.files.log)).json, { eventMessage: 'hello from the app' });

    const part = await fetch(`${broker.url}${stopped.json.files.video}`, { headers: { authorization: `Bearer ${bob}`, range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');

    assert.equal((await fetch(`${broker.url}/v1/uploads/recordings/${stopped.json.id}/video?t=nope`, { method: 'PUT', body: 'x' })).status, 403);

    assert.equal((await call(broker, bob, 'DELETE', `/v1/recordings/${stopped.json.id}`)).status, 403);
    assert.equal((await call(broker, alice, 'DELETE', `/v1/recordings/${stopped.json.id}`)).status, 204);
    assert.equal((await call(broker, bob, 'GET', `/v1/recordings/${stopped.json.id}`)).status, 404);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('record: true records the whole lease, saved when it is released', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const alice = token('alice');
    const lease = await call(broker, alice, 'POST', '/v1/leases?wait=5', { record: true });
    for (let i = 0; i < 50 && (await call(broker, alice, 'GET', '/v1/recordings')).json[0]?.state !== 'recording'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/actions`, { actions: [{ type: 'button', button: 'home' }] });
    await call(broker, alice, 'DELETE', `/v1/leases/${lease.json.id}`);
    let rec = (await call(broker, alice, 'GET', '/v1/recordings')).json[0];
    for (let i = 0; i < 50 && rec.state !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rec = (await call(broker, alice, 'GET', '/v1/recordings')).json[0];
    }
    assert.equal(rec.state, 'ready');
    assert.deepEqual((await call(broker, alice, 'GET', rec.files.timeline)).json.map((e: { what: string }) => e.what), ['Press home']);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('/metrics counts leases and device ops without names or ids', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const alice = token('alice');
    const lease = await call(broker, alice, 'POST', '/v1/leases?wait=5', {});
    await call(broker, alice, 'POST', `/v1/leases/${lease.json.id}/open-url`, { url: 'myapp://x' });
    await call(broker, alice, 'DELETE', `/v1/leases/${lease.json.id}`);
    const text = await (await fetch(`${broker.url}/metrics`)).text();
    assert.match(text, /^hangar_hosts_connected 1$/m);
    assert.match(text, /^hangar_lease_wait_seconds_count 1$/m);
    assert.match(text, /^hangar_leases_ended_total\{reason="released"\} 1$/m);
    assert.match(text, /^hangar_op_duration_seconds_count\{op="openUrl"\} 1$/m);
    assert.doesNotMatch(text, new RegExp(lease.json.id));
    assert.doesNotMatch(text, /alice/);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run shards flows over leases, retries a failure recorded, and merges JUnit', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const t = token('ci');
    broker.db.insertBuild('abc123', 'App.app', join(dir, 'nothing'), 1);
    const start = await call(broker, t, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml', 'broken.yaml'] }, retries: 1 });
    assert.equal(start.status, 201);
    let run = start.json;
    for (let i = 0; i < 100 && run.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      run = (await call(broker, t, 'GET', `/v1/runs/${run.id}`)).json;
    }
    assert.equal(run.state, 'passed');
    assert.deepEqual(run.counts, { passed: 1, flaky: 1, failed: 0, pending: 0 });
    const broken = run.flows.find((f: { flow: string }) => f.flow === 'broken.yaml');
    assert.equal(broken.attempts, 2);
    assert.match(broken.recording, /\/recordings\//);
    const junit = (await call(broker, t, 'GET', `/v1/runs/${run.id}/junit.xml`)).json;
    assert.match(junit, /name="broken"><properties>.*name="flaky" value="true"/);
    assert.equal(broker.db.leasesIn(['preparing', 'active']).length, 0);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run without a known build is refused with a hint', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const res = await call(broker, token('ci'), 'POST', '/v1/runs', { build: 'nope', suite: { kind: 'maestro', archive: 'x', flows: ['a.yaml'] } });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'BUILD_NOT_FOUND');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent on another machine joins over the socket with a host token', async () => {
  const { broker, dir, token } = await setup();
  const url = `${broker.url.replace('http', 'ws')}/v1/agent/connect`;
  try {
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers: { authorization: 'Bearer hgr_host_nope' } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => {});
    });
    assert.equal(refused, 401);

    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${mintHostToken(broker.db)}` } });
    await new Promise((r) => ws.once('open', r));
    const device = { deviceId: 'remote-1', model: 'iPhone 17', os: '26.5', state: 'ready' as const };
    ws.on('message', (raw: Buffer, isBinary) => {
      const m = decodeMessage<BrokerMessage>(raw, isBinary);
      if (m.type === 'lease.prepare') {
        ws.send(encodeMessage({ type: 'response', id: m.id, ok: true }));
      }
    });
    ws.send(encodeMessage({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'remote-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5' }], devices: [device], leases: [] }));
    const t = token('dev');
    const lease = await call(broker, t, 'POST', '/v1/leases?wait=5', {});
    assert.equal(lease.json.state, 'active');
    const devices = await call(broker, t, 'GET', '/v1/devices');
    assert.equal(devices.json[0].host, 'remote-mac');
    ws.close();
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an XCUITest run shards by class and retries a failing class', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const t = token('ci');
    broker.db.insertBuild('def456', 'Products.zip', join(dir, 'nothing'), 1);
    const start = await call(broker, t, 'POST', '/v1/runs', { build: 'Products.zip', suite: { kind: 'xcuitest', tests: ['AppUITests/LoginTests', 'AppUITests/HomeTests'] } });
    assert.equal(start.status, 201);
    let run = start.json;
    for (let i = 0; i < 100 && run.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      run = (await call(broker, t, 'GET', `/v1/runs/${run.id}`)).json;
    }
    assert.equal(run.kind, 'xcuitest');
    assert.deepEqual(run.counts, { passed: 1, flaky: 1, failed: 0, pending: 0 });
    const junit = (await call(broker, t, 'GET', `/v1/runs/${run.id}/junit.xml`)).json;
    assert.match(junit, /classname="xcuitest" name="AppUITests\/LoginTests"/);
    const bad = await call(broker, t, 'POST', '/v1/runs', { build: 'Products.zip', suite: { kind: 'xcuitest', tests: ['-destination'] } });
    assert.equal(bad.json.error.code, 'BAD_TESTS');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an Espresso run goes to an Android emulator with both APKs', async () => {
  const { broker, dir, token } = await setup();
  try {
    const agent = fakeAgent(broker, 'android-emulator');
    const t = token('ci');
    broker.db.insertBuild('a1', 'app.apk', join(dir, 'a'), 1);
    broker.db.insertBuild('b2', 'app-test.apk', join(dir, 'b'), 1);
    const start = await call(broker, t, 'POST', '/v1/runs', { build: 'app.apk', suite: { kind: 'espresso', testBuild: 'app-test.apk', tests: ['com.example.LoginTest'] } });
    assert.equal(start.status, 201);
    let run = start.json;
    for (let i = 0; i < 100 && run.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      run = (await call(broker, t, 'GET', `/v1/runs/${run.id}`)).json;
    }
    assert.equal(run.state, 'passed');
    assert.equal(run.class.platform, 'android-emulator');
    const op = agent.messages.find((m) => m.type === 'op' && m.body.op === 'espresso');
    assert.ok(op && op.type === 'op' && op.body.op === 'espresso' && op.body.testApp.sha256 === 'b2' && op.body.app.sha256 === 'a1');
    const missing = await call(broker, t, 'POST', '/v1/runs', { build: 'app.apk', suite: { kind: 'espresso', testBuild: 'nope', tests: ['all'] } });
    assert.equal(missing.status, 404);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a team at its quota waits for a free device until the quota is raised', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const admin = auth.createAccount(broker.db, 'ops', 'operator');
    const op = auth.mintToken(broker.db, 'member', { accountId: admin.id });
    const qa = token('tester');
    const team = await call(broker, op, 'POST', '/v1/teams', { name: 'QA', quota: 0 });
    assert.equal(team.status, 201);
    assert.equal((await call(broker, op, 'PUT', '/v1/people/tester/team', { team: 'qa' })).status, 200);

    const lease = await call(broker, qa, 'POST', '/v1/leases?wait=1', {});
    assert.equal(lease.json.state, 'queued');
    const teams = await call(broker, op, 'GET', '/v1/teams');
    assert.deepEqual(teams.json.map((t: { name: string; members: number }) => [t.name, t.members]), [['Default', 1], ['QA', 1]]);

    await call(broker, op, 'PATCH', `/v1/teams/${team.json.id}`, { quota: 1 });
    const after = await call(broker, qa, 'GET', `/v1/leases/${lease.json.id}?wait=5`);
    assert.equal(after.json.state, 'active');
    assert.equal((await call(broker, qa, 'GET', '/v1/teams')).status, 403);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a device image goes to every host, and only a request for it gets its devices', async () => {
  const { broker, dir, token } = await setup();
  try {
    const { messages, handlers } = fakeAgent(broker);
    const admin = auth.createAccount(broker.db, 'ops', 'operator');
    const op = auth.mintToken(broker.db, 'member', { accountId: admin.id });
    const qa = token('tester');
    broker.db.insertBuild('abc123', 'App.app', join(dir, 'nothing'), 1);

    assert.equal((await call(broker, qa, 'PUT', '/v1/images/signed-in', { apps: ['App.app'] })).status, 403);
    assert.equal((await call(broker, op, 'PUT', '/v1/images/signed-in', { apps: ['Missing.app'] })).status, 404);
    assert.equal((await call(broker, op, 'PUT', '/v1/images/signed-in', { apps: ['App.app'], locale: 'nb_NO' })).status, 200);
    const sent = messages.filter((m) => m.type === 'images').at(-1);
    assert.ok(sent?.type === 'images');
    assert.equal(sent.images[0]?.name, 'signed-in');
    assert.equal(sent.images[0]?.apps[0]?.sha256, 'abc123');
    assert.match(sent.images[0]?.apps[0]?.url ?? '', /^\/v1\/artifacts\/abc123\?t=/);

    const early = await call(broker, qa, 'POST', '/v1/leases?wait=1', { class: { image: 'signed-in' } });
    assert.equal(early.json.state, 'queued');

    const devices: AgentDevice[] = [
      { deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready' },
      { deviceId: 'img-1', model: 'iPhone 17', os: '26.5', state: 'ready', image: 'signed-in' },
    ];
    handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5' }, { model: 'iPhone 17', os: '26.5', image: 'signed-in' }], devices, leases: [] });

    const imaged = await call(broker, qa, 'GET', `/v1/leases/${early.json.id}?wait=5`);
    assert.equal(imaged.json.state, 'active');
    const plain = await call(broker, qa, 'POST', '/v1/leases?wait=5', {});
    assert.equal(plain.json.state, 'active');
    const held = broker.db.leasesIn(['active']).map((l) => l.deviceId).sort();
    assert.deepEqual(held, ['dev-1', 'img-1']);
    assert.equal(broker.db.getLease(imaged.json.id)?.deviceId, 'img-1');

    const unknown = await call(broker, qa, 'POST', '/v1/leases', { class: { image: 'nope' } });
    assert.equal(unknown.json.error.code, 'NO_MATCHING_DEVICE');
    assert.equal((await call(broker, op, 'DELETE', '/v1/images/signed-in')).status, 204);
    assert.deepEqual(messages.filter((m) => m.type === 'images').at(-1), { type: 'images', images: [] });
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runs and recordings are visible to their team and operators only', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const admin = auth.createAccount(broker.db, 'ops', 'operator');
    const op = auth.mintToken(broker.db, 'member', { accountId: admin.id });
    const qa = token('tester');
    const other = token('someone');
    await call(broker, op, 'POST', '/v1/teams', { name: 'QA' });
    await call(broker, op, 'PUT', '/v1/people/tester/team', { team: 'qa' });
    broker.db.insertBuild('abc123', 'App.app', join(dir, 'nothing'), 1);
    const run = (await call(broker, qa, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml'] } })).json;
    const tester = broker.db.accountByName('tester');
    assert.ok(tester);
    broker.db.insertRecording({ id: 'rec-1', leaseId: 'l-1', accountId: tester.id, state: 'ready', startedAt: 1, endedAt: 2, bytes: 0, error: null, device: null });

    assert.equal((await call(broker, qa, 'GET', `/v1/runs/${run.id}`)).status, 200);
    assert.equal((await call(broker, op, 'GET', `/v1/runs/${run.id}`)).status, 200);
    assert.equal((await call(broker, other, 'GET', `/v1/runs/${run.id}`)).status, 404);
    assert.equal((await call(broker, other, 'GET', `/v1/runs/${run.id}/junit.xml`)).status, 404);
    assert.deepEqual((await call(broker, other, 'GET', '/v1/runs')).json, []);
    assert.equal((await call(broker, qa, 'GET', '/v1/runs')).json.length, 1);

    assert.equal((await call(broker, qa, 'GET', '/v1/recordings/rec-1')).status, 200);
    assert.equal((await call(broker, other, 'GET', '/v1/recordings/rec-1')).status, 404);
    assert.deepEqual((await call(broker, other, 'GET', '/v1/recordings?all=1')).json, []);
    assert.equal((await call(broker, op, 'GET', '/v1/recordings?all=1')).json.length, 1);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the fleet shows how each lease was taken and what its holder did; watching changes neither', async () => {
  const { broker, dir, token } = await setup();
  try {
    fakeAgent(broker);
    const admin = auth.createAccount(broker.db, 'ops', 'operator');
    const op = auth.mintToken(broker.db, 'member', { accountId: admin.id });
    const qa = token('tester');
    const lease = (await call(broker, qa, 'POST', '/v1/leases?wait=5', { via: 'checking the login flow' })).json;
    await call(broker, qa, 'POST', `/v1/leases/${lease.id}/actions`, { actions: [{ type: 'tap', element: { label: 'Sign in' } }] });
    const before = (await call(broker, op, 'GET', '/v1/leases?all=1')).json.find((l: { id: string }) => l.id === lease.id);
    assert.equal(before.via, 'checking the login flow');
    assert.equal(before.activity, 'Tapped “Sign in”');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await call(broker, op, 'GET', `/v1/leases/${lease.id}/ui`)).status, 200);
    const after = (await call(broker, op, 'GET', '/v1/leases?all=1')).json.find((l: { id: string }) => l.id === lease.id);
    assert.equal(after.activity, 'Tapped “Sign in”');
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal((await call(broker, qa, 'POST', '/v1/leases', { via: 42 })).status, 201);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent written for mobile-mcp drives a leased device with the same tool names', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { broker, dir, token } = await setup();
  const client = new Client({ name: 'test', version: '0' });
  try {
    const { messages } = fakeAgent(broker);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${broker.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token('agent')}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('mobile_click_on_screen_at_coordinates') && names.includes('lease_device'));

    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await client.callTool({ name, arguments: args });
      const first = Array.isArray(r.content) ? r.content[0] : undefined;
      assert.ok(!r.isError, JSON.stringify(r.content));
      return first && 'text' in first && typeof first.text === 'string' ? first.text : '';
    };
    const lastActions = (): unknown => {
      const op = messages.filter((m) => m.type === 'op' && m.body.op === 'actions').at(-1);
      return op?.type === 'op' && op.body.op === 'actions' ? op.body.actions : null;
    };

    const device: string = JSON.parse(await call('mobile_allocate_remote_device', { platform: 'ios' })).device;
    assert.match(await call('mobile_list_elements_on_screen', { device }), /@e1 button "Login" at \(100, 200\) 200x40/);
    await call('mobile_click_on_screen_at_coordinates', { device, ref: '@e1' });
    assert.deepEqual(lastActions(), [{ type: 'tap', point: [0.5, 0.275] }]);
    await call('mobile_click_on_screen_at_coordinates', { device, x: 200, y: 400 });
    assert.deepEqual(lastActions(), [{ type: 'tap', point: [0.5, 0.5] }]);
    await call('mobile_type_keys', { device, text: 'hi', submit: true });
    assert.deepEqual(lastActions(), [{ type: 'type', text: 'hi' }, { type: 'key', key: 'return' }]);
    await call('mobile_release_remote_device', { device });
    assert.equal(broker.db.getLease(device)?.state, 'ended');
  } finally {
    await client.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('single sign-on: code flow with PKCE, a checked ID token, groups to team and role', async () => {
  const { generateKeyPairSync, createHash, sign } = await import('node:crypto');
  const { createServer: httpServer } = await import('node:http');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let issuer = '';
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const idp = httpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    } else if (url.pathname === '/jwks') {
      res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }] }));
    } else if (url.pathname === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      const code = codes.get(form.get('code') ?? '');
      const ok = code && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === code.challenge;
      if (!ok) {
        res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
      const body = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ iss: issuer, aud: 'hangar', sub: 'u-42', email: 'kim@example.com', groups: ['mobile-qa', 'platform'], nonce: code.nonce, exp: Math.floor(Date.now() / 1000) + 300 })}`;
      res.end(JSON.stringify({ id_token: `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}` }));
    }
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  const address = idp.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const dir = await mkdtemp(join(tmpdir(), 'hangar-broker-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1', oidc: { issuer, clientId: 'hangar', groups: { 'mobile-qa': 'QA', platform: 'operator' } } });
  try {
    const start = await fetch(`${broker.url}/v1/oidc/start?next=/runs`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location') ?? '');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    codes.set('c1', { nonce: authorize.searchParams.get('nonce') ?? '', challenge: authorize.searchParams.get('code_challenge') ?? '' });

    const back = await fetch(`${broker.url}/v1/oidc/callback?code=c1&state=${authorize.searchParams.get('state')}`, { redirect: 'manual' });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/runs');
    const cookie = (back.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const me = await (await fetch(`${broker.url}/v1/me`, { headers: { cookie } })).json();
    assert.equal(me.name, 'kim@example.com');
    assert.equal(me.role, 'operator');
    const account = broker.db.accountByName('kim@example.com');
    assert.equal(broker.db.teams().find((t) => t.id === broker.db.teamOf(account?.id ?? ''))?.name, 'QA');

    const again = await fetch(`${broker.url}/v1/oidc/callback?code=c1&state=${authorize.searchParams.get('state')}`, { redirect: 'manual' });
    assert.equal(again.status, 400);
  } finally {
    await broker.close();
    idp.close();
    await rm(dir, { recursive: true, force: true });
  }
});
