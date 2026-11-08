import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servicePlist } from './service.ts';

test('the LaunchAgent plist is valid and keeps arguments with special characters intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-plist-'));
  try {
    const file = join(dir, 'dev.hangar.up.plist');
    writeFileSync(file, servicePlist(['/usr/local/bin/node', 'main.ts', 'up', '--url', 'https://a.example?x=1&y=<2>'], { PATH: '/usr/bin:/bin' }, '/tmp/hangar.log'));
    execFileSync('plutil', ['-lint', file]);
    const args = JSON.parse(execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', file]).toString()) as string[];
    assert.equal(args.at(-1), 'https://a.example?x=1&y=<2>');
    assert.equal(execFileSync('plutil', ['-extract', 'KeepAlive', 'raw', '-o', '-', file]).toString().trim(), 'true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
