import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeEntry, parseVersions, parseXcodeVersion, readVersions, recordSmoke, smokeGate, smokeRequired, type SmokeEntry } from './versions.ts';

const entry = (over: Partial<SmokeEntry>): SmokeEntry => ({ xcode: '26.6', build: '17F113', runtime: '26.5', passed: true, date: '2026-11-10', steps: [], ...over });

test('parses xcodebuild -version', () => {
  assert.deepEqual(parseXcodeVersion('Xcode 26.6\nBuild version 17F113\n'), { version: '26.6', build: '17F113' });
  assert.equal(parseXcodeVersion('xcode-select: error: tool requires Xcode'), null);
});

test('the gate is open by default, whatever the file says', () => {
  const xcode = { version: '26.6', build: '17F113' };
  assert.equal(smokeGate([], xcode, false).ok, true);
  assert.equal(smokeGate([entry({ passed: false })], xcode, false).ok, true);
  assert.equal(smokeGate([], null, false).ok, true);
  assert.equal(smokeRequired({}), false);
  assert.equal(smokeRequired({ HANGAR_REQUIRE_SMOKE: '0' }), false);
  assert.equal(smokeRequired({ HANGAR_REQUIRE_SMOKE: '1' }), true);
});

test('when required, only a passing run on the same Xcode build opens the gate', () => {
  const xcode = { version: '26.6', build: '17F113' };
  assert.equal(smokeGate([], xcode, true).ok, false);
  assert.match(smokeGate([], xcode, true).detail, /no smoke test runs/);
  const failed = smokeGate([entry({ passed: false })], xcode, true);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /only failed/);
  assert.equal(smokeGate([entry({ build: '17F100' })], xcode, true).ok, false, 'another build of the same version does not count');
  assert.equal(smokeGate([entry({ xcode: '26.5', build: '17E50' })], xcode, true).ok, false);
  const ok = smokeGate([entry({ passed: false, runtime: '26.6' }), entry({})], xcode, true);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /Xcode 26\.6 \(17F113\) passed on 26\.5, 2026-11-10/);
  assert.equal(smokeGate([entry({})], null, true).ok, false, 'an unknown Xcode never passes');
});

test('a new run replaces the earlier one on the same build and runtime', () => {
  const merged = mergeEntry([entry({ passed: false }), entry({ runtime: '26.4' }), entry({ xcode: '26.10', build: '18A1' })], entry({ date: '2026-11-11' }));
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((e) => `${e.xcode}/${e.runtime}/${e.passed}`), ['26.6/26.4/true', '26.6/26.5/true', '26.10/26.5/true']);
});

test('reads and writes the versions file, and ignores entries it does not understand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-versions-'));
  try {
    const file = join(dir, 'hosts', 'versions.json');
    assert.deepEqual(await readVersions(file), []);
    await recordSmoke(entry({ passed: false }), file);
    await recordSmoke(entry({}), file);
    const entries = await readVersions(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.passed, true);
    assert.match(await readFile(file, 'utf8'), /^\{\n {2}"entries": \[/);
    assert.deepEqual(parseVersions('{"entries":[{"xcode":"26.6"},' + JSON.stringify(entry({})) + ']}').length, 1);
    assert.deepEqual(parseVersions('[]'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
