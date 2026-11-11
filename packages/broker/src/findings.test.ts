import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type BrokerMessage, type Finding, type NightReport } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { NightRow } from './db.ts';
import { parseFinding, STARTED_WITH_FINDING, videoSpan } from './findings.ts';
import { startBroker, type Broker } from './index.ts';
import { newLease, type Lease } from './leases/machine.ts';
import { buildReport, nightMembers, OPEN_AGAIN_NOTE, reportMarkdown } from './reports.ts';
import { boundLine, boundRequest, LOG_LIMIT, NETWORK_LIMIT } from './recordings.ts';
import type { Run } from './runs.ts';

test('the recorder clips long log lines and request fields', () => {
  const line = boundLine({ time: 1, level: 'info', message: 'x'.repeat(5000), tag: 't'.repeat(500) });
  assert.equal(line.message.length, 2003);
  assert.equal(line.tag?.length, 200);
  const req = boundRequest({ id: 'r', method: 'GET', url: `https://e.example/${'a'.repeat(5000)}`, startedAt: 1, status: 200 });
  assert.equal(req.url.length, 2003);
  assert.equal(req.status, 200);
  assert.ok(LOG_LIMIT > 0 && NETWORK_LIMIT > 0);
});

test('parseFinding wants a title, keeps severity to the known ones and defaults to medium', () => {
  assert.deepEqual(parseFinding({ title: ' Login spins ', description: 'Tapped Login.' }), { title: 'Login spins', description: 'Tapped Login.', severity: 'medium' });
  assert.equal(parseFinding({ title: 'x', severity: 'critical' }).severity, 'critical');
  assert.throws(() => parseFinding({}), /title/);
  assert.throws(() => parseFinding({ title: 'x'.repeat(201) }), /title/);
  assert.throws(() => parseFinding({ title: 'x', severity: 'urgent' }), /severity/);
  assert.throws(() => parseFinding(null), /title/);
});

test('videoSpan is the last two minutes, or the whole recording when it is shorter', () => {
  assert.deepEqual(videoSpan(1000, 1000 + 300_000), { fromMs: 180_000, toMs: 300_000 });
  assert.deepEqual(videoSpan(1000, 1000 + 30_000), { fromMs: 0, toMs: 30_000 });
  assert.deepEqual(videoSpan(5000, 1000), { fromMs: 0, toMs: 0 });
});

function lease(id: string, teamId: string, activatedAt: number | null, endedAt: number | null): Lease {
  return { ...newLease({ id, principalId: 'a', teamId, class: {} }, 0), activatedAt, endedAt, state: endedAt ? 'ended' : 'active' };
}

function night(fields: Partial<NightRow> = {}): NightRow {
  return { id: 'n1', teamId: 't', booking: 'nightly', state: 'open', openedAt: 100, closedAt: null, data: { openedBy: 'a', closedBy: null, leaseIds: null, runIds: null }, ...fields };
}

test('nightMembers takes the team leases that overlap the window, and the runs that used them', () => {
  const leases = [
    lease('before', 't', 10, 50),
    lease('across', 't', 50, 150),
    lease('inside', 't', 120, 180),
    lease('still', 't', 190, null),
    lease('after', 't', 300, 400),
    lease('never', 't', null, 150),
    lease('other-team', 'u', 120, 180),
  ];
  const run = (id: string, leaseIds: string[]): Run => ({ id, accountId: 'a', state: 'passed', build: 'b', shards: 1, retries: 0, class: {}, flows: [], leaseIds, error: null, createdAt: 0, endedAt: 1 });
  const runs = [run('r1', ['inside']), run('r2', ['before']), run('r3', ['other-team'])];
  assert.deepEqual(nightMembers(night({ closedAt: 200 }), leases, runs, 1000), { leaseIds: ['across', 'inside', 'still'], runIds: ['r1'] });
  // While open, the window runs to now.
  assert.deepEqual(nightMembers(night(), leases, runs, 350).leaseIds, ['across', 'inside', 'still', 'after']);
  // Leases and runs given at close win.
  const given = night({ closedAt: 200, data: { openedBy: 'a', closedBy: null, leaseIds: ['other-team'], runIds: ['r3'] } });
  assert.deepEqual(nightMembers(given, leases, runs, 1000), { leaseIds: ['other-team'], runIds: ['r3'] });
});

function finding(fields: Partial<Finding>): Finding {
  return {
    id: 'f',
    leaseId: 'l1',
    nightId: 'n1',
    title: 'A bug',
    description: '',
    severity: 'medium',
    by: 'agent',
    createdAt: 0,
    device: null,
    video: null,
    steps: [],
    log: [],
    logError: null,
    network: [],
    screenshot: null,
    notes: [],
    openAgainUrl: null,
    ...fields,
  };
}

test('the report counts by severity, lists the worst first and renders as Markdown', () => {
  const report = buildReport(
    {
      night: { id: 'n1', booking: 'nightly', team: 'Mobile', state: 'closed', openedAt: Date.UTC(2026, 10, 10, 22), closedAt: Date.UTC(2026, 10, 11, 6), openedBy: 'ci', closedBy: 'ci', url: 'http://h/v1/nights/n1/report?format=md' },
      findings: [
        finding({ id: 'a', title: 'Typo on the\nsettings page', severity: 'low', createdAt: 1 }),
        finding({
          id: 'b',
          title: 'Checkout crashes',
          severity: 'critical',
          createdAt: 2,
          description: 'Tapped Pay, the app closed.',
          video: { recordingId: 'r', url: 'http://h/recordings/r', video: 'http://h/v1/recordings/r/video.mp4#t=60,180', fromMs: 60_000, toMs: 180_000, startedWithFinding: false },
          steps: [{ at: 170_000, what: 'Tap "Pay"', failed: 'gone' }],
          log: [{ time: Date.UTC(2026, 10, 11, 1), level: 'error', message: 'Fatal ```boom```' }],
          screenshot: 'http://h/v1/findings/b/screenshot.png',
        }),
      ],
      leases: [{ id: 'l1', owner: 'agent', image: 'signed-in', device: 'iPhone 17, iOS 26.5', activatedAt: 0, endedAt: 3_600_000, reason: 'expired', recording: 'http://h/recordings/r' }],
      runs: [{ id: 'run1', state: 'failed', url: 'http://h/runs/run1', passed: 3, flaky: 1, failed: 1, failures: [{ flow: 'checkout', message: 'Assertion is false', recording: null }] }],
    },
    5,
  );
  assert.deepEqual(report.summary, { leases: 1, findings: 2, bySeverity: { low: 1, medium: 0, high: 0, critical: 1 }, runs: 1, failedFlows: 1, flakyFlows: 1 });
  assert.deepEqual(report.findings.map((f) => f.id), ['b', 'a']);
  assert.deepEqual(report.notes, [OPEN_AGAIN_NOTE]);
  const md = reportMarkdown(report);
  assert.match(md, /^# nightly: night report\n/);
  assert.match(md, /- 2 findings \(1 critical, 1 low\)/);
  assert.match(md, /### \[critical\] Checkout crashes\n/);
  assert.match(md, /### \[low\] Typo on the settings page\n/);
  assert.match(md, /Video: http:\/\/h\/v1\/recordings\/r\/video\.mp4#t=60,180 \(1:00 to 3:00/);
  assert.match(md, /1\. 2:50 Tap "Pay" \(failed: gone\)/);
  assert.match(md, /Fatal '''boom'''/);
  assert.match(md, /  - checkout failed: Assertion is false/);
  assert.match(md, /- agent, image signed-in, iPhone 17, iOS 26\.5, 60 min, ended: expired/);
  assert.ok(md.includes(OPEN_AGAIN_NOTE));
  assert.ok(!/TODO/i.test(md));
});

function fakeAgent(broker: Broker): { ops: string[] } {
  const ops: string[] = [];
  const recording = new Map<string, Record<'video' | 'log' | 'screenshot', string>>();
  let logSeq = 0;
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
    send: (m: BrokerMessage) =>
      queueMicrotask(() => {
        if (m.type === 'lease.prepare') {
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'lease.end') {
          // The broker may close before this lands.
          void upload(m.leaseId).catch(() => {});
        } else if (m.type === 'op') {
          const b = m.body;
          ops.push(b.op);
          if (b.op === 'recordStart') {
            recording.set(m.leaseId, b.uploads);
            handlers.message({ type: 'response', id: m.id, ok: true, result: { device: 'iPhone 17, iOS 26.5' } });
          } else if (b.op === 'recordStop') {
            void upload(m.leaseId).then(() => handlers.message({ type: 'response', id: m.id, ok: true }));
          } else if (b.op === 'appLog') {
            // Two new lines per read, so the recorder's cursor matters.
            const since = b.since ?? 0;
            const items = [since + 1, since + 2].map((seq) => ({ seq, time: 1_000 + seq, level: 'info', message: `line ${seq}` }));
            logSeq = since + 2;
            handlers.message({ type: 'response', id: m.id, ok: true, result: { items, next: logSeq, dropped: false, bundleId: 'com.example', running: true } });
          } else if (b.op === 'network') {
            const items = [{ seq: 1, id: 'req-1', method: 'GET', url: 'https://api.example.com/me', startedAt: 1, status: 500 }];
            handlers.message({ type: 'response', id: m.id, ok: true, result: { items: b.since ? [] : items, next: 1, dropped: false, source: 'cdp' } });
          } else if (b.op === 'screenshot') {
            handlers.message({ type: 'response', id: m.id, ok: true, binary: Buffer.from('fakepng').toString('base64') });
          } else if (b.op === 'actions') {
            handlers.message({ type: 'response', id: m.id, ok: true, result: b.actions.map(() => ({ ok: true })) });
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
  return { ops };
}

type Answer<T> = { status: number; json: T & { error?: { code: string } }; text: string };
type Call = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<Answer<T>>;

function caller(broker: Broker, token: string): Call {
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

test('a finding carries the video span, steps, app log, network and a screenshot, and lands in the night report', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const dir = await mkdtemp(join(tmpdir(), 'hangar-findings-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'test', version: '0' });
  try {
    const { ops } = fakeAgent(broker);
    const qa = auth.createAccount(broker.db, 'qa-agent', 'member');
    const outsider = auth.createAccount(broker.db, 'outsider', 'member');
    broker.db.saveTeam({ id: 'mobile', name: 'Mobile', quota: null });
    broker.db.saveTeam({ id: 'web', name: 'Web', quota: null });
    broker.db.setTeam(qa.id, 'mobile');
    broker.db.setTeam(outsider.id, 'web');
    const qaToken = auth.mintToken(broker.db, 'member', { accountId: qa.id });
    const call = caller(broker, qaToken);
    const other = caller(broker, auth.mintToken(broker.db, 'member', { accountId: outsider.id }));

    const opened = await call('POST', '/v1/nights', { booking: 'nightly' });
    assert.equal(opened.status, 201);
    const nightId = String(opened.json.id);
    assert.equal(opened.json.state, 'open');
    assert.equal((await call('POST', '/v1/nights', { booking: 'nightly' })).json.error?.code, 'NIGHT_OPEN');
    assert.equal((await call('POST', '/v1/nights', { booking: '' })).json.error?.code, 'BAD_BOOKING');

    // A lease that records from the start.
    const first = await call('POST', '/v1/leases?wait=5', {});
    const leaseId = String(first.json.id);
    assert.equal((await call('POST', `/v1/leases/${leaseId}/recording`)).status, 201);
    const before = ops.filter((o) => o === 'appLog').length;
    await call('POST', `/v1/leases/${leaseId}/actions`, { actions: [{ type: 'tap', point: [0.5, 0.5] }] });
    const filed = await call<Finding>('POST', `/v1/leases/${leaseId}/findings`, { title: 'Profile shows an error', description: 'Opened the profile, got a red banner.', severity: 'high' });
    assert.equal(filed.status, 201, filed.text);
    const f = filed.json;
    assert.equal(f.nightId, nightId);
    assert.equal(f.severity, 'high');
    assert.equal(f.by, 'qa-agent');
    assert.equal(f.device, 'iPhone 17, iOS 26.5');
    assert.equal(f.video?.startedWithFinding, false);
    assert.equal(f.video?.fromMs, 0);
    assert.match(f.video?.video ?? '', /\/v1\/recordings\/[^/]+\/video\.mp4#t=0,/);
    assert.deepEqual(f.steps.map((s) => s.what), ['Tap (50%, 50%)']);
    assert.ok(f.log.length >= 2);
    assert.ok(ops.filter((o) => o === 'appLog').length > before, 'the finding reads the newest log lines');
    assert.equal(f.network[0]?.status, 500);
    assert.deepEqual(f.notes, []);
    assert.equal(f.openAgainUrl, null);
    const shot = await fetch(new URL(f.screenshot ?? '').pathname.replace(/^/, broker.url), { headers: { authorization: `Bearer ${qaToken}` } });
    assert.equal(shot.status, 200);
    assert.equal(await shot.text(), 'fakepng');
    assert.equal((await other('GET', `/v1/findings/${f.id}`)).status, 404);
    assert.equal((await call('GET', `/v1/findings/${f.id}`)).json.title, 'Profile shows an error');
    assert.equal((await call('POST', `/v1/leases/${leaseId}/findings`, { description: 'no title' })).json.error?.code, 'BAD_TITLE');

    // Stopping keeps the app log and network requests with the recording, without duplicates.
    const stopped = await call('POST', `/v1/leases/${leaseId}/recording/stop`);
    const recId = String(stopped.json.id);
    const appLog = (await call<{ lines: { message: string }[]; dropped: boolean }>('GET', `/v1/recordings/${recId}/applog.json`)).json;
    const messages = appLog.lines.map((l) => l.message);
    assert.equal(new Set(messages).size, messages.length);
    assert.ok(messages.includes('line 1'));
    const network = (await call<{ requests: { id: string }[] }>('GET', `/v1/recordings/${recId}/network.json`)).json;
    assert.deepEqual(network.requests.map((r) => r.id), ['req-1']);

    // Through MCP on a lease with no recording: Hangar starts one and says so.
    await client.connect(new StreamableHTTPClientTransport(new URL(`${broker.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${qaToken}` } } }));
    const r = await client.callTool({ name: 'report_finding', arguments: { title: 'Second bug', description: 'Again.', leaseId } });
    assert.ok(!r.isError, JSON.stringify(r));
    const content = Array.isArray(r.content) ? r.content[0] : undefined;
    const answer = JSON.parse(content && 'text' in content && typeof content.text === 'string' ? content.text : '{}');
    assert.deepEqual(answer.notes, [STARTED_WITH_FINDING]);
    const second = (await call<Finding>('GET', `/v1/findings/${answer.id}`)).json;
    assert.equal(second.video?.startedWithFinding, true);
    assert.equal(second.severity, 'medium');

    await call('DELETE', `/v1/leases/${leaseId}`);
    assert.equal((await other('GET', `/v1/nights/${nightId}`)).status, 404);
    const closed = await call('POST', `/v1/nights/${nightId}/close`);
    assert.equal(closed.json.state, 'closed');
    assert.equal(closed.json.closedBy, 'qa-agent');
    // A lease after the close is not part of the night.
    await call('POST', '/v1/leases?wait=5', {});
    const details = (await call<{ leases: { id: string }[]; findings: Finding[] }>('GET', `/v1/nights/${nightId}`)).json;
    assert.deepEqual(details.leases.map((l) => l.id), [leaseId]);
    assert.equal(details.findings.length, 2);

    const report = (await call<NightReport>('GET', `/v1/nights/${nightId}/report`)).json;
    assert.equal(report.summary.findings, 2);
    assert.equal(report.findings[0]?.title, 'Profile shows an error');
    const md = await call('GET', `/v1/nights/${nightId}/report?format=md`);
    assert.match(md.text, /^# nightly: night report/);
    assert.match(md.text, /### \[high\] Profile shows an error/);
    assert.equal((await call('GET', `/v1/nights/${nightId}/report?format=pdf`)).json.error?.code, 'BAD_FORMAT');
    const listed = (await call<unknown[]>('GET', '/v1/nights?booking=nightly')).json;
    assert.ok(Array.isArray(listed) && listed.length === 1);
    assert.deepEqual((await other<unknown[]>('GET', '/v1/nights')).json, []);
  } finally {
    await client.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
