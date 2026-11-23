#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DevicepoolError } from './client/index.ts';
import { clientCommand } from './client.ts';
import { intOption, unexpectedMessage, unknownCommand, usageError, usageProblem } from './args.ts';
import { BROKER_OPTIONS, JOIN_OPTIONS, UP_OPTIONS } from './options.ts';
import { HELP } from './usage.ts';
import { runAndroid, runEspressoCommand, runIos, runMaestroCommand, runXcuitestCommand } from './run.ts';
import { daemonPath, installService, serviceUpArgs, uninstallService } from './service.ts';
import { brokerAddress } from '@devicepool/agent';
import { installCrashHandlers } from './crash.ts';
import { exportData, importData } from './backup.ts';
import { brokerOnly, doctor, joinBroker, joinToken, printChecks, up } from './up.ts';

async function main(): Promise<void> {
  process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':').filter(Boolean), ...daemonPath(homedir(), dirname(process.execPath)).split(':')])].join(':');
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case '--version':
    case 'version': {
      const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown');
      return;
    }
    case 'up': {
      const { values } = parseArgs({ args: rest, options: UP_OPTIONS });
      const port = intOption('--port', values.port, 1, 65535);
      const warm = intOption('--warm', values.warm, 0);
      const max = intOption('--max', values.max, 1);
      if (values.uninstall) {
        await uninstallService({ system: values.system ?? false });
        return;
      }
      if (values.install) {
        await installService(serviceUpArgs(rest), { system: values.system ?? false, ...(values.user ? { user: values.user } : {}) });
        return;
      }
      installCrashHandlers();
      await up({
        ...(values.url ? { url: values.url } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(warm !== undefined ? { warm } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(values.android ? { android: values.android } : {}),
        ...(values.phones ? { phones: true } : {}),
      });
      return;
    }
    case 'broker': {
      const { values } = parseArgs({ args: rest, options: BROKER_OPTIONS });
      const port = intOption('--port', values.port, 1, 65535);
      installCrashHandlers();
      await brokerOnly({ ...(port !== undefined ? { port } : {}), ...(values.url ? { url: values.url } : {}), ...(values.host ? { host: values.host } : {}) });
      return;
    }
    case 'export':
    case 'import': {
      if (!rest[0]) {
        throw new DevicepoolError(0, 'USAGE', `Usage: devicepool ${command} <file.tar>`);
      }
      await (command === 'export' ? exportData(rest[0]) : importData(rest[0]));
      return;
    }
    case 'join-token':
      console.log(joinToken());
      return;
    case 'join': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: JOIN_OPTIONS });
      const warm = intOption('--warm', values.warm, 0);
      const max = intOption('--max', values.max, 1);
      const url = positionals[0];
      const token = values.token ?? process.env.DEVICEPOOL_HOST_TOKEN;
      if (!url || !token) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool join <broker-url> --token <token>. Get a token with `devicepool join-token` on the broker.');
      }
      try {
        brokerAddress(url);
      } catch (err) {
        throw usageError(err instanceof Error ? err.message : String(err));
      }
      installCrashHandlers();
      await joinBroker({ url, token, ...(warm !== undefined ? { warm } : {}), ...(max !== undefined ? { max } : {}), ...(values.android ? { android: values.android } : {}), ...(values.phones ? { phones: true } : {}) });
      return;
    }
    case 'run': {
      if (rest[0] === 'maestro') {
        await runMaestroCommand(rest.slice(1));
        return;
      }
      if (rest[0] === 'espresso') {
        await runEspressoCommand(rest.slice(1));
        return;
      }
      if (rest[0] === 'xcuitest') {
        await runXcuitestCommand(rest.slice(1));
        return;
      }
      if (rest[0] === 'android') {
        await runAndroid(rest.slice(1));
        return;
      }
      if (rest[0] !== 'ios') {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool run ios, devicepool run android, devicepool run maestro <flows-dir> --app <app>, devicepool run xcuitest <Build/Products>, or devicepool run espresso --app <apk> --test-apk <apk>.');
      }
      await runIos(rest.slice(1));
      return;
    }
    case 'night':
      await (await import('./night.ts')).nightCommand(rest);
      return;
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
        console.error(unknownCommand(command));
        process.exitCode = 2;
      }
  }
}

try {
  await main();
} catch (err) {
  const problem = usageProblem(err);
  if (problem) {
    console.error(problem);
    process.exitCode = 2;
  } else if (err instanceof DevicepoolError) {
    console.error(err.message);
    process.exitCode = err.code === 'USAGE' ? 2 : 1;
  } else if (process.env.DEVICEPOOL_DEBUG) {
    throw err;
  } else {
    console.error(unexpectedMessage(err));
    process.exitCode = 1;
  }
}
