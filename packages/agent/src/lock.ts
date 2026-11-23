import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export class LockHeldError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`Another Devicepool on this Mac (process ${pid}) already uses these simulators, and starting a second one would delete the first one's devices. Stop process ${pid} first (if it is the service, run \`devicepool up --uninstall\`). \`devicepool join\` is not needed on a Mac that runs \`devicepool up\`: it already offers this Mac's simulators.`);
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

export type LockOptions = { pid?: number; isAlive?: (pid: number) => boolean };

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

function holder(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireLock(file: string, opts: LockOptions = {}): { release: () => void } {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isProcessAlive;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return {
        release: () => {
          if (holder(file) === pid) {
            try {
              unlinkSync(file);
            } catch {}
          }
        },
      };
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') {
        throw err;
      }
    }
    const other = holder(file);
    if (other === pid) {
      return { release: () => {} };
    }
    if (other !== null && isAlive(other)) {
      throw new LockHeldError(other);
    }
    if (holder(file) === other) {
      try {
        unlinkSync(file);
      } catch {}
    }
  }
  throw new Error(`Could not take the lock ${file}. Delete it if no Devicepool is running.`);
}

export function releaseOnExit(lock: { release: () => void }): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (process.listenerCount(signal) <= 1) {
      lock.release();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  const onInt = (): void => onSignal('SIGINT');
  const onTerm = (): void => onSignal('SIGTERM');
  process.on('exit', lock.release);
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    lock.release();
    process.off('exit', lock.release);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}
