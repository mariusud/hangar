import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DevicepoolError } from './client/index.ts';
import { Db } from '@devicepool/broker';
import { dataDir } from './up.ts';

const run = promisify(execFile);

export async function exportData(file: string): Promise<void> {
  const dir = dataDir();
  if (!existsSync(join(dir, 'devicepool.db'))) {
    throw new DevicepoolError(0, 'NOTHING_TO_EXPORT', `There is no Devicepool data in ${dir}.`);
  }
  const folder = dirname(resolve(file));
  if (!existsSync(folder)) {
    throw new DevicepoolError(0, 'NO_SUCH_FOLDER', `The folder ${folder} does not exist.`, 'Make it, or give a path in a folder that exists.');
  }
  const tmp = await mkdtemp(join(tmpdir(), 'devicepool-export-'));
  try {
    const db = new Db(join(dir, 'devicepool.db'));
    db.sql.prepare('vacuum into ?').run(join(tmp, 'devicepool.db'));
    db.sql.close();
    const parts = ['builds', 'recordings', 'image-secrets.key', 'view-link.key'].filter((p) => existsSync(join(dir, p)));
    await writeFile(resolve(file), '', { mode: 0o600 });
    await chmod(resolve(file), 0o600);
    await run('tar', ['-cf', resolve(file), '-C', tmp, 'devicepool.db', ...parts.flatMap((p) => ['-C', dir, p])]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`Exported ${dir} to ${file}. It holds every token and the image secrets key, and only you can read it (mode 0600): keep it as safe as the Mac itself.`);
}

export async function importData(file: string): Promise<void> {
  const dir = dataDir();
  if (!existsSync(resolve(file))) {
    throw new DevicepoolError(0, 'NO_SUCH_FILE', `No such file: ${file}.`, 'Give the .tar that `devicepool export` made.');
  }
  if (existsSync(join(dir, 'devicepool.db'))) {
    throw new DevicepoolError(0, 'ALREADY_HAS_DATA', `${dir} already has a Devicepool database.`, 'Import into an empty place: stop Devicepool and move the folder away, or set DEVICEPOOL_HOME to a new folder.');
  }
  await mkdir(dir, { recursive: true });
  await run('tar', ['-xf', resolve(file), '-C', dir]);
  const db = new Db(join(dir, 'devicepool.db'));
  db.sql.prepare("update builds set path = ? || '/' || sha256").run(join(dir, 'builds'));
  db.sql.close();
  console.log(`Imported ${file} into ${dir}. Start Devicepool there, then point the Macs at it with \`devicepool join\`.`);
}
