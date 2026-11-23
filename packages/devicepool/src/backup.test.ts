import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '@devicepool/broker';
import { DevicepoolError } from './client/index.ts';
import { exportData, importData } from './backup.ts';

test('the export tar is readable only by its owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devicepool-backup-'));
  process.env.DEVICEPOOL_HOME = home;
  new Db(join(home, 'devicepool.db')).sql.close();
  const file = join(home, 'out.tar');
  await exportData(file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('an export into a folder that does not exist says so', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devicepool-backup-'));
  process.env.DEVICEPOOL_HOME = home;
  new Db(join(home, 'devicepool.db')).sql.close();
  await assert.rejects(exportData(join(home, 'nope', 'x.tar')), (err) => err instanceof DevicepoolError && err.code === 'NO_SUCH_FOLDER' && err.message.includes(join(home, 'nope')));
});

test('an import of a file that does not exist says so', async () => {
  process.env.DEVICEPOOL_HOME = await mkdtemp(join(tmpdir(), 'devicepool-backup-'));
  await assert.rejects(importData('missing.tar'), (err) => err instanceof DevicepoolError && err.message.startsWith('No such file: missing.tar'));
});
