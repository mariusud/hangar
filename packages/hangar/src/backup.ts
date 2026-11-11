import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HangarError } from './client/index.ts';
import { Db } from '@hangar/broker';
import { dataDir } from './up.ts';

const run = promisify(execFile);

export async function exportData(file: string): Promise<void> {
  const dir = dataDir();
  if (!existsSync(join(dir, 'hangar.db'))) {
    throw new HangarError(0, 'NOTHING_TO_EXPORT', `There is no Hangar data in ${dir}.`);
  }
  const tmp = await mkdtemp(join(tmpdir(), 'hangar-export-'));
  try {
    const db = new Db(join(dir, 'hangar.db'));
    db.sql.prepare('vacuum into ?').run(join(tmp, 'hangar.db'));
    db.sql.close();
    const parts = ['builds', 'recordings', 'image-secrets.key', 'view-link.key'].filter((p) => existsSync(join(dir, p)));
    await run('tar', ['-cf', resolve(file), '-C', tmp, 'hangar.db', ...parts.flatMap((p) => ['-C', dir, p])]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`Exported ${dir} to ${file}. It holds every token: keep it as safe as the Mac itself.`);
}

export async function importData(file: string): Promise<void> {
  const dir = dataDir();
  if (existsSync(join(dir, 'hangar.db'))) {
    throw new HangarError(0, 'ALREADY_HAS_DATA', `${dir} already has a Hangar database.`, 'Import into an empty place: stop Hangar and move the folder away, or set HANGAR_HOME to a new folder.');
  }
  await mkdir(dir, { recursive: true });
  await run('tar', ['-xf', resolve(file), '-C', dir]);
  const db = new Db(join(dir, 'hangar.db'));
  db.sql.prepare("update builds set path = ? || '/' || sha256").run(join(dir, 'builds'));
  db.sql.close();
  console.log(`Imported ${file} into ${dir}. Start Hangar there, then point the Macs at it with \`hangar join\`.`);
}
