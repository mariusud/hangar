type Crash = { log: (line: string) => void; exit: (code: number) => void };

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

export function crashHandlers({ log, exit }: Crash): { unhandledRejection: (err: unknown) => void; uncaughtException: (err: unknown) => void } {
  return {
    unhandledRejection: (err) => {
      log(`An unhandled error was caught. The process is still running. This is a bug worth reporting, with this log: ${describe(err)}`);
    },
    uncaughtException: (err) => {
      log(`An uncaught exception stopped the process, so its state cannot be trusted. It exits now and the service restarts it. This is a bug worth reporting, with this log: ${describe(err)}`);
      exit(1);
    },
  };
}

export function installCrashHandlers(): void {
  const handlers = crashHandlers({ log: (line) => console.error(line), exit: (code) => process.exit(code) });
  process.on('unhandledRejection', handlers.unhandledRejection);
  process.on('uncaughtException', handlers.uncaughtException);
}
