import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { startBroker, type Broker } from './index.ts';

type Fails = (flow: string, attempt: number, batch: string[]) => boolean;

// An agent with one simulator at a time. `fails` decides each flow's result from how often it has run.
function fakeAgent(broker: Broker, fails: Fails): { maestro: { flows: string[]; env: Record<string, string> }[]; leases: string[] } {
  const maestro: { flows: string[]; env: Record<string, string> }[] = [];
  const leases: string[] = [];
  const attempts = new Map<string, number>();
  // Fresh ids per agent: a broker that restarts does not hand out a device it saw leased before.
  const prefix = randomUUID().slice(0, 8);
  let n = 1;
  let devices: AgentDevice[] = [{ deviceId: `${prefix}-1`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' }];
  const leaseOf = new Map<string, string>();
  const recording = new Map<string, Record<'video' | 'log' | 'screenshot', string>>();
  const upload = async (leaseId: string): Promise<void> => {
    const uploads = recording.get(leaseId);
    recording.delete(leaseId);
    if (uploads) {
      await fetch(broker.url + uploads.screenshot, { method: 'PUT', body: 'png' });
      await fetch(broker.url + uploads.log, { method: 'PUT', body: '{}\n' });
      await fetch(broker.url + uploads.video, { method: 'PUT', body: '0123456789' });
    }
  };
  const handlers = broker.attach({
    send: (m: BrokerMessage) => {
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          leaseOf.set(m.leaseId, m.deviceId);
          leases.push(m.leaseId);
          devices = devices.map((d) => (d.deviceId === m.deviceId ? { ...d, state: 'busy' } : d));
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'op') {
          if (m.body.op === 'recordStart') {
            recording.set(m.leaseId, m.body.uploads);
            handlers.message({ type: 'response', id: m.id, ok: true, result: { device: 'iPhone 17, iOS 26.5' } });
          } else if (m.body.op === 'recordStop') {
            void upload(m.leaseId).then(() => handlers.message({ type: 'response', id: m.id, ok: true }));
          } else if (m.body.op === 'maestro') {
            const batch = m.body.flows;
            maestro.push({ flows: batch, env: m.body.env ?? {} });
            const cases = batch
              .map((f) => {
                const attempt = (attempts.get(f) ?? 0) + 1;
                attempts.set(f, attempt);
                return `<testcase name="${f.replace('.yaml', '')}" time="2">${fails(f, attempt, batch) ? `<failure>no</failure>` : ''}</testcase>`;
              })
              .join('');
            const failing = cases.includes('<failure>');
            handlers.message({ type: 'response', id: m.id, ok: true, result: { passed: !failing, junit: `<testsuites>${cases}</testsuites>`, log: `Element 0x1f${attempts.size} not found after 1${maestro.length} ms`, durationMs: 1 } });
          } else {
            handlers.message({ type: 'response', id: m.id, ok: true, result: { op: m.body.op } });
          }
        } else if (m.type === 'lease.end') {
          void upload(m.leaseId);
          const deviceId = leaseOf.get(m.leaseId);
          leaseOf.delete(m.leaseId);
          n += 1;
          devices = devices.filter((d) => d.deviceId !== deviceId).concat({ deviceId: `${prefix}-${n}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' });
          handlers.message({ type: 'inventory', devices });
        }
      });
    },
    close: () => {},
  });
  handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices, leases: [] });
  return { maestro, leases };
}

type Call = { status: number; json: any };

async function call(broker: Broker, token: string, method: string, path: string, body?: unknown): Promise<Call> {
  const res = await fetch(`${broker.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

async function settle(broker: Broker, token: string, id: string): Promise<any> {
  let run = (await call(broker, token, 'GET', `/v1/runs/${id}`)).json;
  for (let i = 0; i < 200 && run.state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
    run = (await call(broker, token, 'GET', `/v1/runs/${id}`)).json;
  }
  return run;
}

async function withBroker(fn: (broker: Broker, member: (name: string, team?: string) => string, dir: string) => Promise<void>, dir?: string): Promise<void> {
  const data = dir ?? (await mkdtemp(join(tmpdir(), 'hangar-runs-test-')));
  const broker = await startBroker({ dataDir: data, port: 0, host: '127.0.0.1' });
  const member = (name: string, team?: string): string => {
    const account = auth.createAccount(broker.db, name, 'member');
    if (team) {
      broker.db.saveTeam({ id: team, name: team, quota: null });
      broker.db.setTeam(account.id, team);
    }
    return auth.mintToken(broker.db, 'member', { accountId: account.id });
  };
  try {
    broker.db.insertBuild('abc123', 'App.app', join(data, 'nothing'), 1);
    await fn(broker, member, data);
  } finally {
    await broker.close();
    if (!dir) {
      await rm(data, { recursive: true, force: true });
    }
  }
}

const flow = (run: any, name: string): any => run.flows.find((f: { flow: string }) => f.flow === name);
const recordingId = (url: string): string => url.replace(/^.*\/recordings\//, '');

test('the first failed attempt is recorded, and a first pass with no failure keeps no video', async () => {
  await withBroker(async (broker, member) => {
    fakeAgent(broker, (f, attempt) => f === 'broken.yaml' && attempt === 1);
    const t = member('ci');
    const start = await call(broker, t, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml', 'broken.yaml'] }, retries: 1 });
    const run = await settle(broker, t, start.json.id);
    assert.equal(run.state, 'passed');
    const broken = flow(run, 'broken.yaml');
    assert.equal(broken.status, 'flaky');
    assert.match(broken.firstRecording, /\/recordings\//);
    assert.match(broken.recording, /\/recordings\//);
    assert.notEqual(broken.firstRecording, broken.recording);
    assert.match(broken.firstMessage, /not found/);
    assert.equal(broken.message, undefined);
    assert.equal(flow(run, 'ok.yaml').firstRecording, undefined);
    assert.notEqual(broker.db.getRecording(recordingId(broken.firstRecording))?.state, 'deleted');
    const junit = (await call(broker, t, 'GET', `/v1/runs/${run.id}/junit.xml`)).json;
    assert.match(junit, /name="first-recording"/);

    const clean = await call(broker, t, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml'] }, retries: 1 });
    const passed = await settle(broker, t, clean.json.id);
    assert.equal(passed.state, 'passed');
    const lease = passed.leaseIds[0];
    const rows = broker.db.sql.prepare('select state from recordings where lease_id = ?').all(lease).map((r) => String(r.state));
    assert.deepEqual(rows, ['deleted']);
  });
});

test('rerunning one flow leases a fresh device, runs only that flow recorded, and updates the run', async () => {
  await withBroker(async (broker, member) => {
    const agent = fakeAgent(broker, (f, attempt) => f === 'broken.yaml' && attempt === 1);
    const t = member('ci', 'app');
    const colleague = member('dana', 'app');
    const stranger = member('eve', 'other');
    const start = await call(broker, t, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml', 'broken.yaml'] }, retries: 0, env: { USER: 'test' } });
    const run = await settle(broker, t, start.json.id);
    assert.equal(run.state, 'failed');
    assert.equal(flow(run, 'broken.yaml').status, 'failed');
    assert.match(flow(run, 'broken.yaml').firstRecording, /\/recordings\//);

    assert.equal((await call(broker, stranger, 'POST', `/v1/runs/${run.id}/flows/broken.yaml/rerun`)).status, 404);
    const missing = await call(broker, t, 'POST', `/v1/runs/${run.id}/flows/nope.yaml/rerun`);
    assert.equal(missing.json.error.code, 'FLOW_NOT_FOUND');

    const leasesBefore = agent.leases.length;
    const rerun = await call(broker, colleague, 'POST', `/v1/runs/${run.id}/flows/broken.yaml/rerun`);
    assert.equal(rerun.status, 202);
    assert.equal(rerun.json.state, 'running');
    assert.equal(flow(rerun.json, 'broken.yaml').status, 'running');
    const again = await call(broker, t, 'POST', `/v1/runs/${run.id}/flows/ok.yaml/rerun`);
    assert.equal(again.json.error.code, 'RUN_RUNNING');

    const after = await settle(broker, t, run.id);
    assert.equal(after.state, 'passed');
    const broken = flow(after, 'broken.yaml');
    assert.equal(broken.status, 'flaky');
    assert.equal(broken.attempts, 2);
    assert.match(broken.recording, /\/recordings\//);
    assert.equal(broken.firstRecording, flow(run, 'broken.yaml').firstRecording);
    assert.equal(flow(after, 'ok.yaml').status, 'passed');
    assert.equal(agent.leases.length, leasesBefore + 1);
    assert.deepEqual(agent.maestro.at(-1), { flows: ['broken.yaml'], env: { USER: 'test' } });
    assert.equal(broker.db.leasesIn(['preparing', 'active']).length, 0);
  });
});

test('a rerun after a restart asks for the environment again, since only its names are stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-runs-test-'));
  try {
    let runId = '';
    let token = '';
    await withBroker(async (broker, member) => {
      fakeAgent(broker, (f) => f === 'broken.yaml');
      token = member('ci');
      const start = await call(broker, token, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['broken.yaml'] }, retries: 0, env: { PASSWORD: 'secret' } });
      runId = (await settle(broker, token, start.json.id)).id;
      assert.doesNotMatch(JSON.stringify(broker.db.getRunSuite(runId)), /secret/);
    }, dir);
    await withBroker(async (broker) => {
      const agent = fakeAgent(broker, () => true);
      const refused = await call(broker, token, 'POST', `/v1/runs/${runId}/flows/broken.yaml/rerun`);
      assert.equal(refused.status, 409);
      assert.equal(refused.json.error.code, 'ENV_NEEDED');
      assert.match(refused.json.error.hint, /PASSWORD/);
      const bad = await call(broker, token, 'POST', `/v1/runs/${runId}/flows/broken.yaml/rerun`, { env: { PASSWORD: 1 } });
      assert.equal(bad.json.error.code, 'BAD_ENV');
      const ok = await call(broker, token, 'POST', `/v1/runs/${runId}/flows/broken.yaml/rerun`, { env: { PASSWORD: 'secret' } });
      assert.equal(ok.status, 202);
      const after = await settle(broker, token, runId);
      assert.equal(after.state, 'failed');
      assert.equal(flow(after, 'broken.yaml').attempts, 2);
      assert.deepEqual(agent.maestro.at(-1)?.env, { PASSWORD: 'secret' });
    }, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /v1/tests/flaky gives flake rates per flow and groups failures by message', async () => {
  await withBroker(async (broker, member) => {
    fakeAgent(broker, (f, attempt) => (f === 'login.yaml' && attempt % 2 === 1) || f === 'broken.yaml');
    const t = member('ci');
    for (let i = 0; i < 2; i++) {
      const start = await call(broker, t, 'POST', '/v1/runs', { build: 'App.app', suite: { kind: 'maestro', archive: 'dGFy', flows: ['ok.yaml', 'login.yaml', 'broken.yaml'] }, retries: 1 });
      await settle(broker, t, start.json.id);
    }
    const res = await call(broker, t, 'GET', '/v1/tests/flaky');
    assert.equal(res.status, 200);
    assert.equal(res.json.runs, 2);
    assert.deepEqual(res.json.tests.map((r: { test: string; flakeRate: number; failRate: number }) => [r.test, r.flakeRate, r.failRate]), [['login.yaml', 1, 0], ['broken.yaml', 0, 1]]);
    assert.equal(res.json.failures.length, 1);
    assert.equal(res.json.failures[0].count, 4);
    assert.deepEqual(res.json.failures[0].tests, ['broken.yaml', 'login.yaml']);
    assert.match(res.json.failures[0].message, /Element <hex> not found after <n> ms/);
    assert.match(res.json.failures[0].recording, /\/recordings\//);
    const history = await call(broker, t, 'GET', '/v1/tests');
    assert.equal(history.json.find((r: { test: string }) => r.test === 'ok.yaml').flakeRate, 0);
  });
});
