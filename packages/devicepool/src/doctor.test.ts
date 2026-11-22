import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companionFix, isOlder, parseFormula } from './doctor.ts';

const SHA = 'a'.repeat(64);
const FORMULA = `class IdbCompanion < Formula
  url "https://github.com/facebook/idb/releases/download/v1.1.8/idb-companion.universal.tar.gz"
  sha256 "${SHA}"
end`;

test('compares the Command Line Tools with Xcode on major and minor', () => {
  assert.equal(isOlder('26.2.0.0.1.1764812424', '26.6'), true);
  assert.equal(isOlder('26.6.0.0.1.1770000000', '26.6'), false);
  assert.equal(isOlder('26.6', '26.6.1'), false);
  assert.equal(isOlder('25.4', '26.0'), true);
  assert.equal(isOlder('27.0', '26.6'), false);
  assert.equal(isOlder('', '26.6'), true);
  assert.equal(isOlder('beta', '26.6'), false);
});

test('reads the prebuilt url and checksum from the formula, only from the facebook/idb releases', () => {
  assert.deepEqual(parseFormula(FORMULA), { url: 'https://github.com/facebook/idb/releases/download/v1.1.8/idb-companion.universal.tar.gz', sha256: SHA });
  assert.equal(parseFormula(FORMULA.replace('github.com/facebook/idb', 'example.com/idb')), null);
  assert.equal(parseFormula(FORMULA.replace(SHA, 'abc')), null);
});

test('no special fix when the Command Line Tools match Xcode, or one is missing', () => {
  assert.equal(companionFix('26.6.0.0.1', '26.6', null), null);
  assert.equal(companionFix(null, '26.6', null), null);
  assert.equal(companionFix('26.2', null, null), null);
});

test('the fix names both ways out, with exact commands and the checksum', () => {
  const fix = companionFix('26.2.0.0.1.1764812424', '26.6', parseFormula(FORMULA));
  assert.ok(fix);
  assert.match(fix, /Command Line Tools \(26\.2\.0\.0\.1\.1764812424\) are older than Xcode \(26\.6\)/);
  assert.match(fix, /softwareupdate --list/);
  assert.match(fix, /sudo softwareupdate --install/);
  assert.match(fix, /curl -fLO https:\/\/github\.com\/facebook\/idb\/releases\/download\/v1\.1\.8\/idb-companion\.universal\.tar\.gz/);
  assert.match(fix, new RegExp(`echo "${SHA}  idb-companion\\.universal\\.tar\\.gz" \\| shasum -a 256 -c`));
  assert.match(fix, /tar -xzf idb-companion\.universal\.tar\.gz/);
});

test('without a tapped formula, the fix says where to get the checksum', () => {
  const fix = companionFix('26.2', '26.6', null);
  assert.ok(fix);
  assert.match(fix, /brew cat facebook\/fb\/idb-companion/);
  assert.match(fix, /shasum -a 256 -c/);
  assert.doesNotMatch(fix, /curl/);
});
