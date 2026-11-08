import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignShards, caseSeconds, failedCases, testHistory, type Run } from './runs.ts';

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
  // Round robin would put slow and c on shard 0 (70 s) next to 50 s on shard 1.
  const shards = assignShards(['slow.yaml', 'a.yaml', 'b.yaml', 'c.yaml', 'd.yaml'], 2, past);
  const load = [0, 0];
  shards.forEach((s, i) => (load[s] = (load[s] ?? 0) + [60, 10, 10, 10, 30][i]!));
  assert.deepEqual(load, [60, 60]);
  // No history at all: every item costs the same, and they spread evenly.
  assert.deepEqual(assignShards(['x', 'y', 'z', 'w'], 2, new Map()), [0, 1, 0, 1]);
  // A new test is placed as an average one.
  assert.equal(assignShards(['new', 'slow.yaml', 'a.yaml'], 2, past).filter((s) => s === 1).length, 2);
});

test('test history counts passes, flaky passes and failures per test, worst first', () => {
  const run = (flows: Run['flows'], at: number): Run => ({ id: String(at), accountId: 'a', state: 'failed', build: 'b', kind: 'maestro', shards: 1, retries: 1, class: {}, flows, leaseIds: [], error: null, createdAt: at, endedAt: at });
  const f = (flow: string, status: 'passed' | 'failed' | 'flaky'): Run['flows'][number] => ({ flow, status, shard: 0, attempts: 1 });
  const rows = testHistory([run([f('login.yaml', 'flaky'), f('home.yaml', 'passed')], 2), run([f('login.yaml', 'failed'), f('home.yaml', 'passed')], 1)]);
  assert.deepEqual(rows.map((r) => [r.test, r.runs, r.passed, r.flaky, r.failed, r.lastStatus]), [['login.yaml', 2, 0, 1, 1, 'flaky'], ['home.yaml', 2, 2, 0, 0, 'passed']]);
});
