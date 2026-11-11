#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { parseArgs } from 'node:util';
import { HangarError } from './client/index.ts';
import { CLIENT_HELP, clientCommand } from './client.ts';
import { RUN_HELP, runAndroid, runEspressoCommand, runIos, runMaestroCommand, runXcuitestCommand } from './run.ts';
import { installService, serviceUpArgs, uninstallService } from './service.ts';
import { exportData, importData } from './backup.ts';
import { brokerOnly, doctor, joinBroker, joinToken, printChecks, up } from './up.ts';

const HELP = `hangar: the open source device broker for React Native teams

Server
  hangar up [--port 7420] [--warm 1] [--max N] [--url https://...] [--android <avd>]
                                                 run Hangar on this Mac; --android adds
                                                 emulators from that Android virtual device
  hangar up --install [same options]             run it as a service that starts at login
  sudo hangar up --install --system --user <name> [same options]
                                                 start it at boot as that user, with
                                                 nobody logged in (a LaunchDaemon)
  hangar up --uninstall [--system]               remove the service
  hangar doctor                                  check this Mac

More Macs
  hangar broker [--port 7420] [--url https://...] [--host 0.0.0.0]
                                                 run only the broker, as in a container
  hangar join-token                              print a token for another Mac, on the broker
  hangar join <broker-url> --token <token> [--warm 1] [--max N] [--android <avd>]
                                                 offer this Mac's simulators through that broker
  hangar export <file.tar>                       copy accounts, tokens, history, builds, recordings
  hangar import <file.tar>                       start a new broker from an export

React Native
${RUN_HELP}

${CLIENT_HELP}`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'up': {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' }, url: { type: 'string' }, android: { type: 'string' }, install: { type: 'boolean' }, uninstall: { type: 'boolean' }, system: { type: 'boolean' }, user: { type: 'string' } },
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
        throw new HangarError(0, 'USAGE', `Usage: hangar ${command} <file.tar>`);
      }
      await (command === 'export' ? exportData(rest[0]) : importData(rest[0]));
      return;
    }
    case 'join-token':
      console.log(joinToken());
      return;
    case 'join': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { token: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' }, android: { type: 'string' } } });
      const url = positionals[0];
      const token = values.token ?? process.env.HANGAR_HOST_TOKEN;
      if (!url || !token) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar join <broker-url> --token <token>. Get a token with `hangar join-token` on the broker.');
      }
      await joinBroker({ url, token, ...(values.warm ? { warm: Number(values.warm) } : {}), ...(values.max ? { max: Number(values.max) } : {}), ...(values.android ? { android: values.android } : {}) });
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
        throw new HangarError(0, 'USAGE', 'Usage: hangar run ios, hangar run android, hangar run maestro <flows-dir> --app <app>, hangar run xcuitest <Build/Products>, or hangar run espresso --app <apk> --test-apk <apk>.');
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
  if (err instanceof HangarError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
