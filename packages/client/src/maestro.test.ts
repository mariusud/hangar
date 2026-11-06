import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedCases } from './maestro.ts';

test('failed flows are read from Maestro JUnit, passing ones are not', () => {
  const junit = `<?xml version="1.0"?>
<testsuites><testsuite name="Test Suite" tests="3" failures="1">
  <testcase id="counter" name="counter" classname="counter" time="5.2" status="SUCCESS"/>
  <testcase id="broken" name="broken" classname="broken" time="20.1" status="ERROR"><failure>Assertion is false</failure></testcase>
  <testcase id="twice" name="twice" classname="twice" time="6.0" status="SUCCESS"></testcase>
</testsuite></testsuites>`;
  assert.deepEqual([...failedCases(junit)], ['broken']);
  assert.equal(failedCases('').size, 0);
});
