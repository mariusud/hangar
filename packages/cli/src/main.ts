#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { HangarError } from '@hangar/client';
import { CLIENT_HELP, clientCommand } from './client.ts';
import { doctor, printChecks, up } from './up.ts';

const HELP = `hangar: a device fleet on your own Macs

Server
  hangar up [--port 7420] [--warm 1] [--max N]   run Hangar on this Mac
  hangar doctor                                  check this Mac

${CLIENT_HELP}`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'up': {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' } },
      });
      await up({
        ...(values.port ? { port: Number(values.port) } : {}),
        ...(values.warm ? { warm: Number(values.warm) } : {}),
        ...(values.max ? { max: Number(values.max) } : {}),
      });
      return;
    }
    case 'doctor': {
      const checks = await doctor();
      printChecks(checks);
      process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      if (!(await clientCommand(command, rest))) {
        console.log(`Unknown command "${command}".\n\n${HELP}`);
        process.exitCode = 1;
      }
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof HangarError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
