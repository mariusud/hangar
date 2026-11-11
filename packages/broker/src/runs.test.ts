import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignShards, caseSeconds, combineStatus, failedCases, failureGroups, normalizeMessage, rerunResult, settledState, testHistory, type FlowResult, type Run } from './runs.ts';

test('failed flows are read from Maestro JUnit, passing ones are not', () => {
  const junit = `<?xml version="1.0"?>
<testsuites><testsuite name="Test Suite" tests="3" failures="1">
  <testcase id="counter" name="counter" classname="counter" time="5.2" status="SUCCESS"/>
  <testcase id="broken" name="broken" classname="broken" time="20.1" status="ERROR"><failure>Assertion is false</failure></testcase>
  <testcase id="twice" name="twice" classname="twice" time="6.0" status="SUCCESS"></testcase>
</testsuite></testsuites>`;
  assert.deepEqual([...failedCases(junit)], ['broken']);
  assert.deepEqual([...caseSeconds(junit)], [['counter', 5.2], ['broken', 20.1], ['twice', 6]]);
  assert.equal(failedCases('').size, 0);
});

test('shards are balanced by past seconds, longest first, and unknown tests count as the average', () => {
  const past = new Map([['slow.yaml', 60], ['a.yaml', 10], ['b.yaml', 10], ['c.yaml', 10], ['d.yaml', 30]]);
  const shards = assignShards(['slow.yaml', 'a.yaml', 'b.yaml', 'c.yaml', 'd.yaml'], 2, past);
  const load = [0, 0];
  shards.forEach((s, i) => (load[s] = (load[s] ?? 0) + [60, 10, 10, 10, 30][i]!));
  assert.deepEqual(load, [60, 60]);
  assert.deepEqual(assignShards(['x', 'y', 'z', 'w'], 2, new Map()), [0, 1, 0, 1]);
  assert.equal(assignShards(['new', 'slow.yaml', 'a.yaml'], 2, past).filter((s) => s === 1).length, 2);
});

test('test history counts passes, flaky passes and failures per test, worst first', () => {
  const run = (flows: Run['flows'], at: number): Run => ({ id: String(at), accountId: 'a', state: 'failed', build: 'b', kind: 'maestro', shards: 1, retries: 1, class: {}, flows, leaseIds: [], error: null, createdAt: at, endedAt: at });
  const f = (flow: string, status: 'passed' | 'failed' | 'flaky'): Run['flows'][number] => ({ flow, status, shard: 0, attempts: 1 });
  const rows = testHistory([run([f('login.yaml', 'flaky'), f('home.yaml', 'passed')], 2), run([f('login.yaml', 'failed'), f('home.yaml', 'passed')], 1)]);
  assert.deepEqual(rows.map((r) => [r.test, r.runs, r.passed, r.flaky, r.failed, r.lastStatus]), [['login.yaml', 2, 0, 1, 1, 'flaky'], ['home.yaml', 2, 2, 0, 0, 'passed']]);
});

test('test history gives each test its flake and failure rate', () => {
  const run = (flows: Run['flows'], at: number): Run => ({ id: String(at), accountId: 'a', state: 'failed', build: 'b', kind: 'maestro', shards: 1, retries: 1, class: {}, flows, leaseIds: [], error: null, createdAt: at, endedAt: at });
  const f = (flow: string, status: 'passed' | 'failed' | 'flaky'): FlowResult => ({ flow, status, shard: 0, attempts: 1 });
  const rows = testHistory([run([f('a.yaml', 'flaky')], 3), run([f('a.yaml', 'passed')], 2), run([f('a.yaml', 'failed')], 1)]);
  assert.deepEqual(rows.map((r) => [r.flakeRate, r.failRate]), [[0.333, 0.333]]);
});

test('a rerun counts every attempt: one pass and one failure is flaky', () => {
  assert.equal(combineStatus('failed', true), 'flaky');
  assert.equal(combineStatus('failed', false), 'failed');
  assert.equal(combineStatus('passed', true), 'passed');
  assert.equal(combineStatus('passed', false), 'flaky');
  assert.equal(combineStatus('flaky', false), 'flaky');
  assert.equal(combineStatus('queued', false), 'failed');
  const failed: FlowResult = { flow: 'a.yaml', status: 'failed', shard: 0, attempts: 2, message: 'boom', firstMessage: 'boom', firstRecording: 'r1', recording: 'r2' };
  assert.deepEqual(rerunResult(failed, { passed: true, recording: 'r3' }), { flow: 'a.yaml', status: 'flaky', shard: 0, attempts: 3, firstMessage: 'boom', firstRecording: 'r1', recording: 'r3' });
  const passed: FlowResult = { flow: 'a.yaml', status: 'passed', shard: 0, attempts: 1 };
  assert.deepEqual(rerunResult(passed, { passed: false, message: 'late' }), { ...passed, status: 'flaky', attempts: 2, message: 'late', firstMessage: 'late' });
});

test('a run settles as failed while any flow failed, and a cancelled run with flows left stays cancelled', () => {
  const f = (status: FlowResult['status']): FlowResult => ({ flow: status, status, shard: 0, attempts: 1 });
  assert.equal(settledState([f('passed'), f('flaky')], 'failed'), 'passed');
  assert.equal(settledState([f('passed'), f('failed')], 'passed'), 'failed');
  assert.equal(settledState([f('passed'), f('queued')], 'cancelled'), 'cancelled');
});

test('failures are grouped by message with numbers and ids taken out, most common first', () => {
  assert.equal(normalizeMessage('Element 0xdeadbeef not found after 1500 ms (run 6f1c2e8a-1b2c-4d5e-8f90-123456789abc)'), 'Element <hex> not found after <n> ms (run <id>)');
  assert.equal(normalizeMessage('\u001b[31mTimed out\u001b[0m   after  2.5 s'), 'Timed out after <n> s');
  const run = (id: string, at: number, flows: FlowResult[], state: Run['state'] = 'failed'): Run => ({ id, accountId: 'a', state, build: 'b', kind: 'maestro', shards: 1, retries: 1, class: {}, flows, leaseIds: [], error: null, createdAt: at, endedAt: at });
  const groups = failureGroups([
    run('r3', 3, [{ flow: 'login.yaml', status: 'failed', shard: 0, attempts: 2, message: 'Timed out after 30 s', recording: 'rec-3' }]),
    run('r2', 2, [
      { flow: 'home.yaml', status: 'flaky', shard: 0, attempts: 2, firstMessage: 'Timed out after 12 s', firstRecording: 'rec-2' },
      { flow: 'pay.yaml', status: 'failed', shard: 0, attempts: 2, message: 'Card declined' },
      { flow: 'ok.yaml', status: 'passed', shard: 0, attempts: 1 },
    ]),
    run('r1', 1, [{ flow: 'login.yaml', status: 'failed', shard: 0, attempts: 1, message: 'Timed out after 9 s' }]),
    run('r0', 4, [{ flow: 'login.yaml', status: 'failed', shard: 0, attempts: 1, message: 'Timed out after 1 s' }], 'running'),
  ]);
  assert.deepEqual(groups, [
    { message: 'Timed out after <n> s', example: 'Timed out after 30 s', count: 3, tests: ['home.yaml', 'login.yaml'], lastRunId: 'r3', lastAt: 3, recording: 'rec-3' },
    { message: 'Card declined', example: 'Card declined', count: 1, tests: ['pay.yaml'], lastRunId: 'r2', lastAt: 2 },
  ]);
});
