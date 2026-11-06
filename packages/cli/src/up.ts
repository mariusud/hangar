// `hangar up`: broker and agent in one process on this Mac.

import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Agent, defaultMaxDevices } from '@hangar/agent';
import { startBroker } from '@hangar/broker';
import type { AgentMessage, BrokerMessage } from '@hangar/protocol';

const run = promisify(execFile);

export const DEFAULT_PORT = 7420;

export function dataDir(): string {
  return process.env.HANGAR_HOME ?? join(homedir(), '.hangar');
}

type Check = { name: string; ok: boolean; detail: string; fix?: string };

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const has = async (cmd: string, args: string[]): Promise<string | null> => {
    try {
      return (await run(cmd, args)).stdout.trim();
    } catch {
      return null;
    }
  };
  const xcode = await has('xcodebuild', ['-version']);
  checks.push(
    xcode
      ? { name: 'Xcode', ok: true, detail: xcode.split('\n')[0] ?? '' }
      : { name: 'Xcode', ok: false, detail: 'not found', fix: 'Install Xcode from the App Store, open it once, then run `sudo xcode-select -s /Applications/Xcode.app`.' },
  );
  const runtimes = await has('xcrun', ['simctl', 'list', 'runtimes', '-j']);
  const ios = runtimes
    ? (JSON.parse(runtimes) as { runtimes: { name: string; isAvailable: boolean }[] }).runtimes.filter((r) => r.isAvailable && r.name.startsWith('iOS'))
    : [];
  checks.push(
    ios.length
      ? { name: 'iOS runtimes', ok: true, detail: ios.map((r) => r.name).join(', ') }
      : { name: 'iOS runtimes', ok: false, detail: 'none installed', fix: 'In Xcode, open Settings > Components and install an iOS simulator runtime.' },
  );
  const companion = await has('idb_companion', ['--version']);
  checks.push(
    companion
      ? { name: 'idb companion', ok: true, detail: 'installed' }
      : { name: 'idb companion', ok: false, detail: 'not found', fix: 'brew tap facebook/fb && brew install idb-companion' },
  );
  const client = await has('idb', ['--help']);
  checks.push(
    client
      ? { name: 'idb client', ok: true, detail: 'installed' }
      : { name: 'idb client', ok: false, detail: 'not found', fix: 'pipx install fb-idb   (or: pip3 install --user fb-idb)' },
  );
  const max = defaultMaxDevices();
  checks.push({ name: 'Capacity', ok: true, detail: `up to ${max} simulator${max === 1 ? '' : 's'} at once on this Mac` });
  return checks;
}

export function printChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok ' : 'NO '} ${c.name.padEnd(14)} ${c.detail}`);
    if (!c.ok && c.fix) {
      console.log(`      fix: ${c.fix}`);
    }
  }
}

async function lanName(): Promise<string> {
  try {
    return `${(await run('scutil', ['--get', 'LocalHostName'])).stdout.trim()}.local`;
  } catch {
    return 'localhost';
  }
}

export async function up(opts: { port?: number; warm?: number; max?: number; url?: string }): Promise<void> {
  console.log('Checking this Mac...');
  const checks = await doctor();
  printChecks(checks);
  if (checks.some((c) => !c.ok)) {
    console.log('\nFix the items marked NO, then run `npx hangar up` again.');
    process.exitCode = 1;
    return;
  }

  const port = opts.port ?? DEFAULT_PORT;
  // --url when people reach this Mac by another name, such as a Tailscale HTTPS address.
  const publicUrl = opts.url?.replace(/\/$/, '') ?? `http://${await lanName()}:${port}`;
  const broker = await startBroker({ dataDir: dataDir(), port, publicUrl }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\nPort ${port} is in use. Is Hangar already running? Try \`hangar status\`, or pass --port.`);
      process.exit(1);
    }
    throw err;
  });

  // Broker and agent talk through the same messages they would send over a WebSocket.
  let toAgent: (m: BrokerMessage) => void = () => {};
  const handlers = broker.attach({ send: (m) => setImmediate(() => toAgent(m)), close: () => {} });
  const agent = new Agent({
    send: (m: AgentMessage) => setImmediate(() => handlers.message(m)),
    log: (line) => console.log(`  ${line}`),
    ...(opts.warm !== undefined ? { warm: opts.warm } : {}),
    ...(opts.max !== undefined ? { maxDevices: opts.max } : {}),
  });
  toAgent = (m) => agent.receive(m);

  console.log(`\nStarting devices (up to ${agent.maxDevices}, ${agent.warm} kept ready)...`);
  await agent.start();

  const bonjour = spawn('dns-sd', ['-R', 'Hangar', '_hangar._tcp', 'local', String(port)], { stdio: 'ignore' });

  console.log(`
Hangar is running at ${publicUrl}

  Sign in as admin:   ${broker.welcomeLink()}   (one use, 30 min)
  Connect an agent:   make a token in the console, which shows the exact command
  Lease from code:    HANGAR_URL=${publicUrl} npx hangar lease

${publicUrl.startsWith('https:') ? '' : '  Traffic is plain HTTP on your network. Set up TLS before using Hangar beyond a trusted LAN.\n'}
  Press Ctrl-C to stop. Leased devices are deleted when Hangar stops.
`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log('\nStopping: deleting devices...');
    bonjour.kill();
    await agent.stop();
    await broker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
