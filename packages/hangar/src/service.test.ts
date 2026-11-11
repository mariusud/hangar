import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonPath, servicePlist, serviceUpArgs, validUserName } from './service.ts';

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

test('the LaunchDaemon plist runs as the chosen user, from boot, and lints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-plist-'));
  try {
    const file = join(dir, 'dev.hangar.up.plist');
    const env = { PATH: daemonPath('/Users/hangar', '/opt/node/bin'), HOME: '/Users/hangar', HANGAR_HOME: '/Users/hangar/.hangar' };
    writeFileSync(file, servicePlist(['/opt/node/bin/node', 'main.ts', 'up', '--port', '7420'], env, '/Users/hangar/.hangar/hangar.log', 'hangar'));
    execFileSync('plutil', ['-lint', file]);
    const read = (key: string): string => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file]).toString().trim();
    assert.equal(read('UserName'), 'hangar');
    assert.equal(read('GroupName'), 'staff');
    assert.equal(read('SessionCreate'), 'true');
    assert.equal(read('RunAtLoad'), 'true');
    assert.equal(read('KeepAlive'), 'true');
    assert.equal(read('EnvironmentVariables.HOME'), '/Users/hangar');
    assert.equal(read('EnvironmentVariables.HANGAR_HOME'), '/Users/hangar/.hangar');
    assert.equal(read('EnvironmentVariables.PATH').split(':')[0], '/opt/node/bin');
    assert.ok(read('EnvironmentVariables.PATH').includes('/Users/hangar/.maestro/bin'));
    assert.equal(read('StandardOutPath'), '/Users/hangar/.hangar/hangar.log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the LaunchAgent plist has no UserName', () => {
  assert.doesNotMatch(servicePlist(['node'], {}, '/tmp/h.log'), /UserName|SessionCreate/);
});

test('the service flags are not passed on to hangar up', () => {
  assert.deepEqual(serviceUpArgs(['--install', '--system', '--user', 'hangar', '--port', '7421', '--warm', '2']), ['--port', '7421', '--warm', '2']);
  assert.deepEqual(serviceUpArgs(['--user=hangar', '--install', '--url', 'https://h.example']), ['--url', 'https://h.example']);
});

test('only plain user names, never root', () => {
  assert.equal(validUserName('hangar'), true);
  assert.equal(validUserName('ci.runner_2'), true);
  assert.equal(validUserName('root'), false);
  assert.equal(validUserName('a b'), false);
  assert.equal(validUserName('-x'), false);
  assert.equal(validUserName('<x>'), false);
});
