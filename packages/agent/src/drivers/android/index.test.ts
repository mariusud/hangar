import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessUnits, checkTestNames, inputText, parseInstrumentation, shellQuote, toNodes } from './index.ts';

test('uiautomator XML becomes nodes with labels, ids and normalized frames', () => {
  const xml = `<?xml version='1.0'?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="1" text="Sign in" resource-id="com.example:id/login" class="android.widget.Button" content-desc="" clickable="true" enabled="true" bounds="[100,200][500,300]" />
<node index="2" text="Tom &amp; Jerry" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" enabled="false" bounds="[0,400][1080,500]" />
</node></hierarchy>`;
  const { nodes, screen } = toNodes(xml, { width: 1080, height: 2400 });
  assert.equal(screen.width, 1080);
  assert.equal(nodes.length, 2);
  assert.deepEqual([nodes[0]!.label, nodes[0]!.identifier, nodes[0]!.role], ['Sign in', 'login', 'Button']);
  assert.deepEqual(nodes[0]!.frame, { x: 100, y: 200, width: 400, height: 100 });
  assert.equal(nodes[0]!.normalized.x.toFixed(4), (100 / 1080).toFixed(4));
  assert.deepEqual([nodes[1]!.label, nodes[1]!.enabled], ['Tom & Jerry', false]);
});

test('text for the device shell cannot break out of its argument', () => {
  assert.equal(inputText('a b;rm -rf $HOME'), String.raw`a%sb\;rm%s\-rf%s\$HOME`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.throws(() => inputText('blåbær'), /ASCII/);
});

test('an Annex B stream is cut into access units, keyframes marked', () => {
  const units: [number, boolean][] = [];
  const push = accessUnits((au, key) => units.push([au.length, key]));
  const sps = [0, 0, 0, 1, 0x67, 1, 2];
  const pps = [0, 0, 0, 1, 0x68, 3];
  const idr = [0, 0, 0, 1, 0x65, 9, 9, 9];
  const p = [0, 0, 0, 1, 0x41, 7, 7];
  const all = Buffer.from([...sps, ...pps, ...idr, ...p, ...p]);
  push(all.subarray(0, 10));
  push(all.subarray(10));
  assert.deepEqual(units, [[sps.length + pps.length + idr.length, true], [p.length, false]]);
});

test('am instrument -r output becomes test cases', () => {
  const out = `INSTRUMENTATION_STATUS: class=com.example.LoginTest
INSTRUMENTATION_STATUS: current=1
INSTRUMENTATION_STATUS: test=signIn
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_STATUS: class=com.example.LoginTest
INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: button not shown
	at com.example.LoginTest.signIn(LoginTest.kt:20)
INSTRUMENTATION_STATUS: test=signIn
INSTRUMENTATION_STATUS_CODE: -2
INSTRUMENTATION_STATUS: class=com.example.LoginTest
INSTRUMENTATION_STATUS: test=signOut
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_STATUS: class=com.example.LoginTest
INSTRUMENTATION_STATUS: test=signOut
INSTRUMENTATION_STATUS_CODE: 0
INSTRUMENTATION_RESULT: stream=
FAILURES!!!
Tests run: 2,  Failures: 1
INSTRUMENTATION_CODE: -1`;
  const { cases, ok } = parseInstrumentation(out, 'com.example.test');
  assert.equal(ok, false);
  assert.deepEqual(cases.map((c) => [c.className, c.name, c.status, c.message]), [
    ['com.example.LoginTest', 'signIn', 'failed', 'java.lang.AssertionError: button not shown'],
    ['com.example.LoginTest', 'signOut', 'passed', undefined],
  ]);
  assert.throws(() => checkTestNames(['-e debug true']));
  assert.doesNotThrow(() => checkTestNames(['com.example.LoginTest#signIn']));
});
