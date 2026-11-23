import { CLIENT_HELP } from './client.ts';
import { helpSection } from './help.ts';
import { NIGHT_HELP } from './night.ts';
import { RUN_HELP } from './run.ts';

const SERVER_HELP = helpSection('Server', [
  {
    usage: ['devicepool up [--port 7420] [--warm 1] [--max N] [--url https://...]', '[--android <avd>] [--phones]'],
    about: ['run Devicepool on this Mac; --warm is how many devices', 'stay ready, --max how many run at once; --android adds', 'emulators from that Android virtual device;', '--phones adds the Android phones on USB'],
  },
  { usage: 'devicepool up --install [same options]', about: ['run it as a service that starts at login'] },
  { usage: 'sudo devicepool up --install --system --user <name> [same options]', about: ['start it at boot as that user, with nobody logged', 'in (a LaunchDaemon)'] },
  { usage: 'devicepool up --uninstall [--system]', about: ['remove the service'] },
  { usage: 'devicepool doctor', about: ['check this Mac'] },
  { usage: 'devicepool --version', about: ['print the version'] },
]);

const MORE_MACS_HELP = helpSection('More Macs', [
  { usage: 'devicepool broker [--port 7420] [--url https://...] [--host 0.0.0.0]', about: ['run only the broker, as in a container'] },
  { usage: 'devicepool join-token', about: ['print a token for another Mac, on the broker'] },
  {
    usage: ['devicepool join <broker-url> --token <token> [--warm 1] [--max N]', '[--android <avd>] [--phones]'],
    about: ['offer this Mac\'s simulators through that broker'],
  },
  { usage: 'devicepool export <file.tar>', about: ['copy accounts, tokens, history, builds, recordings'] },
  { usage: 'devicepool import <file.tar>', about: ['start a new broker from an export'] },
]);

export const HELP = `devicepool: the open source, self-hosted device farm

${SERVER_HELP}

${MORE_MACS_HELP}

${RUN_HELP}

${CLIENT_HELP}

${NIGHT_HELP}

Exit codes: 0 done, 1 failed, 2 the command line was wrong.`;
