import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkItems, parseXcodebuild } from './xcuitest.ts';

test('xcodebuild output becomes test cases with failure messages', () => {
  const out = `Test Suite 'LoginTests' started at 2026-11-07 11:00:00.000.
Test Case '-[AppUITests.LoginTests testSignIn]' started.
/Users/ci/App/AppUITests/LoginTests.swift:21: error: -[AppUITests.LoginTests testSignIn] : XCTAssertTrue failed - Sign in button missing
Test Case '-[AppUITests.LoginTests testSignIn]' failed (4.210 seconds).
Test Case '-[AppUITests.LoginTests testSignOut]' passed (2.002 seconds).
    Test case '-[AppUITests.HomeTests testFeed]' passed (1.500 seconds).`;
  assert.deepEqual(parseXcodebuild(out), [
    { target: 'AppUITests', className: 'LoginTests', name: 'testSignIn', status: 'failed', seconds: 4.21, message: 'XCTAssertTrue failed - Sign in button missing' },
    { target: 'AppUITests', className: 'LoginTests', name: 'testSignOut', status: 'passed', seconds: 2.002 },
    { target: 'AppUITests', className: 'HomeTests', name: 'testFeed', status: 'passed', seconds: 1.5 },
  ]);
});

test('test names cannot carry xcodebuild flags', () => {
  assert.doesNotThrow(() => checkItems(['AppUITests', 'AppUITests/LoginTests/testSignIn']));
  assert.throws(() => checkItems(['-resultBundlePath']));
  assert.throws(() => checkItems([]));
});
