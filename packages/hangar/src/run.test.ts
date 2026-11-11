import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MaestroRun } from './client/index.ts';
import { commentBody, commentKey } from './run.ts';

const result: MaestroRun = {
  id: '6f1c2e8a-1b2c-4d5e-8f90-123456789abc',
  kind: 'maestro',
  passed: false,
  durationMs: 84_200,
  url: 'https://hangar.test/runs/6f1c2e8a-1b2c-4d5e-8f90-123456789abc',
  junit: '',
  flows: [
    { flow: 'ok.yaml', status: 'passed', shard: 0, attempts: 1 },
    { flow: 'home.yaml', status: 'passed', shard: 1, attempts: 1 },
    { flow: 'login.yaml', status: 'flaky', shard: 0, attempts: 2, firstMessage: 'Timed out', firstRecording: 'https://hangar.test/recordings/r1', recording: 'https://hangar.test/recordings/r2' },
    { flow: 'pay|card.yaml', status: 'failed', shard: 1, attempts: 2, message: 'Assertion <b> is false\nat step 3', firstRecording: 'https://hangar.test/recordings/r3', recording: 'https://hangar.test/recordings/r4' },
  ],
};

test('the pull request comment lists failed and flaky flows with a recording link for each attempt', () => {
  const body = commentBody(result, 'abcd');
  const lines = body.split('\n');
  assert.equal(lines[0], '<!-- hangar-run key=abcd run=6f1c2e8a-1b2c-4d5e-8f90-123456789abc -->');
  assert.match(body, /### Maestro on Hangar: 1 failed/);
  assert.match(body, /2 passed, 1 flaky, 1 failed in 84\.2 s\. \[Open the run\]\(https:\/\/hangar\.test\/runs\//);
  const failedRow = lines.findIndex((l) => l.startsWith('| pay'));
  const flakyRow = lines.findIndex((l) => l.startsWith('| login.yaml'));
  assert.ok(failedRow > 0 && failedRow < flakyRow, 'failed flows come before flaky ones');
  assert.equal(lines[failedRow], '| pay\\|card.yaml | failed | 2 | [first attempt](https://hangar.test/recordings/r3), [last attempt](https://hangar.test/recordings/r4) | Assertion &lt;b&gt; is false at step 3 |');
  assert.equal(lines[flakyRow], '| login.yaml | flaky | 2 | [failed attempt](https://hangar.test/recordings/r1), [passing attempt](https://hangar.test/recordings/r2) | Timed out |');
  assert.match(body, /<summary>2 passed<\/summary>\n\nok\.yaml, home\.yaml/);
  assert.match(body, /hangar run maestro --rerun 6f1c2e8a-1b2c-4d5e-8f90-123456789abc --flow pay\|card\.yaml/);
});

test('a run with nothing failing gets a short comment without a rerun hint', () => {
  const body = commentBody({ ...result, passed: true, kind: 'xcuitest', flows: [{ flow: 'AppUITests/LoginTests', status: 'passed', shard: 0, attempts: 1 }] }, 'k');
  assert.match(body, /### XCUITest on Hangar: passed/);
  assert.doesNotMatch(body, /\| Flow \|/);
  assert.doesNotMatch(body, /--rerun/);
});

test('the comment key depends on the workflow, the job and the comment-key input only', () => {
  const key = commentKey({ GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'e2e', HANGAR_COMMENT_KEY: '' });
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(commentKey({ GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'e2e', GITHUB_RUN_ID: '9' }), key);
  assert.notEqual(commentKey({ GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'e2e', HANGAR_COMMENT_KEY: 'iphone' }), key);
});
