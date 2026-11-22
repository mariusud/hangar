#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DevicepoolError } from './client/index.ts';
import { CLIENT_HELP, clientCommand } from './client.ts';
import { RUN_HELP, runAndroid, runEspressoCommand, runIos, runMaestroCommand, runXcuitestCommand } from './run.ts';
import { daemonPath, installService, serviceUpArgs, uninstallService } from './service.ts';
import { exportData, importData } from './backup.ts';
import { brokerOnly, doctor, joinBroker, joinToken, printChecks, up } from './up.ts';

const HELP = `devicepool: the open source, self-hosted device farm

Server
  devicepool up [--port 7420] [--warm 1] [--max N] [--url https://...] [--android <avd>] [--phones]
                                                 run Devicepool on this Mac; --android adds
                                                 emulators from that Android virtual device;
                                                 --phones adds the Android phones on USB
  devicepool up --install [same options]             run it as a service that starts at login
  sudo devicepool up --install --system --user <name> [same options]
                                                 start it at boot as that user, with
                                                 nobody logged in (a LaunchDaemon)
  devicepool up --uninstall [--system]               remove the service
  devicepool doctor                                  check this Mac
  devicepool --version                               print the version

More Macs
  devicepool broker [--port 7420] [--url https://...] [--host 0.0.0.0]
                                                 run only the broker, as in a container
  devicepool join-token                              print a token for another Mac, on the broker
  devicepool join <broker-url> --token <token> [--warm 1] [--max N] [--android <avd>] [--phones]
                                                 offer this Mac's simulators through that broker
  devicepool export <file.tar>                       copy accounts, tokens, history, builds, recordings
  devicepool import <file.tar>                       start a new broker from an export

React Native
${RUN_HELP}

${CLIENT_HELP}`;

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
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' }, url: { type: 'string' }, android: { type: 'string' }, phones: { type: 'boolean' }, install: { type: 'boolean' }, uninstall: { type: 'boolean' }, system: { type: 'boolean' }, user: { type: 'string' } },
      });
      if (values.uninstall) {
        await uninstallService({ system: values.system ?? false });
        return;
      }
      if (values.install) {
        await installService(serviceUpArgs(rest), { system: values.system ?? false, ...(values.user ? { user: values.user } : {}) });
        return;
      }
      await up({
        ...(values.url ? { url: values.url } : {}),
        ...(values.port ? { port: Number(values.port) } : {}),
        ...(values.warm ? { warm: Number(values.warm) } : {}),
        ...(values.max ? { max: Number(values.max) } : {}),
        ...(values.android ? { android: values.android } : {}),
        ...(values.phones ? { phones: true } : {}),
      });
      return;
    }
    case 'broker': {
      const { values } = parseArgs({ args: rest, options: { port: { type: 'string' }, url: { type: 'string' }, host: { type: 'string' } } });
      await brokerOnly({ ...(values.port ? { port: Number(values.port) } : {}), ...(values.url ? { url: values.url } : {}), ...(values.host ? { host: values.host } : {}) });
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
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { token: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' }, android: { type: 'string' }, phones: { type: 'boolean' } } });
      const url = positionals[0];
      const token = values.token ?? process.env.DEVICEPOOL_HOST_TOKEN;
      if (!url || !token) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool join <broker-url> --token <token>. Get a token with `devicepool join-token` on the broker.');
      }
      await joinBroker({ url, token, ...(values.warm ? { warm: Number(values.warm) } : {}), ...(values.max ? { max: Number(values.max) } : {}), ...(values.android ? { android: values.android } : {}), ...(values.phones ? { phones: true } : {}) });
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
        console.log(`Unknown command "${command}".\n\n${HELP}`);
        process.exitCode = 1;
      }
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof DevicepoolError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
