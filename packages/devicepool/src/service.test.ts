import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonPath, servicePlist, serviceUpArgs, validUserName } from './service.ts';

test('the LaunchAgent plist is valid and keeps arguments with special characters intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devicepool-plist-'));
  try {
    const file = join(dir, 'dev.devicepool.up.plist');
    writeFileSync(file, servicePlist(['/usr/local/bin/node', 'main.ts', 'up', '--url', 'https://a.example?x=1&y=<2>'], { PATH: '/usr/bin:/bin' }, '/tmp/devicepool.log'));
    execFileSync('plutil', ['-lint', file]);
    const args: string[] = JSON.parse(execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', file]).toString());
    assert.equal(args.at(-1), 'https://a.example?x=1&y=<2>');
    assert.equal(execFileSync('plutil', ['-extract', 'KeepAlive', 'raw', '-o', '-', file]).toString().trim(), 'true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the LaunchDaemon plist runs as the chosen user, from boot, and lints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devicepool-plist-'));
  try {
    const file = join(dir, 'dev.devicepool.up.plist');
    const env = { PATH: daemonPath('/Users/devicepool', '/opt/node/bin'), HOME: '/Users/devicepool', DEVICEPOOL_HOME: '/Users/devicepool/.devicepool' };
    writeFileSync(file, servicePlist(['/opt/node/bin/node', 'main.ts', 'up', '--port', '7420'], env, '/Users/devicepool/.devicepool/devicepool.log', 'devicepool'));
    execFileSync('plutil', ['-lint', file]);
    const read = (key: string): string => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file]).toString().trim();
    assert.equal(read('UserName'), 'devicepool');
    assert.equal(read('GroupName'), 'staff');
    assert.equal(read('SessionCreate'), 'true');
    assert.equal(read('RunAtLoad'), 'true');
    assert.equal(read('KeepAlive'), 'true');
    assert.equal(read('EnvironmentVariables.HOME'), '/Users/devicepool');
    assert.equal(read('EnvironmentVariables.DEVICEPOOL_HOME'), '/Users/devicepool/.devicepool');
    assert.equal(read('EnvironmentVariables.PATH').split(':')[0], '/opt/node/bin');
    assert.ok(read('EnvironmentVariables.PATH').includes('/Users/devicepool/.maestro/bin'));
    assert.equal(read('StandardOutPath'), '/Users/devicepool/.devicepool/devicepool.log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the LaunchAgent plist has no UserName', () => {
  assert.doesNotMatch(servicePlist(['node'], {}, '/tmp/h.log'), /UserName|SessionCreate/);
});

test('the service flags are not passed on to devicepool up', () => {
  assert.deepEqual(serviceUpArgs(['--install', '--system', '--user', 'devicepool', '--port', '7421', '--warm', '2']), ['--port', '7421', '--warm', '2']);
  assert.deepEqual(serviceUpArgs(['--user=devicepool', '--install', '--url', 'https://h.example']), ['--url', 'https://h.example']);
});

test('only plain user names, never root', () => {
  assert.equal(validUserName('devicepool'), true);
  assert.equal(validUserName('ci.runner_2'), true);
  assert.equal(validUserName('root'), false);
  assert.equal(validUserName('a b'), false);
  assert.equal(validUserName('-x'), false);
  assert.equal(validUserName('<x>'), false);
});
