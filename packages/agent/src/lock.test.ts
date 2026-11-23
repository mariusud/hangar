import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockHeldError } from './lock.ts';

function withDir(fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'devicepool-lock-'));
  try {
    fn(join(dir, 'sims.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the first agent takes the lock and writes its pid', () => {
  withDir((file) => {
    const lock = acquireLock(file, { pid: 100, isAlive: () => false });
    assert.equal(readFileSync(file, 'utf8'), '100');
    lock.release();
    assert.equal(existsSync(file), false);
  });
});

test('a second agent is refused while the first is alive, and the message names its pid', () => {
  withDir((file) => {
    acquireLock(file, { pid: 100, isAlive: () => true });
    assert.throws(
      () => acquireLock(file, { pid: 200, isAlive: (pid) => pid === 100 }),
      (err: unknown) => err instanceof LockHeldError && err.pid === 100 && /process 100/.test(err.message) && /devicepool up --uninstall/.test(err.message),
    );
    assert.equal(readFileSync(file, 'utf8'), '100');
  });
});

test('a lock whose process is gone is replaced', () => {
  withDir((file) => {
    writeFileSync(file, '100');
    const lock = acquireLock(file, { pid: 200, isAlive: () => false });
    assert.equal(readFileSync(file, 'utf8'), '200');
    lock.release();
    assert.equal(existsSync(file), false);
  });
});

test('a lock file with garbage in it counts as stale', () => {
  withDir((file) => {
    writeFileSync(file, 'not a pid');
    acquireLock(file, { pid: 200, isAlive: () => true });
    assert.equal(readFileSync(file, 'utf8'), '200');
  });
});

test('releasing never removes a lock that another process took over', () => {
  withDir((file) => {
    const lock = acquireLock(file, { pid: 100, isAlive: () => false });
    writeFileSync(file, '300');
    lock.release();
    assert.equal(readFileSync(file, 'utf8'), '300');
  });
});

test('the same process can take its own lock again', () => {
  withDir((file) => {
    acquireLock(file, { pid: 100, isAlive: () => true });
    acquireLock(file, { pid: 100, isAlive: () => true }).release();
    assert.equal(readFileSync(file, 'utf8'), '100');
  });
});
