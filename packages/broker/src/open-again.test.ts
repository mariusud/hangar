import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type Action, type BrokerMessage, type Finding, type Night, type OpenAgain, type UiNode } from '@hangar/protocol';
import * as auth from './auth.ts';
import { findNode, planReplay, recordOp, REPLAY_PAUSE_MS, storedActions, targetAt, type RecordedAction } from './findings.ts';
import { startBroker, type Broker } from './index.ts';
import { buildReport, reportMarkdown } from './reports.ts';
import type { FindingData } from './db.ts';

function node(label: string | null, x: number, y: number, w = 0.2, h = 0.1, fields: Partial<UiNode> = {}): UiNode {
  return { role: 'button', label, value: null, identifier: null, enabled: true, frame: { x: 0, y: 0, width: 0, height: 0 }, normalized: { x, y, width: w, height: h }, ...fields };
}

const SCREEN = [node(null, 0, 0, 1, 1, { role: 'application', label: 'App' }), node('Form', 0, 0.3, 1, 0.5, { role: 'group' }), node('Login', 0.4, 0.45)];

test('targetAt names the smallest labelled element under a point, and nothing outside', () => {
  assert.deepEqual(targetAt(SCREEN, [0.5, 0.5]), { label: 'Login' });
  assert.deepEqual(targetAt(SCREEN, [0.1, 0.4]), { label: 'Form' });
  assert.equal(targetAt(SCREEN, [0.1, 0.1]), null);
  assert.deepEqual(targetAt([node(null, 0, 0, 1, 1, { identifier: 'close' })], [0.5, 0.5]), { identifier: 'close' });
});

test('findNode matches exactly first, then by contained label, and picks the one nearest the recorded point', () => {
  const nodes = [node('Log in now', 0.1, 0.1), node('Login', 0.4, 0.8), node('Login', 0.4, 0.2), node('Off', 0, 0, 0.1, 0.1, { enabled: false })];
  assert.equal(findNode(nodes, { label: 'Login' }, [0.5, 0.25])?.normalized.y, 0.2);
  assert.equal(findNode(nodes, { label: 'Login' }, [0.5, 0.85])?.normalized.y, 0.8);
  assert.equal(findNode(nodes, { label: 'log in' }, null)?.label, 'Log in now');
  assert.equal(findNode(nodes, { label: 'log in', exact: true }, null), null);
  assert.equal(findNode(nodes, { label: 'Off' }, null), null);
  assert.equal(findNode(nodes, { label: 'Missing' }, null), null);
});

test('recordOp keeps replayable actions, names tapped elements from the last describe, and lists what it cannot replay', () => {
  const tap: Action = { type: 'tap', point: [0.5, 0.5] };
  const [named] = recordOp({ op: 'actions', actions: [tap] }, 10, [{ ok: true }], SCREEN);
  assert.deepEqual(named, { at: 10, failed: null, kind: 'action', action: tap, target: { label: 'Login' } });
  const [blind] = recordOp({ op: 'actions', actions: [tap] }, 10, [{ ok: true }], null);
  assert.equal(blind?.kind === 'action' ? blind.target : 'wrong kind', null);
  const failed = recordOp({ op: 'actions', actions: [tap, { type: 'type', text: 'x'.repeat(3000) }] }, 10, [{ ok: false, error: { code: 'X', message: 'gone' } }, { ok: true }], null);
  assert.equal(failed[0]?.failed, 'gone');
  assert.equal(failed[1]?.kind, 'skip');
  assert.deepEqual(recordOp({ op: 'launch', bundleId: 'com.example' }, 5, {}, null), [{ at: 5, failed: null, kind: 'op', op: { op: 'launch', bundleId: 'com.example' } }]);
  assert.deepEqual(recordOp({ op: 'install', artifactUrl: 'http://h/v1/artifacts/abc?t=secret', sha256: 'abc' }, 5, {}, null), [{ at: 5, failed: null, kind: 'install', sha256: 'abc' }]);
  assert.equal(recordOp({ op: 'maestro', archive: 'a', flows: ['f.yaml'] }, 5, {}, null)[0]?.kind, 'skip');
  assert.deepEqual(recordOp({ op: 'describe' }, 5, {}, null), []);
  assert.deepEqual(recordOp({ op: 'screenshot' }, 5, {}, null), []);
  assert.deepEqual(recordOp({ op: 'appLog' }, 5, {}, null), []);
});

test('planReplay says how each step replays, caps pauses and skips what failed or cannot be replayed', () => {
  const actions: RecordedAction[] = [
    { at: 1000, failed: null, kind: 'op', op: { op: 'launch', bundleId: 'com.example' } },
    { at: 1500, failed: null, kind: 'action', action: { type: 'tap', point: [0.5, 0.5] }, target: { label: 'Login' } },
    { at: 60_000, failed: null, kind: 'action', action: { type: 'tap', point: [0.1, 0.1] }, target: null },
    { at: 60_100, failed: null, kind: 'action', action: { type: 'tap', element: { label: 'Next' } }, target: null },
    { at: 60_100, failed: null, kind: 'action', action: { type: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2] }, target: null },
    { at: 60_200, failed: 'not found', kind: 'action', action: { type: 'waitFor', element: { label: 'Home' } }, target: null },
    { at: 60_300, failed: null, kind: 'action', action: { type: 'type', text: 'secret' }, target: null },
    { at: 60_400, failed: null, kind: 'skip', what: 'Run Maestro: f.yaml', reason: 'Hangar does not run tests again. Start a run for that.' },
  ];
  const plan = planReplay(actions);
  assert.deepEqual(
    plan.map((s) => [s.what, s.waitMs, s.by, s.skip]),
    [
      ['Launch com.example', 0, null, null],
      ['Tap "Login"', 500, 'label', null],
      ['Tap (10%, 10%)', REPLAY_PAUSE_MS, 'coordinates', null],
      ['Tap "Next"', 100, 'label', null],
      ['Swipe (50%, 80%) to (50%, 20%)', 0, 'coordinates', null],
      ['Wait for "Home"', 100, null, 'It failed on the original lease: not found'],
      ['Type 6 characters', 100, null, null],
      ['Run Maestro: f.yaml', 100, null, 'Hangar does not run tests again. Start a run for that.'],
    ],
  );
  assert.deepEqual(planReplay([]), []);
});

test('storedActions reads what a finding kept and gives none for findings from before', () => {
  const base = { title: 't', description: '', severity: 'low', device: null, video: null, steps: [], log: [], logError: null, network: [], screenshot: false, notes: [], openAgainUrl: null } satisfies FindingData;
  assert.deepEqual(storedActions(base), { actions: [], truncated: false });
  const kept = { ...base, actions: [{ at: 1, failed: null, kind: 'skip', what: 'x', reason: 'y' }, { nonsense: true }], actionsTruncated: true };
  assert.deepEqual(storedActions(kept), { actions: [{ at: 1, failed: null, kind: 'skip', what: 'x', reason: 'y' }], truncated: true });
});

test('the Markdown report tells how to open a finding again', () => {
  const finding: Finding = { id: 'f', leaseId: 'l', nightId: 'n', title: 'Bug', description: '', severity: 'low', by: 'a', createdAt: 0, device: null, video: null, steps: [], log: [], logError: null, network: [], screenshot: null, notes: [], openAgainUrl: 'http://h/v1/findings/f/open-again' };
  const night = { id: 'n', booking: 'nightly', team: 'Mobile', state: 'closed', openedAt: 0, closedAt: 1, openedBy: 'ci', closedBy: 'ci', url: 'http://h/n' } satisfies Night;
  const report = buildReport({ night, findings: [finding], leases: [], runs: [] }, 2);
  assert.deepEqual(report.notes, []);
  assert.match(reportMarkdown(report), /- Open again: `POST http:\/\/h\/v1\/findings\/f\/open-again`/);
});

// Two Macs' worth of screens: the Login button sits lower on the second device, and only the first has Help.
const SCREENS: Record<string, UiNode[]> = {
  'dev-1': [node('Login', 0.4, 0.45), node('Help', 0, 0.85)],
  'dev-2': [node('Login', 0.4, 0.75)],
};

function fakeAgent(broker: Broker): { taps: { device: string; action: Action }[]; ops: { device: string; op: string }[] } {
  const taps: { device: string; action: Action }[] = [];
  const ops: { device: string; op: string }[] = [];
  const deviceOf = new Map<string, string>();
  const handlers = broker.attach({
    send: (m: BrokerMessage) =>
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          deviceOf.set(m.leaseId, m.deviceId);
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'op') {
          const device = deviceOf.get(m.leaseId) ?? '';
          const b = m.body;
          ops.push({ device, op: b.op });
          if (b.op === 'describe') {
            handlers.message({ type: 'response', id: m.id, ok: true, result: { screen: { x: 0, y: 0, width: 400, height: 800 }, nodes: SCREENS[device] ?? [] } });
          } else if (b.op === 'actions') {
            taps.push(...b.actions.map((action) => ({ device, action })));
            handlers.message({ type: 'response', id: m.id, ok: true, result: b.actions.map(() => ({ ok: true })) });
          } else if (b.op === 'appLog' || b.op === 'network') {
            handlers.message({ type: 'response', id: m.id, ok: true, result: { items: [], next: 0, dropped: false } });
          } else if (b.op === 'screenshot') {
            handlers.message({ type: 'response', id: m.id, ok: true, binary: Buffer.from('png').toString('base64') });
          } else {
            handlers.message({ type: 'response', id: m.id, ok: true, result: {} });
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
    devices: [
      { deviceId: 'dev-1', model: 'iPhone 17', os: '26.5', state: 'ready' },
      { deviceId: 'dev-2', model: 'iPhone 17', os: '26.5', state: 'ready' },
    ],
    leases: [],
  });
  return { taps, ops };
}

type Answer<T> = { status: number; json: T & { error?: { code: string } }; text: string };

function caller(broker: Broker, token: string): <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<Answer<T>> {
  return async <T,>(method: string, path: string, body?: unknown): Promise<Answer<T>> => {
    const res = await fetch(`${broker.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json: T & { error?: { code: string } } = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : {};
    return { status: res.status, json, text };
  };
}

test('open again leases a fresh device for the team, records it and replays by label where it can', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const dir = await mkdtemp(join(tmpdir(), 'hangar-open-again-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'test', version: '0' });
  try {
    const { taps, ops } = fakeAgent(broker);
    const qa = auth.createAccount(broker.db, 'qa-agent', 'member');
    const mate = auth.createAccount(broker.db, 'teammate', 'member');
    const outsider = auth.createAccount(broker.db, 'outsider', 'member');
    broker.db.saveTeam({ id: 'mobile', name: 'Mobile', quota: null });
    broker.db.saveTeam({ id: 'web', name: 'Web', quota: null });
    broker.db.setTeam(qa.id, 'mobile');
    broker.db.setTeam(mate.id, 'mobile');
    broker.db.setTeam(outsider.id, 'web');
    const call = caller(broker, auth.mintToken(broker.db, 'member', { accountId: qa.id }));
    const mateToken = auth.mintToken(broker.db, 'member', { accountId: mate.id });
    const teammate = caller(broker, mateToken);
    const other = caller(broker, auth.mintToken(broker.db, 'member', { accountId: outsider.id }));

    const first = await call('POST', '/v1/leases?wait=5', {});
    const leaseId = String(first.json.id);
    await call('POST', `/v1/leases/${leaseId}/apps/com.example/launch`, {});
    await call('GET', `/v1/leases/${leaseId}/ui`);
    await call('POST', `/v1/leases/${leaseId}/actions`, { actions: [{ type: 'tap', point: [0.5, 0.5] }] });
    await call('GET', `/v1/leases/${leaseId}/ui`);
    await call('POST', `/v1/leases/${leaseId}/actions`, { actions: [{ type: 'tap', point: [0.1, 0.9] }] });
    await call('POST', `/v1/leases/${leaseId}/actions`, { actions: [{ type: 'tap', point: [0.9, 0.1] }, { type: 'type', text: 'hello' }] });
    await call('DELETE', `/v1/leases/${leaseId}/apps/com.example`);
    const filed = await call<Finding>('POST', `/v1/leases/${leaseId}/findings`, { title: 'Login does nothing' });
    assert.equal(filed.status, 201, filed.text);
    const findingId = filed.json.id;
    assert.equal(filed.json.openAgainUrl, `${broker.url}/v1/findings/${findingId}/open-again`);

    assert.equal((await other('POST', `/v1/findings/${findingId}/open-again`)).json.error?.code, 'FINDING_NOT_FOUND');
    assert.equal((await teammate('POST', `/v1/findings/${findingId}/open-again`, { waitSeconds: -1 })).json.error?.code, 'BAD_WAIT');

    const opened = await teammate<OpenAgain>('POST', `/v1/findings/${findingId}/open-again`, {});
    assert.equal(opened.status, 201, opened.text);
    const again = opened.json;
    assert.notEqual(again.leaseId, leaseId);
    assert.equal(again.url, `${broker.url}/leases/${again.leaseId}`);
    assert.match(again.recording ?? '', /\/recordings\//);
    assert.deepEqual(
      again.steps.map((s) => [s.what, s.status, s.by]),
      [
        ['Launch com.example', 'ok', null],
        ['Tap "Login"', 'ok', 'label'],
        ['Tap "Help"', 'ok', 'coordinates'],
        ['Tap (90%, 10%)', 'ok', 'coordinates'],
        ['Type 5 characters', 'ok', null],
        ['Uninstall com.example', 'skipped', null],
      ],
    );
    assert.match(again.steps[2]?.note ?? '', /No element "Help"/);

    // The new lease belongs to the teammate who opened it again, on the other device.
    const lease = await teammate('GET', `/v1/leases/${again.leaseId}`);
    assert.equal(lease.json.state, 'active');
    assert.equal(lease.json.owner, 'teammate');
    const replayed = taps.filter((t) => t.device === 'dev-2').map((t) => t.action);
    assert.deepEqual(replayed, [
      { type: 'tap', point: [0.5, 0.8] },
      { type: 'tap', point: [0.1, 0.9] },
      { type: 'tap', point: [0.9, 0.1] },
      { type: 'type', text: 'hello' },
    ]);
    assert.ok(ops.some((o) => o.device === 'dev-2' && o.op === 'recordStart'));
    assert.ok(!ops.some((o) => o.device === 'dev-2' && o.op === 'uninstall'));

    // Through MCP, with no device free: the request is withdrawn and says so.
    await client.connect(new StreamableHTTPClientTransport(new URL(`${broker.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mateToken}` } } }));
    const r = await client.callTool({ name: 'open_again', arguments: { findingId, waitSeconds: 1 } });
    assert.ok(r.isError);
    const content = Array.isArray(r.content) ? r.content[0] : undefined;
    assert.match(content && 'text' in content && typeof content.text === 'string' ? content.text : '', /No device like the finding's came free/);
    const queued = (await teammate<{ id: string; state: string }[]>('GET', '/v1/leases')).json;
    assert.ok(Array.isArray(queued) && !queued.some((l) => l.state === 'queued'));
  } finally {
    await client.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
